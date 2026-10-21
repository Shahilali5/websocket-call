const crypto = require('crypto');
const db = require('../db');
const { hashToken } = require('../utils/token');
const { online, inCall, calls } = require('./state');
const { send, sendTo } = require('./sender');
const { handleCall, cleanupUser } = require('./call');
const { handleChat } = require('./chat');
const { handlePresenceQuery } = require('./presence');

exports.state = { online, inCall, calls };
exports.send = send;
exports.sendTo = sendTo;

function getIceServers(userNumber) {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const turnHost = process.env.TURN_HOST;
  const turnSecret = process.env.TURN_SECRET;

  if (turnHost && turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expiry}:${userNumber}`;
    const credential = crypto
      .createHmac('sha1', turnSecret)
      .update(username)
      .digest('base64');

    iceServers.push(
      { urls: `turn:${turnHost}:3478`, username, credential },
      { urls: `turns:${turnHost}:5349`, username, credential }
    );
  }

  return iceServers;
}

exports.attachHub = (wss) => {
  wss.on('connection', (ws, req) => {
    ws.alive = true;
    ws.number = null;
    ws.msgCount = 0;
    ws.msgResetTimer = setInterval(() => { ws.msgCount = 0; }, 60000);

    const authTimer = setTimeout(() => {
      if (!ws.number) {
        ws.close(4001, 'Auth timeout');
      }
    }, 5000);

    ws.on('pong', () => {
      ws.alive = true;
    });

    ws.on('message', async (raw) => {
      // Message rate limit: 200 msgs/min max
      ws.msgCount++;
      if (ws.msgCount > 200) {
        send(ws, { type: 'error', code: 'RATE_LIMIT', message: 'Message rate limit exceeded' });
        return ws.close(4008, 'Rate limit exceeded');
      }

      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'Invalid JSON' });
      }

      // Handle Authentication
      if (m.type === 'auth') {
        const token = String(m.token || '').trim();
        if (!token) {
          return send(ws, { type: 'auth.error', code: 'INVALID_TOKEN' });
        }

        try {
          const [rows] = await db.query(
            'SELECT id, number, name, is_banned FROM users WHERE token_hash = ?',
            [hashToken(token)]
          );

          if (!rows.length || rows[0].is_banned) {
            return send(ws, { type: 'auth.error', code: 'INVALID_TOKEN' });
          }

          clearTimeout(authTimer);
          const user = rows[0];

          // Session replacement: close existing socket if user is already connected in another tab
          const existingWs = online.get(user.number);
          if (existingWs && existingWs !== ws) {
            send(existingWs, { type: 'session.replaced' });
            existingWs.close(4000, 'Replaced by another session');
          }

          ws.number = user.number;
          online.set(ws.number, ws);

          const iceServers = getIceServers(ws.number);
          send(ws, {
            type: 'auth.ok',
            number: ws.number,
            name: user.name,
            iceServers
          });

          // Deliver pending offline messages
          const [pendingMsgs] = await db.query(
            "SELECT id, from_number, body, created_at FROM messages WHERE to_number = ? AND status = 'sent' ORDER BY id ASC",
            [ws.number]
          );

          if (pendingMsgs.length > 0) {
            for (const msg of pendingMsgs) {
              send(ws, {
                type: 'chat.receive',
                id: msg.id,
                from: msg.from_number,
                text: msg.body,
                ts: new Date(msg.created_at).getTime()
              });
            }
            await db.query(
              "UPDATE messages SET status = 'delivered' WHERE to_number = ? AND status = 'sent'",
              [ws.number]
            );
          }

          // Update last seen
          db.query('UPDATE users SET last_seen = NOW() WHERE id = ?', [user.id]).catch(() => {});
        } catch (err) {
          console.error('[Hub] Auth error:', err);
          send(ws, { type: 'auth.error', code: 'SERVER_ERROR' });
        }
        return;
      }

      // Block unauthenticated requests
      if (!ws.number) {
        return send(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      // Heartbeat
      if (m.type === 'ping') {
        return send(ws, { type: 'pong' });
      }

      // Dispatch to domain handlers
      if (m.type.startsWith('call.') || m.type.startsWith('webrtc.')) {
        return handleCall(ws, m);
      }
      if (m.type.startsWith('chat.')) {
        return handleChat(ws, m);
      }
      if (m.type === 'presence.query') {
        return handlePresenceQuery(ws, m);
      }
    });

    ws.on('close', () => {
      clearInterval(ws.msgResetTimer);
      if (ws.number && online.get(ws.number) === ws) {
        online.delete(ws.number);
        cleanupUser(ws.number);
        db.query('UPDATE users SET last_seen = NOW() WHERE number = ?', [ws.number]).catch(() => {});
      }
    });

    ws.on('error', (err) => {
      console.error(`[WS Error] User: ${ws.number || 'unauthed'}:`, err.message);
    });
  });

  // Heartbeat ping interval
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.alive) {
        return ws.terminate();
      }
      ws.alive = false;
      ws.ping();
    });
  }, 25000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });
};
