const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');
const { online, inCall } = require('../ws/state');

// GET /api/me — Current user profile
router.get('/me', auth, (req, res) => {
  res.json({
    number: req.user.number,
    name: req.user.name,
    avatar: req.user.avatar,
    created_at: req.user.created_at
  });
});

// PUT /api/me — Update profile
router.put('/me', auth, async (req, res) => {
  const { name, avatar } = req.body || {};
  const cleanName = name ? String(name).trim().slice(0, 50) : req.user.name;
  const cleanAvatar = avatar ? String(avatar).trim().slice(0, 255) : req.user.avatar;

  try {
    await db.query('UPDATE users SET name = ?, avatar = ? WHERE id = ?', [cleanName, cleanAvatar, req.user.id]);
    res.json({ ok: true, name: cleanName, avatar: cleanAvatar });
  } catch (err) {
    console.error('[PUT /me] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /api/ice — ICE / TURN servers configuration
router.get('/ice', auth, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const turnHost = process.env.TURN_HOST;
  const turnSecret = process.env.TURN_SECRET;

  if (turnHost && turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hr validity
    const username = `${expiry}:${req.user.number}`;
    const credential = crypto
      .createHmac('sha1', turnSecret)
      .update(username)
      .digest('base64');

    iceServers.push(
      { urls: `turn:${turnHost}:3478`, username, credential },
      { urls: `turns:${turnHost}:5349`, username, credential }
    );
  }

  res.json({ iceServers });
});

// GET /api/lookup/:number — Dialpad validation
router.get('/lookup/:number', auth, async (req, res) => {
  const target = String(req.params.number).trim();
  if (!/^[1-9]\d{9}$/.test(target)) {
    return res.status(400).json({ exists: false, error: 'INVALID_NUMBER_FORMAT' });
  }

  try {
    const [rows] = await db.query('SELECT number, name, is_banned FROM users WHERE number = ?', [target]);
    if (!rows.length || rows[0].is_banned) {
      return res.json({ exists: false });
    }

    let status = 'offline';
    if (inCall.has(target)) {
      status = 'in-call';
    } else if (online.has(target)) {
      status = 'online';
    }

    res.json({
      exists: true,
      name: rows[0].name,
      status
    });
  } catch (err) {
    console.error('[Lookup] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
