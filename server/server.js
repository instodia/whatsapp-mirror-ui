// server.js - Render-ready
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);

// Use FRONTEND_URL to restrict origins in production, fallback to '*' for testing
const FRONTEND = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
  cors: { origin: FRONTEND }
});

app.use(express.json());
app.use(cors({ origin: FRONTEND }));
app.use(express.static(path.join(__dirname, '../client')));

// Optional quick token auth for sensitive endpoints / page.
// Set ADMIN_TOKEN in Render environment and uncomment middleware below if you want protection.
/*
app.use((req, res, next) => {
  if (!process.env.ADMIN_TOKEN) return next();
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === process.env.ADMIN_TOKEN) return next();
  return res.status(401).send('Unauthorized');
});
*/

let lastQr = null;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'user1' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

io.on('connection', (socket) => {
  console.log('Web client connected:', socket.id);
  // send status to client
  socket.emit('status', { status: client.info?.pushname ? 'connected' : 'initializing' });
  // if QR already created, send it to newly connected client
  if (lastQr) {
    socket.emit('qr', { qr: lastQr });
    socket.emit('status', { status: 'qr' });
  }
});

// Emit QR and keep latest in memory
client.on('qr', async (qr) => {
  try {
    lastQr = await qrcode.toDataURL(qr);
    io.emit('qr', { qr: lastQr });
    io.emit('status', { status: 'qr' });
    console.log('QR generated & emitted.');
  } catch (err) {
    console.error('QR error:', err);
  }
});

client.on('ready', () => {
  console.log('WhatsApp client ready.');
  io.emit('status', { status: 'ready' });
});

// forward incoming messages to web clients
client.on('message', msg => {
  console.log('Incoming message from', msg.from, ':', msg.body);
  io.emit('message', { from: msg.from, body: msg.body, id: msg.id._serialized });
});

// Send API
app.post('/api/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ ok: false, error: 'to and body required' });
    const msg = await client.sendMessage(to, body);
    return res.json({ ok: true, id: msg.id._serialized });
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
