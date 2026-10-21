try {
  require('dotenv').config();
} catch (e) {
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
  } catch {}
}
const express = require('express');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { attachHub } = require('./ws/hub');

const app = express();
const PORT = process.env.PORT || 2083;

// Enable proxy trust for Nginx / Cloudflare reverse proxy
app.set('trust proxy', 1);

// Security Middleware
app.use(
  helmet({
    contentSecurityPolicy: false // Allows CDNs and inline scripts for SPA
  })
);
app.use(cors());
app.use(express.json({ limit: '500kb' }));

// Static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api', require('./routes/identity'));
app.use('/api', require('./routes/me'));
app.use('/api', require('./routes/history'));
app.use('/api', require('./routes/push'));

// SPA Fallback for client routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Create HTTPS or HTTP Server based on certificates
let server;
let protocol = 'http';

const certPath = process.env.SSL_CERT || path.join(__dirname, '../certs/cert.pem');
const keyPath = process.env.SSL_KEY || path.join(__dirname, '../certs/key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    server = https.createServer(sslOptions, app);
    protocol = 'https';
    console.log('[SSL] HTTPS enabled using SSL certificates in ./certs');
  } catch (err) {
    console.warn('[SSL] Could not load SSL certs, falling back to HTTP:', err.message);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 256 * 1024 // 256 KB limit for audio voice notes & encrypted packets
});

attachHub(wss);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 VCall Server running on ${protocol}://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket endpoint at ${protocol === 'https' ? 'wss' : 'ws'}://0.0.0.0:${PORT}/ws`);
  console.log(`===============================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => console.log('Process terminated'));
});
