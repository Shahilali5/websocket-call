const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const { generateNumber } = require('../utils/number');
const { newToken, hashToken } = require('../utils/token');
const { identityLimiter } = require('../utils/rateLimit');
const auth = require('../middleware/auth');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derived = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derived);
}

// POST /api/identity — Create guest user
router.post('/identity', identityLimiter, async (req, res) => {
  for (let i = 0; i < 10; i++) {
    const number = generateNumber();
    const token = newToken();
    try {
      await db.query(
        'INSERT INTO users (number, token_hash, name) VALUES (?, ?, ?)',
        [number, hashToken(token), 'Guest']
      );
      return res.status(201).json({ number, token, name: 'Guest' });
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') {
        console.error('[Identity] DB error:', e);
        return res.status(500).json({ error: 'SERVER_ERROR' });
      }
    }
  }
  res.status(500).json({ error: 'NUMBER_GENERATION_FAILED' });
});

// POST /api/login — Recovery via number + password
router.post('/login', async (req, res) => {
  const { number, password } = req.body || {};
  if (!number || !password) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Number and password required' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, number, name, password_hash, is_banned FROM users WHERE number = ?',
      [String(number)]
    );

    if (!rows.length || !rows[0].password_hash) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid number or password' });
    }

    const user = rows[0];
    if (user.is_banned) {
      return res.status(403).json({ error: 'BANNED', message: 'This account has been banned' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid number or password' });
    }

    // Generate fresh token
    const token = newToken();
    await db.query('UPDATE users SET token_hash = ? WHERE id = ?', [hashToken(token), user.id]);

    return res.json({ number: user.number, token, name: user.name });
  } catch (err) {
    console.error('[Login] error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/register — Set password / name for existing authenticated user
router.post('/register', auth, async (req, res) => {
  const { name, password } = req.body || {};
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Password/PIN must be at least 4 characters' });
  }

  const pHash = hashPassword(password);
  const cleanName = (name || req.user.name || 'User').trim().slice(0, 50);

  try {
    await db.query('UPDATE users SET password_hash = ?, name = ? WHERE id = ?', [pHash, cleanName, req.user.id]);
    res.json({ ok: true, number: req.user.number, name: cleanName });
  } catch (err) {
    console.error('[Register] error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/change-number — Choose Custom 10-digit number or VIP number
router.post('/change-number', auth, async (req, res) => {
  const customNumber = String(req.body.number || '').replace(/\D/g, '').trim();
  const newName = req.body.name ? String(req.body.name).trim().slice(0, 50) : null;

  if (!/^[1-9]\d{9}$/.test(customNumber)) {
    return res.status(400).json({ error: 'INVALID_NUMBER', message: 'Custom number must be exactly 10 digits and cannot start with 0.' });
  }

  const oldNumber = req.user.number;
  if (customNumber === oldNumber) {
    return res.json({ ok: true, number: customNumber, message: 'Number is already active' });
  }

  try {
    // Check if custom number already exists
    const [existing] = await db.query('SELECT id FROM users WHERE number = ?', [customNumber]);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'NUMBER_TAKEN', message: `Number ${customNumber} is already registered by another user. Try another number.` });
    }

    // Update user record
    if (newName) {
      await db.query('UPDATE users SET number = ?, name = ? WHERE id = ?', [customNumber, newName, req.user.id]);
    } else {
      await db.query('UPDATE users SET number = ? WHERE id = ?', [customNumber, req.user.id]);
    }

    // Migrate messages, calls, contacts
    await db.query('UPDATE messages SET from_number = ? WHERE from_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE messages SET to_number = ? WHERE to_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE calls SET from_number = ? WHERE from_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE calls SET to_number = ? WHERE to_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE contacts SET owner_number = ? WHERE owner_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE contacts SET contact_number = ? WHERE contact_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE blocks SET owner_number = ? WHERE owner_number = ?', [customNumber, oldNumber]).catch(() => {});
    await db.query('UPDATE blocks SET blocked_number = ? WHERE blocked_number = ?', [customNumber, oldNumber]).catch(() => {});

    return res.json({
      ok: true,
      oldNumber,
      number: customNumber,
      name: newName || req.user.name,
      message: 'Custom virtual number successfully activated!'
    });
  } catch (err) {
    console.error('[ChangeNumber] error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'NUMBER_TAKEN', message: 'Number already taken.' });
    }
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not change number.' });
  }
});

module.exports = router;
