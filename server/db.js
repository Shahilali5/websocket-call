const path = require('path');
const fs = require('fs');

const dbClient = (process.env.DB_CLIENT || 'sqlite').toLowerCase();

let queryFn;

if (dbClient === 'mysql') {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'vcall',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'vcall',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  // Initialize MySQL schema
  async function initMySQL() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        number CHAR(10) NOT NULL UNIQUE,
        token_hash CHAR(64) NOT NULL,
        name VARCHAR(50) DEFAULT 'Guest',
        avatar VARCHAR(255) NULL,
        password_hash VARCHAR(255) NULL,
        is_banned TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NULL,
        INDEX (token_hash)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        from_number CHAR(10) NOT NULL,
        to_number CHAR(10) NOT NULL,
        body TEXT NOT NULL,
        status ENUM('sent','delivered','read') DEFAULT 'sent',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pair (from_number, to_number, id),
        INDEX idx_to_status (to_number, status)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id CHAR(36) PRIMARY KEY,
        from_number CHAR(10) NOT NULL,
        to_number CHAR(10) NOT NULL,
        is_video TINYINT(1) DEFAULT 0,
        status ENUM('completed','missed','rejected','cancelled','failed') NOT NULL,
        started_at TIMESTAMP NULL,
        answered_at TIMESTAMP NULL,
        ended_at TIMESTAMP NULL,
        duration_sec INT DEFAULT 0,
        INDEX (from_number), INDEX (to_number)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        owner_number CHAR(10) NOT NULL,
        contact_number CHAR(10) NOT NULL,
        nickname VARCHAR(50),
        PRIMARY KEY (owner_number, contact_number)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocks (
        owner_number CHAR(10) NOT NULL,
        blocked_number CHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_number, blocked_number)
      );
    `);
    console.log('[DB] MySQL schema initialized successfully.');
  }

  initMySQL().catch(err => {
    console.error('[DB] MySQL Initialization error:', err.message);
  });

  queryFn = async (sql, params = []) => pool.query(sql, params);

} else {
  // Built-in SQLite (Node 22+ has node:sqlite built-in!)
  let sqlite = null;
  const dbFile = process.env.DB_FILE || path.join(__dirname, '../vcall.sqlite');

  try {
    const { DatabaseSync } = require('node:sqlite');
    sqlite = new DatabaseSync(dbFile);
    console.log('[DB] Using Node.js native built-in node:sqlite.');
  } catch (err) {
    try {
      const Database = require('better-sqlite3');
      sqlite = new Database(dbFile);
      console.log('[DB] Using better-sqlite3.');
    } catch (e) {
      console.warn('[DB] SQLite driver not found. Falling back to JSON persistence.');
    }
  }

  if (sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        name TEXT DEFAULT 'Guest',
        avatar TEXT NULL,
        password_hash TEXT NULL,
        is_banned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_token ON users (token_hash);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_number TEXT NOT NULL,
        to_number TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT DEFAULT 'sent',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (from_number, to_number, id);
      CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages (to_number, status);

      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        from_number TEXT NOT NULL,
        to_number TEXT NOT NULL,
        is_video INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        started_at DATETIME NULL,
        answered_at DATETIME NULL,
        ended_at DATETIME NULL,
        duration_sec INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_calls_from ON calls (from_number);
      CREATE INDEX IF NOT EXISTS idx_calls_to ON calls (to_number);

      CREATE TABLE IF NOT EXISTS contacts (
        owner_number TEXT NOT NULL,
        contact_number TEXT NOT NULL,
        nickname TEXT,
        PRIMARY KEY (owner_number, contact_number)
      );

      CREATE TABLE IF NOT EXISTS blocks (
        owner_number TEXT NOT NULL,
        blocked_number TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_number, blocked_number)
      );
    `);
    console.log('[DB] SQLite initialized at:', dbFile);

    queryFn = async (sql, params = []) => {
      let normSql = sql
        .replace(/NOW\(\)/gi, "datetime('now')")
        .replace(/CURRENT_TIMESTAMP/gi, "datetime('now')");

      if (/FROM_UNIXTIME\(\?\)/i.test(normSql)) {
        normSql = normSql.replace(/FROM_UNIXTIME\(\?\)/gi, "datetime(?, 'unixepoch')");
      }

      const trimmed = normSql.trim();
      const isSelect = /^SELECT/i.test(trimmed);

      try {
        const stmt = sqlite.prepare(normSql);
        if (isSelect) {
          const rows = stmt.all(...params);
          return [rows, []];
        } else {
          const info = stmt.run(...params);
          return [{
            insertId: info.lastInsertRowid,
            affectedRows: info.changes
          }, []];
        }
      } catch (e) {
        if (e.message && (e.message.includes('UNIQUE constraint failed') || e.code === 'ERR_SQLITE_ERROR')) {
          e.code = 'ER_DUP_ENTRY';
        }
        throw e;
      }
    };
  } else {
    // In-memory / JSON persistence fallback for instant zero-dependency running
    const jsonStoreFile = path.join(__dirname, '../vcall-data.json');
    let store = { users: [], messages: [], calls: [], contacts: [], blocks: [] };
    if (fs.existsSync(jsonStoreFile)) {
      try { store = JSON.parse(fs.readFileSync(jsonStoreFile, 'utf8')); } catch {}
    }

    const saveStore = () => {
      try { fs.writeFileSync(jsonStoreFile, JSON.stringify(store, null, 2)); } catch {}
    };

    console.log('[DB] Running with lightweight JSON persistence engine.');

    queryFn = async (sql, params = []) => {
      const q = sql.trim();
      if (/INSERT INTO users/i.test(q)) {
        const [number, token_hash, name] = params;
        if (store.users.some(u => u.number === number)) {
          const err = new Error('Duplicate'); err.code = 'ER_DUP_ENTRY'; throw err;
        }
        const user = { id: store.users.length + 1, number, token_hash, name: name || 'Guest', is_banned: 0, created_at: new Date().toISOString(), last_seen: null };
        store.users.push(user);
        saveStore();
        return [{ insertId: user.id }, []];
      }
      if (/SELECT .* FROM users WHERE token_hash/i.test(q)) {
        const hash = params[0];
        const res = store.users.filter(u => u.token_hash === hash);
        return [res, []];
      }
      if (/SELECT .* FROM users WHERE number/i.test(q)) {
        const num = params[0];
        const res = store.users.filter(u => u.number === num);
        return [res, []];
      }
      if (/UPDATE users SET last_seen/i.test(q)) {
        return [{ affectedRows: 1 }, []];
      }
      if (/SELECT 1 FROM blocks/i.test(q)) {
        const [owner, blocked] = params;
        const exists = store.blocks.some(b => b.owner_number === owner && b.blocked_number === blocked);
        return [exists ? [{ '1': 1 }] : [], []];
      }
      if (/INSERT INTO messages/i.test(q)) {
        const [from, to, body, status] = params;
        const msg = { id: store.messages.length + 1, from_number: from, to_number: to, body, status: status || 'sent', created_at: new Date().toISOString() };
        store.messages.push(msg);
        saveStore();
        return [{ insertId: msg.id }, []];
      }
      if (/UPDATE messages SET status/i.test(q)) {
        saveStore();
        return [{ affectedRows: 1 }, []];
      }
      if (/SELECT .* FROM messages WHERE to_number.*status = 'sent'/i.test(q)) {
        const to = params[0];
        const res = store.messages.filter(m => m.to_number === to && m.status === 'sent');
        return [res, []];
      }
      if (/SELECT .* FROM messages WHERE/i.test(q)) {
        return [store.messages.slice(-50), []];
      }
      if (/INSERT INTO calls/i.test(q)) {
        const [id, from, to, is_video, status] = params;
        store.calls.push({ id, from_number: from, to_number: to, is_video, status, created_at: new Date().toISOString() });
        saveStore();
        return [{ insertId: id }, []];
      }
      if (/SELECT .* FROM calls/i.test(q)) {
        return [store.calls.slice(-50), []];
      }
      if (/SELECT .* FROM contacts/i.test(q)) {
        return [store.contacts, []];
      }
      return [[], []];
    };
  }
}

module.exports = {
  query: queryFn
};
