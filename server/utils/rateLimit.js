const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for guest identity creation to prevent number-farming bots.
 */
exports.identityLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // max 30 identities per IP per hour
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many identity requests from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * General API limiter
 */
exports.apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false
});
