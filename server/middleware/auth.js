const db = require('../db');
const { hashToken } = require('../utils/token');

/**
 * Middleware to authenticate requests via `Authorization: Bearer <token>`
 */
module.exports = async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Empty token' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, number, name, avatar, is_banned, created_at, last_seen FROM users WHERE token_hash = ?',
      [hashToken(token)]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    }

    if (rows[0].is_banned) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'This account has been banned' });
    }

    req.user = rows[0];
    req.token = token;
    next();
  } catch (err) {
    console.error('[AuthMiddleware] Error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
