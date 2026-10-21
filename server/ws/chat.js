const { online } = require('./state');
const { send, sendTo } = require('./sender');
const db = require('../db');

const typingThrottles = new Map(); // key: from->to, value: timestamp

exports.handleChat = async (ws, m) => {
  const me = ws.number;

  if (m.type === 'chat.send') {
    const text = String(m.text || '').trim().slice(0, 150000);
    const to = String(m.to || '').trim();

    if (!text || !/^[1-9]\d{9}$/.test(to) || to === me) return;

    try {
      // Check block
      const [b] = await db.query(
        'SELECT 1 FROM blocks WHERE owner_number = ? AND blocked_number = ?',
        [to, me]
      );
      if (b.length) {
        return send(ws, { type: 'chat.error', clientMsgId: m.clientMsgId, code: 'BLOCKED' });
      }

      // Save in DB
      const [r] = await db.query(
        'INSERT INTO messages (from_number, to_number, body, status) VALUES (?, ?, ?, ?)',
        [me, to, text, 'sent']
      );
      const msgId = r.insertId;
      const now = Date.now();

      // Check if recipient online
      const delivered = sendTo(to, {
        type: 'chat.receive',
        id: msgId,
        from: me,
        text,
        ts: now
      });

      if (delivered) {
        await db.query("UPDATE messages SET status = 'delivered' WHERE id = ?", [msgId]);
      }

      send(ws, {
        type: 'chat.ack',
        clientMsgId: m.clientMsgId,
        id: msgId,
        status: delivered ? 'delivered' : 'sent',
        ts: now
      });
    } catch (err) {
      console.error('[Chat.send] error:', err);
    }
  }

  if (m.type === 'chat.delivered' && m.id) {
    try {
      await db.query("UPDATE messages SET status = 'delivered' WHERE id = ? AND to_number = ?", [m.id, me]);
      const [msg] = await db.query('SELECT from_number FROM messages WHERE id = ?', [m.id]);
      if (msg.length) {
        sendTo(msg[0].from_number, { type: 'chat.status', id: m.id, status: 'delivered' });
      }
    } catch (err) {
      console.error('[Chat.delivered] error:', err);
    }
  }

  if (m.type === 'chat.read') {
    const peer = String(m.with || '').trim();
    const upToId = parseInt(m.upToId, 10);
    if (!peer || !upToId) return;

    try {
      await db.query(
        "UPDATE messages SET status = 'read' WHERE to_number = ? AND from_number = ? AND id <= ?",
        [me, peer, upToId]
      );
      sendTo(peer, {
        type: 'chat.status',
        upToId,
        status: 'read',
        by: me
      });
    } catch (err) {
      console.error('[Chat.read] error:', err);
    }
  }

  if (m.type === 'chat.typing') {
    const to = String(m.to || '').trim();
    if (!to || to === me) return;

    const throttleKey = `${me}->${to}`;
    const lastTyped = typingThrottles.get(throttleKey) || 0;
    const now = Date.now();

    if (now - lastTyped > 2000) {
      typingThrottles.set(throttleKey, now);
      sendTo(to, { type: 'chat.typing', from: me });
    }
  }

  if (m.type === 'chat.history') {
    const peer = String(m.with || '').trim();
    const beforeId = m.beforeId ? parseInt(m.beforeId, 10) : null;
    const limit = Math.min(parseInt(m.limit || '30', 10), 50);

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
      send(ws, {
        type: 'chat.history.result',
        with: peer,
        messages: rows.reverse()
      });
    } catch (err) {
      console.error('[Chat.history] error:', err);
    }
  }
};
