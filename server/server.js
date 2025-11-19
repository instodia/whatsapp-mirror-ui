const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'user1' }),
  puppeteer: { headless: true } // set to false to watch Chromium open for debugging
});

io.on('connection', (socket) => {
  console.log('Web client connected:', socket.id);
  socket.emit('status', { status: client.info?.pushname ? 'connected' : 'initializing' });
});

client.on('qr', async (qr) => {
  try {
    const dataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', { qr: dataUrl });
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

client.on('authenticated', () => console.log('Authenticated'));
client.on('auth_failure', (msg) => { console.error('Auth failure', msg); io.emit('status', { status: 'auth_failure' }); });
client.on('disconnected', (reason) => { console.log('Disconnected', reason); io.emit('status', { status: 'disconnected', reason }); });

client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
// Basic endpoint to send messages (for testing)
app.post('/api/send', async (req, res) => {
  try {
    const { to, body } = req.body; // to e.g. '919876543210@c.us'
    if (!to || !body) return res.status(400).json({ ok: false, error: 'to and body required' });
    const msg = await client.sendMessage(to, body);
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

