const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../db');
const { getVapidPublicKey } = require('../services/push');
const { calls, inCall } = require('../ws/state');
const { endCall } = require('../ws/call');
const { sendTo } = require('../ws/sender');

// GET /api/push/vapid-public-key
router.get('/push/vapid-public-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    return res.status(503).json({ error: 'PUSH_NOT_CONFIGURED' });
  }
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — Register push subscription
router.post('/push/subscribe', auth, async (req, res) => {
  const { endpoint, keys, device } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
  }

  const userNumber = req.user.number;
  const p256dh = String(keys.p256dh);
  const authSecret = String(keys.auth);
  const deviceName = device ? String(device).slice(0, 100) : null;

  try {
    // Insert or replace subscription for this user
    await db.query(
      `INSERT INTO push_subscriptions (user_number, endpoint, p256dh, auth, device)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth), device = VALUES(device)`,
      [userNumber, endpoint, p256dh, authSecret, deviceName]
    );

    res.json({ ok: true, registered: true });
  } catch (err) {
    // SQLite syntax fallback (INSERT OR REPLACE)
    try {
      await db.query(
        `INSERT OR REPLACE INTO push_subscriptions (user_number, endpoint, p256dh, auth, device)
         VALUES (?, ?, ?, ?, ?)`,
        [userNumber, endpoint, p256dh, authSecret, deviceName]
      );
      res.json({ ok: true, registered: true });
    } catch (e2) {
      console.error('[POST /push/subscribe] error:', e2);
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
});

// POST /api/call/decline — Decline from Service Worker notification action
router.post('/call/decline', async (req, res) => {
  const { callId } = req.body || {};
  if (!callId) {
    return res.status(400).json({ error: 'MISSING_CALL_ID' });
  }

  const c = calls.get(callId);
  if (!c) {
    return res.json({ ok: true, note: 'CALL_NOT_ACTIVE' });
  }

  // Notify caller that call was rejected
  sendTo(c.from, { type: 'call.rejected', callId });
  endCall(callId, 'rejected', 'rejected', true);

  res.json({ ok: true, declined: true });
});

module.exports = router;
