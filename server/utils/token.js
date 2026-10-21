const crypto = require('crypto');

/**
 * Creates a cryptographically secure 64-char hex token.
 */
exports.newToken = () => crypto.randomBytes(32).toString('hex');

/**
 * SHA-256 hashes a token for secure database storage.
 */
exports.hashToken = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');
