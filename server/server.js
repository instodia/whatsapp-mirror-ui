// server.js (Render-ready) - extended with contacts/chats/profile/logout
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);

// configure allowed origin (restrict in prod)
const FRONTEND = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
  cors: { origin: FRONTEND }
});

app.use(express.json());
app.use(cors({ origin: FRONTEND }));
app.use(express.static(path.join(__dirname, '../client')));

let lastQr = null;
let readyAt = null;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'user1' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

// Re-emit cached QR when clients connect; send status
io.on('connection', (socket) => {
  console.log('Web client connected:', socket.id);
  socket.emit('status', { status: client.info?.pushname ? 'connected' : 'initializing' });

  if (lastQr) {
    socket.emit('qr', { qr: lastQr });
    socket.emit('status', { status: 'qr' });
  }

  // On request, send latest contacts & chats if ready
  socket.on('request-data', async () => {
    if (client.info) {
      try {
        const [contacts, chats] = await Promise.all([fetchContacts(), fetchChats()]);
        socket.emit('contacts', contacts);
        socket.emit('chats', chats);
      } catch (e) {
        console.error('request-data error', e);
      }
    }
  });
});

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

client.on('ready', async () => {
  console.log('WhatsApp client ready.');
  readyAt = new Date();
  io.emit('status', { status: 'ready' });

  // on ready, load contacts & chats once and emit to clients
  try {
    const contacts = await fetchContacts();
    const chats = await fetchChats();
    io.emit('contacts', contacts);
    io.emit('chats', chats);
  } catch (e) {
    console.error('Error fetching initial data', e);
  }
});

// forward incoming messages to web clients and update chats
client.on('message', async (msg) => {
  console.log('Incoming message from', msg.from, ':', msg.body);
  // emit message to clients
  io.emit('message', { from: msg.from, body: msg.body, id: msg.id._serialized });
  // also update chat list clients by reloading chats (light approach)
  try {
    const chats = await fetchChats();
    io.emit('chats', chats);
  } catch (e) { console.error('chats reload error', e); }
});

async function fetchContacts() {
  // returns array of { id, name, pushname, number, isBusiness, lastSeen (if available) }
  const contactsRaw = await client.getContacts();
  const out = [];
  for (const c of contactsRaw) {
    // c has id._serialized and name and pushname
    const id = c.id?._serialized || c.id;
    let lastSeen = null;
    try {
      // some contacts support presence
      const full = await client.getContactById(id);
      if (full && full.presence && full.presence.lastKnown) lastSeen = full.presence.lastKnown;
    } catch (e) {
      // ignore presence errors
    }
    out.push({
      id,
      name: c.name || c.pushname || id.replace(/@.+$/,''),
      pushname: c.pushname || null,
      number: id.replace(/@.+$/,''),
      isBusiness: c.isBusiness || false,
      lastSeen
    });
  }
  return out;
}

async function fetchChats() {
  // returns recent chats with last message preview and timestamp
  const chatsRaw = await client.getChats(); // returns Chat objects
  // sort by timestamp desc
  chatsRaw.sort((a,b) => (b.timestamp || 0) - (a.timestamp || 0));
  const out = [];
  for (const ch of chatsRaw) {
    // only text messages preview; skip ephemeral media-heavy fields
    const lastMsg = ch?.lastMessage;
    let body = '';
    let ts = ch?.timestamp || (lastMsg?.timestamp ? lastMsg.timestamp*1000 : Date.now());
    if (lastMsg) {
      if (lastMsg.body) body = lastMsg.body;
      else if (lastMsg.type === 'chat') body = lastMsg.body || '';
      else body = lastMsg.type || '';
    }
    out.push({
      id: ch.id._serialized || ch.id,
      name: ch.name || ch.formattedTitle || (ch.id && ch.id.user) || ch.id?._serialized || ch.id,
      isGroup: ch.isGroup || false,
      lastMessage: body,
      lastTimestamp: ts
    });
  }
  return out;
}

// API: send message
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

// API: get profile (basic)
app.get('/api/profile', async (req, res) => {
  try {
    const info = client.info || null;
    return res.json({ ok: true, info });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// API: explicit get contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await fetchContacts();
    return res.json({ ok: true, contacts });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// API: explicit get chats
app.get('/api/chats', async (req, res) => {
  try {
    const chats = await fetchChats();
    return res.json({ ok: true, chats });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// API: logout (unlink session)
app.post('/api/logout', async (req, res) => {
  try {
    await client.logout(); // this logs out and clears auth for client
    // Do NOT delete LocalAuth files here — logout will unlink
    lastQr = null;
    io.emit('status', { status: 'disconnected' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Logout error', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
