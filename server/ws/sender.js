const { online } = require('./state');

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function sendTo(number, obj) {
  const ws = online.get(number);
  if (ws) {
    return send(ws, obj);
  }
  return false;
}

module.exports = {
  send,
  sendTo
};
