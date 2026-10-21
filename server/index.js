try {
  require('dotenv').config();
} catch (e) {
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
  } catch {}
}
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { attachHub } = require('./ws/hub');

const app = express();
const PORT = process.env.PORT || 2083;

// Security Middleware
app.use(
  helmet({
    contentSecurityPolicy: false // Allows CDNs and inline scripts for SPA
  })
);
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api', require('./routes/identity'));
app.use('/api', require('./routes/me'));
app.use('/api', require('./routes/history'));

// SPA Fallback for client routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Create HTTP and WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 256 * 1024 // 256 KB limit for audio voice notes & encrypted packets
});

attachHub(wss);

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 VCall Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint at ws://localhost:${PORT}/ws`);
  console.log(`===============================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => console.log('Process terminated'));
});
