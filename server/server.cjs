require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3001);

const client = new Client();

const sockets = new Set();

// Send full guild + channel info to a WS client
async function sendGuildChannels(ws) {
  try {
    const guilds = [];
    for (const [guildId, guild] of client.guilds.cache) {
      await guild.channels.fetch(); // fetch all channels
      const channels = guild.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type }));
      guilds.push({ guildId: guild.id, guildName: guild.name, channels });
    }
    ws.send(JSON.stringify({ type: 'guildChannels', data: guilds }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'guildChannels', error: String(e) }));
  }
}

// Broadcast to all connected clients
function broadcastGuildChannels() {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) sendGuildChannels(ws);
  }
}

// Discord selfbot ready
client.on('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.username}`);
  broadcastGuildChannels();
});

// Listen for messages (optional, can forward to WS)
client.on('message', msg => {
  const payload = {
    type: 'messageCreate',
    data: {
      messageId: msg.id,
      content: msg.content ?? '',
      author: { id: msg.author.id, username: msg.author.username, bot: msg.author.bot ?? false },
      channelId: msg.channel.id,
      channelName: msg.channel.name,
      channelType: msg.channel.type,
      guildId: msg.guild?.id ?? null,
      createdTimestamp: msg.createdTimestamp
    }
  };
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
});

// WebSocket server
const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', async ws => {
  sockets.add(ws);
  console.log('[WS] Client connected');

  ws.send(JSON.stringify({ type: 'bridgeStatus' }));
  await sendGuildChannels(ws); // send initial data

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg?.type === 'getGuildChannels') {
      await sendGuildChannels(ws);
    }

    if (msg?.type === 'sendMessage') {
      const { guildName, channelName, content } = msg;
      try {
        const guild = client.guilds.cache.find(g => g.name === guildName);
        if (!guild) throw new Error('Guild not found');
        const channel = guild.channels.cache.find(c => c.name === channelName && 'send' in c);
        if (!channel) throw new Error('Channel not found');
        await channel.send(String(content || ''));
        ws.send(JSON.stringify({ type: 'ack', ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ok: false, error: String(e) }));
      }
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    console.log('[WS] Client disconnected');
  });
});

// Login using user token from .env
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[Discord] Login failed:', e);
  process.exit(1);
});

console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);
