const { online, inCall } = require('./state');
const { send } = require('./sender');

/**
 * Handles presence queries: returns online/offline/in-call status for a list of numbers
 */
exports.handlePresenceQuery = (ws, m) => {
  const numbers = Array.isArray(m.numbers) ? m.numbers : [];
  const list = numbers.slice(0, 50).map((num) => {
    let status = 'offline';
    if (inCall.has(num)) {
      status = 'in-call';
    } else if (online.has(num)) {
      status = 'online';
    }
    return { number: num, status };
  });

  send(ws, { type: 'presence.result', list });
};

/**
 * Broadcast presence change to specific numbers
 */
exports.broadcastPresence = (number, status, targetNumbers = []) => {
  targetNumbers.forEach((toNum) => {
    const ws = online.get(toNum);
    if (ws) {
      send(ws, { type: 'presence.update', number, status });
    }
  });
};
