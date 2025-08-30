// server.cjs — fixed: use return instead of continue
require('dotenv').config();
const WebSocket = require('ws');
const { Client } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client();
const sockets = new Set();

function L(...args){ console.log('[bridge]', ...args); }

async function buildGuildData() {
  const guilds = [];
  for (const [id, guild] of client.guilds.cache) {
    try { await guild.channels.fetch(); } catch (e) { /* ignore per-guild fetch errors */ }
    const channels = guild.channels.cache
      .filter(c => typeof c.name === 'string')
      .map(c => ({ id: c.id, name: c.name, type: c.type }));
    guilds.push({ guildId: guild.id, guildName: guild.name, channels });
  }
  return guilds;
}

async function sendBridgeStatus(ws) {
  const payload = { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!client.user };
  try { ws.send(JSON.stringify(payload)); L('->', 'bridgeStatus', payload); } catch (e) { L('send bridgeStatus failed', e); }
}

async function sendGuildChannels(ws) {
  try {
    if (!client.user) {
      const payload = { type: 'guildChannels', data: [], info: 'discord-not-ready' };
      ws.send(JSON.stringify(payload));
      L('->', 'guildChannels (empty, discord not ready)');
      return;
    }
    const guilds = await buildGuildData();
    const payload = { type: 'guildChannels', data: guilds };
    ws.send(JSON.stringify(payload));
    L('->', `guildChannels (sent ${guilds.length})`);
  } catch (e) {
    L('sendGuildChannels error', e);
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
  setTimeout(() => broadcastBridgeStatusAndGuilds(), 300);
});

client.on('message', msg => {
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
    try { ws.send(JSON.stringify(payload)); L('->', 'messageCreate forwarded'); } catch {}
  }
});

const wss = new WebSocket.Server({ port: PORT }, () => L(`WebSocket listening on ws://localhost:${PORT}`));

wss.on('connection', async (ws, req) => {
  sockets.add(ws);
  L('Client connected from', req.socket.remoteAddress);

  // Immediately send bridge status + guild list
  await sendBridgeStatus(ws);
  await sendGuildChannels(ws);

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { L('bad JSON from client', e); return; }
    L('<-', 'received from client', msg.type || '(unknown)', msg);

    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); L('->', 'pong'); } catch (e) { L('pong send failed', e); }
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
        try { await guild.channels.fetch(); } catch (e) {}
        const channel = guild.channels.cache.find(c => (c.name === channelName || c.id === channelName) && 'send' in c);
        if (!channel) throw new Error('Channel not found or not text: ' + channelName);
        await channel.send(String(content || ''));
        ws.send(JSON.stringify({ type: 'ack', ok: true, ref: msg.ref ?? null }));
        L('->', `ack ok (sent to ${guildName}/${channelName})`);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ok: false, error: String(e), ref: msg.ref ?? null }));
        L('sendMessage error', e.message || e);
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

client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[Discord] Login failed:', e && e.message ? e.message : e);
  // keep server running for debug
});
