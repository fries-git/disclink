// server.cjs
require('dotenv').config();
const WebSocket = require('ws');
const { Client } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client();
const sockets = new Set();

// robust logging helper
function log(...args) { console.log('[bridge]', ...args); }

async function sendGuildChannels(ws) {
  try {
    if (!client.user) {
      ws.send(JSON.stringify({ type: 'guildChannels', data: [], info: 'discord-not-ready' }));
      return;
    }
    const guilds = [];
    for (const [id, guild] of client.guilds.cache) {
      // ensure channels cached
      try { await guild.channels.fetch(); } catch (e) { /* ignore fetch errors per guild */ }
      const channels = guild.channels.cache
        .filter(c => typeof c.name === 'string')
        .map(c => ({ id: c.id, name: c.name, type: c.type }));
      guilds.push({ guildId: guild.id, guildName: guild.name, channels });
    }
    ws.send(JSON.stringify({ type: 'guildChannels', data: guilds }));
    log('sent guildChannels to client (count:', guilds.length + ')');
  } catch (e) {
    log('sendGuildChannels error:', e);
    try { ws.send(JSON.stringify({ type: 'guildChannels', error: String(e) })); } catch {}
  }
}

function broadcastGuildChannels() {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) sendGuildChannels(ws);
  }
}

client.on('ready', () => {
  log('Discord logged in as', client.user?.username || client.user?.tag);
  // give a short delay to allow channel caches to populate more reliably
  setTimeout(() => broadcastGuildChannels(), 500);
});

client.on('message', msg => {
  // Optional: forward messages to WS clients if you want live message events
  const payload = {
    type: 'messageCreate',
    data: {
      id: msg.id,
      content: msg.content ?? '',
      author: { id: msg.author?.id, username: msg.author?.username },
      guildId: msg.guild?.id ?? null,
      channelId: msg.channel?.id ?? null,
      channelName: msg.channel?.name ?? null,
      timestamp: msg.createdTimestamp
    }
  };
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
});

const wss = new WebSocket.Server({ port: PORT }, () => {
  log(`WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on('connection', async (ws, req) => {
  sockets.add(ws);
  log('WS client connected from', req.socket.remoteAddress);

  // send immediate status
  try {
    ws.send(JSON.stringify({ type: 'bridgeStatus', bridgeConnected: true, discordReady: !!client.user }));
  } catch (e) {}

  // send initial guildChannels immediately if available
  if (client.user) {
    await sendGuildChannels(ws);
  }

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { log('bad JSON from client:', e); return; }

    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (e) {}
      return;
    }

    if (msg.type === 'getGuildChannels') {
      await sendGuildChannels(ws);
      return;
    }

    if (msg.type === 'sendMessage') {
      const { guildName, channelName, content } = msg;
      try {
        const guild = client.guilds.cache.find(g => g.name === guildName || g.id === guildName);
        if (!guild) throw new Error('Guild not found: ' + guildName);
        // ensure channels cached
        try { await guild.channels.fetch(); } catch (e) {}
        const channel = guild.channels.cache.find(c => (c.name === channelName || c.id === channelName) && 'send' in c);
        if (!channel) throw new Error('Channel not found or not text: ' + channelName);
        await channel.send(String(content || ''));
        ws.send(JSON.stringify({ type: 'ack', ok: true, ref: msg.ref ?? null }));
        log(`Sent message to ${guildName}/${channelName}`);
      } catch (e) {
        log('sendMessage error:', e);
        try { ws.send(JSON.stringify({ type: 'ack', ok: false, error: String(e), ref: msg.ref ?? null })); } catch {}
      }
      return;
    }

    // unknown
    try { ws.send(JSON.stringify({ type: 'error', error: 'unknown-request' })); } catch {}
  });

  ws.on('close', (code, reason) => {
    sockets.delete(ws);
    log(`WS client disconnected (code=${code} reason=${String(reason)})`);
  });

  ws.on('error', err => {
    log('WS client error:', err);
  });
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

// login
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[Discord] Login failed:', e && e.message ? e.message : e);
  // don't exit immediately if you want to debug; but if you prefer crash, uncomment:
  // process.exit(1);
});