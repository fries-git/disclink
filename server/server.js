import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';

const PORT = Number(process.env.PORT || 3001);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

let guildChannels = {}; // cached guild info

client.on('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await cacheGuildChannels();
  broadcast({ type: 'ready', data: { user: { id: client.user.id, tag: client.user.tag } } });
});

// --- Normalize names for matching ---
function normalizeName(str) {
  return String(str ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function cacheGuildChannels() {
  guildChannels = {};
  for (const [guildId, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type
    }));
    guildChannels[guildId] = { guildName: guild.name, channels };
  }
}

client.on('messageCreate', async (msg) => {
  const payload = {
    type: 'messageCreate',
    data: {
      messageId: msg.id,
      content: msg.content ?? '',
      author: { id: msg.author.id, username: msg.author.username, bot: msg.author.bot },
      channelId: msg.channel?.id ?? null,
      channelName: msg.channel?.name ?? null,
      channelType: msg.channel?.type ?? null,
      guildId: msg.guild?.id ?? null,
      createdTimestamp: msg.createdTimestamp
    }
  };
  broadcast(payload);
});

client.on('error', (err) => console.error('[Discord] Error:', err));
client.on('shardError', (err) => console.error('[Discord] Shard Error:', err));

const wss = new WebSocketServer({ port: PORT });
const sockets = new Set();

wss.on('connection', (ws) => {
  sockets.add(ws);
  console.log('[WS] Client connected');

  ws.send(JSON.stringify({ type: 'bridge', data: { status: 'connected', discordReady: !!client.user } }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // --- Send message ---
    if (msg?.type === 'sendMessage') {
      const { channelId, content } = msg;
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !('send' in channel)) throw new Error('Channel not sendable');
        await channel.send(String(content ?? ''));
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: false, error: String(e) }));
      }
    }

    // --- Set presence ---
    if (msg?.type === 'setPresence') {
      const { text, kind } = msg;
      const typeMap = { Playing: ActivityType.Playing, Listening: ActivityType.Listening, Watching: ActivityType.Watching, Competing: ActivityType.Competing };
      try {
        await client.user.setPresence({ activities: [{ name: String(text ?? ''), type: typeMap[kind] ?? ActivityType.Playing }], status: 'online' });
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: false, error: String(e) }));
      }
    }

    // --- Get guild/channel list ---
    if (msg?.type === 'getGuildChannels') {
      await cacheGuildChannels();
      ws.send(JSON.stringify({ type: 'guildChannels', data: Object.values(guildChannels) }));
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    console.log('[WS] Client disconnected');
  });
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

client.login(process.env.DISCORD_TOKEN).catch(e => { console.error('[Discord] Login failed:', e); process.exit(1); });
console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);
