import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 3001);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const sockets = new Set();

// Send full guild + channel info to a specific WS client
async function sendGuildChannels(ws) {
  try {
    const guilds = [];
    for (const [guildId, guild] of client.guilds.cache) {
      await guild.channels.fetch();
      const channels = guild.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type }));
      guilds.push({ guildId: guild.id, guildName: guild.name, channels });
    }
    ws.send(JSON.stringify({ type: 'guildChannels', data: guilds }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'guildChannels', error: String(e) }));
  }
}

// Broadcast guildChannels to all WS clients
function broadcastGuildChannels() {
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) sendGuildChannels(ws);
  }
}

client.on('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  broadcastGuildChannels(); // Send initial data to all connected clients
});

client.on('messageCreate', msg => {
  const payload = {
    type: 'messageCreate',
    data: {
      messageId: msg.id,
      content: msg.content ?? '',
      author: { id: msg.author?.id, username: msg.author?.username, bot: msg.author?.bot ?? false },
      channelId: msg.channel?.id ?? null,
      channelName: msg.channel?.name ?? null,
      channelType: msg.channel?.type ?? null,
      guildId: msg.guild?.id ?? null,
      createdTimestamp: msg.createdTimestamp
    }
  };
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
});

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', async ws => {
  sockets.add(ws);
  console.log('[WS] Client connected');

  ws.send(JSON.stringify({ type: 'bridgeStatus' }));
  await sendGuildChannels(ws); // Send initial server/channel info

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

client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[Discord] Login failed:', e);
  process.exit(1);
});

console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);
