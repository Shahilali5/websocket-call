const handlers = {};
let socket = null;
let retryCount = 0;
let userToken = null;
let pingInterval = null;

export const on = (type, fn) => {
  (handlers[type] ||= []).push(fn);
};

export const off = (type, fn) => {
  if (!handlers[type]) return;
  handlers[type] = handlers[type].filter(handler => handler !== fn);
};

export const send = (obj) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
    return true;
  }
  return false;
};

export function connect(token) {
  userToken = token;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${location.host}/ws`;

  if (socket) {
    try { socket.close(); } catch {}
  }

  socket = new WebSocket(url);

  socket.onopen = () => {
    retryCount = 0;
    send({ type: 'auth', token: userToken });

    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      send({ type: 'ping' });
    }, 25000);
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (handlers[msg.type]) {
        handlers[msg.type].forEach(fn => fn(msg));
      }
      if (handlers['*']) {
        handlers['*'].forEach(fn => fn(msg));
      }
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };

  socket.onclose = (event) => {
    if (pingInterval) clearInterval(pingInterval);

    // If session was deliberately replaced or closed with 4000+, do not auto-reconnect immediately
    if (event.code === 4000) return;

    const waitMs = Math.min(1000 * Math.pow(2, retryCount++), 30000);
    setTimeout(() => {
      if (userToken) connect(userToken);
    }, waitMs);
  };

  socket.onerror = (err) => {
    console.warn('[WS] Socket error:', err);
  };
}
