const crypto = require('crypto');

/**
 * Generates a unique 10-digit virtual number with first digit between 1 and 9.
 * Example: '7384920155'
 */
exports.generateNumber = () => {
  const first = crypto.randomInt(1, 10);
  const rest = String(crypto.randomInt(0, 1e9)).padStart(9, '0');
  return String(first) + rest;
};
