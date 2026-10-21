const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/calls — Call history
router.get('/calls', auth, async (req, res) => {
  const myNumber = req.user.number;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);

  try {
    const [rows] = await db.query(
      `SELECT c.id, c.from_number, c.to_number, c.is_video, c.status,
              c.started_at, c.answered_at, c.ended_at, c.duration_sec,
              u.name as other_name
       FROM calls c
       LEFT JOIN users u ON u.number = (CASE WHEN c.from_number = ? THEN c.to_number ELSE c.from_number END)
       WHERE c.from_number = ? OR c.to_number = ?
       ORDER BY c.started_at DESC LIMIT ?`,
      [myNumber, myNumber, myNumber, limit]
    );

    res.json({ calls: rows });
  } catch (err) {
    console.error('[GET /calls] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /api/chats — Recent conversations list
router.get('/chats', auth, async (req, res) => {
  const me = req.user.number;

  try {
    // Get unique peer numbers interacted with
    const [messages] = await db.query(
      `SELECT m.id, m.from_number, m.to_number, m.body, m.status, m.created_at
       FROM messages m
       WHERE m.id IN (
         SELECT MAX(id)
         FROM messages
         WHERE from_number = ? OR to_number = ?
         GROUP BY (CASE WHEN from_number = ? THEN to_number ELSE from_number END)
       )
       ORDER BY m.id DESC`,
      [me, me, me]
    );

    // Format chat list
    const chats = await Promise.all(
      messages.map(async (msg) => {
        const peer = msg.from_number === me ? msg.to_number : msg.from_number;
        const [u] = await db.query('SELECT name FROM users WHERE number = ?', [peer]);
        const [cnt] = await db.query(
          `SELECT COUNT(*) as unread FROM messages WHERE from_number = ? AND to_number = ? AND status != 'read'`,
          [peer, me]
        );
        return {
          peer,
          name: u.length ? u[0].name : 'User',
          lastMessage: msg.body,
          lastMessageTime: msg.created_at,
          lastMessageFrom: msg.from_number,
          unread: cnt[0]?.unread || 0
        };
      })
    );

    res.json({ chats });
  } catch (err) {
    console.error('[GET /chats] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /api/messages/:number — Chat history with a peer
router.get('/messages/:number', auth, async (req, res) => {
  const me = req.user.number;
  const peer = String(req.params.number).trim();
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;

  try {
    let sql, params;
    if (beforeId) {
      sql = `SELECT id, from_number, to_number, body, status, created_at
             FROM messages
             WHERE ((from_number = ? AND to_number = ?) OR (from_number = ? AND to_number = ?))
               AND id < ?
             ORDER BY id DESC LIMIT ?`;
      params = [me, peer, peer, me, beforeId, limit];
    } else {
      sql = `SELECT id, from_number, to_number, body, status, created_at
             FROM messages
             WHERE ((from_number = ? AND to_number = ?) OR (from_number = ? AND to_number = ?))
             ORDER BY id DESC LIMIT ?`;
      params = [me, peer, peer, me, limit];
    }

    const [rows] = await db.query(sql, params);
    res.json({ messages: rows.reverse() });
  } catch (err) {
    console.error('[GET /messages] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /api/contacts — Saved contacts
router.get('/contacts', auth, async (req, res) => {
  const me = req.user.number;
  try {
    const [rows] = await db.query(
      `SELECT c.contact_number, c.nickname, u.name, u.avatar
       FROM contacts c
       LEFT JOIN users u ON u.number = c.contact_number
       WHERE c.owner_number = ?
       ORDER BY c.nickname ASC, c.contact_number ASC`,
      [me]
    );
    res.json({ contacts: rows });
  } catch (err) {
    console.error('[GET /contacts] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/contacts — Save or update contact
router.post('/contacts', auth, async (req, res) => {
  const me = req.user.number;
  const { number, nickname } = req.body || {};
  if (!number || !/^[1-9]\d{9}$/.test(number)) {
    return res.status(400).json({ error: 'INVALID_NUMBER' });
  }

  const cleanNick = (nickname || '').trim().slice(0, 50);

  try {
    await db.query(
      `INSERT INTO contacts (owner_number, contact_number, nickname)
       VALUES (?, ?, ?)
       ON CONFLICT(owner_number, contact_number) DO UPDATE SET nickname = excluded.nickname`,
      [me, number, cleanNick]
    );
    res.json({ ok: true, number, nickname: cleanNick });
  } catch (err) {
    // For MySQL fallback where ON DUPLICATE KEY UPDATE is used:
    try {
      await db.query(
        `INSERT INTO contacts (owner_number, contact_number, nickname)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)`,
        [me, number, cleanNick]
      );
      return res.json({ ok: true, number, nickname: cleanNick });
    } catch (e) {
      console.error('[POST /contacts] error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
});

// DELETE /api/contacts/:number — Remove contact
router.delete('/contacts/:number', auth, async (req, res) => {
  const me = req.user.number;
  const contactNumber = req.params.number;

  try {
    await db.query('DELETE FROM contacts WHERE owner_number = ? AND contact_number = ?', [me, contactNumber]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /contacts] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/block — Block number
router.post('/block', auth, async (req, res) => {
  const me = req.user.number;
  const { number } = req.body || {};
  if (!number || !/^[1-9]\d{9}$/.test(number)) {
    return res.status(400).json({ error: 'INVALID_NUMBER' });
  }

  try {
    await db.query('INSERT OR IGNORE INTO blocks (owner_number, blocked_number) VALUES (?, ?)', [me, number]);
    res.json({ ok: true, blocked: number });
  } catch (err) {
    try {
      await db.query('INSERT IGNORE INTO blocks (owner_number, blocked_number) VALUES (?, ?)', [me, number]);
      res.json({ ok: true, blocked: number });
    } catch (e) {
      console.error('[POST /block] error:', e);
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
});

// DELETE /api/block/:number — Unblock number
router.delete('/block/:number', auth, async (req, res) => {
  const me = req.user.number;
  const blockedNumber = req.params.number;

  try {
    await db.query('DELETE FROM blocks WHERE owner_number = ? AND blocked_number = ?', [me, blockedNumber]);
    res.json({ ok: true, unblocked: blockedNumber });
  } catch (err) {
    console.error('[DELETE /block] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
