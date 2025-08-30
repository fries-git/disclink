// server.cjs
require('dotenv').config();
const WebSocket = require('ws');
const { Client } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client();
const sockets = new Set();

function L(...args){ console.log('[bridge]', ...args); }

// Try to populate guild cache if empty
async function ensureGuildsCached() {
  try {
    if (!client.guilds || client.guilds.cache.size === 0) {
      L('guild cache empty — attempting client.guilds.fetch()');
      // try to fetch guilds (may populate cache depending on lib)
      try { await client.guilds.fetch(); } catch(e){ L('client.guilds.fetch() failed (nonfatal):', e && e.message ? e.message : e); }
    }
  } catch(e) {
    L('ensureGuildsCached error', e && e.message ? e.message : e);
  }
}

async function buildGuildData() {
  const guilds = [];
  for (const [id, guild] of client.guilds.cache) {
    try { await guild.channels.fetch(); } catch (e) { L(`channels.fetch failed for guild ${guild.name} (${guild.id}):`, e && e.message ? e.message : e); }
    const channels = guild.channels.cache
      .filter(c => c && typeof c.name === 'string')
      .map(c => ({ id: c.id, name: c.name, type: c.type }));
    guilds.push({ guildId: guild.id, guildName: guild.name, channels });
  }
  return guilds;
}

async function sendBridgeStatus(ws) {
  const payload = { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!client.user };
  try { ws.send(JSON.stringify(payload)); L('-> bridgeStatus', payload); } catch (e) { L('send bridgeStatus failed', e); }
}

async function sendGuildChannels(ws) {
  try {
    if (!client.user) {
      const payload = { type: 'guildChannels', data: [], info: 'discord-not-ready' };
      try { ws.send(JSON.stringify(payload)); } catch(e){}
      L('-> guildChannels: discord not ready');
      return;
    }

    await ensureGuildsCached();

    const guilds = await buildGuildData();
    const payload = { type: 'guildChannels', data: guilds };
    try { ws.send(JSON.stringify(payload)); L('-> guildChannels (sent', guilds.length, 'guilds)'); } catch (e) { L('send guildChannels failed', e); }
  } catch (e) {
    L('sendGuildChannels error:', e && e.message ? e.message : e);
    try { ws.send(JSON.stringify({ type: 'guildChannels', error: String(e) })); } catch {}
  }
}

function broadcastBridgeStatusAndGuilds() {
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) {
    sendBridgeStatus(ws);
    sendGuildChannels(ws);
  }
}

client.on('ready', () => {
  L('Discord ready as', client.user && (client.user.username || client.user.tag));
  // slight delay to let caches settle
  setTimeout(() => broadcastBridgeStatusAndGuilds(), 300);
});

client.on('message', msg => {
  // Optional: forward messages to WS clients
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
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch {}
  }
});

const wss = new WebSocket.Server({ port: PORT }, () => L(`WebSocket listening on ws://localhost:${PORT}`));

wss.on('connection', async (ws, req) => {
  sockets.add(ws);
  L('Client connected from', req.socket.remoteAddress);

  // send immediate status + guilds
  await sendBridgeStatus(ws);
  await sendGuildChannels(ws);

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { L('bad JSON from client', e); return; }
    L('<-', 'received from client', msg.type || '(unknown)');

    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); L('-> pong'); } catch (e) { L('pong send failed', e); }
      return;
    }

    if (msg.type === 'getGuildChannels') {
      await sendGuildChannels(ws);
      return;
    }

    if (msg.type === 'sendMessage') {
      const { guildName, channelName, content } = msg;
      try {
        // find guild by ID first then name
        let guild = null;
        if (guildName && /^[0-9]{16,}$/.test(guildName)) {
          guild = client.guilds.cache.get(guildName);
          L('sendMessage: looked up guild by id:', guildName, 'found=', !!guild);
        }
        if (!guild && guildName) {
          guild = client.guilds.cache.find(g => g.name === guildName);
          L('sendMessage: looked up guild by name:', guildName, 'found=', !!guild);
        }
        if (!guild) throw new Error('Guild not found: ' + guildName);

        // ensure channels cached
        try { await guild.channels.fetch(); } catch (e) { L('channels.fetch failed while sending:', e && e.message ? e.message : e); }

        // find channel by ID then name
        let channel = null;
        if (channelName && /^[0-9]{16,}$/.test(channelName)) {
          channel = guild.channels.cache.get(channelName);
          L('sendMessage: looked up channel by id:', channelName, 'found=', !!channel);
        }
        if (!channel && channelName) {
          channel = guild.channels.cache.find(c => c.name === channelName);
          L('sendMessage: looked up channel by name:', channelName, 'found=', !!channel);
        }
        if (!channel || !('send' in channel)) throw new Error('Channel not found or not text: ' + channelName);

        const fixed = String(content || '').replace(/@(\d{5,})/g, '<@$1>');
        await channel.send(fixed);
        ws.send(JSON.stringify({ type: 'ack', ok: true, ref: msg.ref ?? null }));
        L('-> ack ok (sent to', guild.name + '/' + channel.name, ')');
      } catch (e) {
        L('sendMessage error:', e && e.message ? e.message : e);
        try { ws.send(JSON.stringify({ type: 'ack', ok: false, error: String(e), ref: msg.ref ?? null })); } catch {}
      }
      return;
    }

    // unknown request
    try { ws.send(JSON.stringify({ type: 'error', error: 'unknown-request', raw: msg })); } catch (e) {}
  });

  ws.on('close', (code, reason) => {
    sockets.delete(ws);
    L(`Client disconnected (code=${code}, reason=${String(reason)})`);
  });

  ws.on('error', err => {
    L('ws error', err);
  });
});

// login
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[Discord] Login failed:', e && e.message ? e.message : e);
});
