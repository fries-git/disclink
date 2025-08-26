import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { Client, GatewayIntentBits, Partials, ActivityType, ChannelType } from 'discord.js';

const PORT = Number(process.env.PORT || 3001);

// --- Discord client setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.on('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  broadcast({
    type: 'ready',
    data: { user: { id: client.user.id, tag: client.user.tag } }
  });
});

// --- Helper to get channel by ID or name ---
async function findChannel(guild, identifier) {
  await guild.channels.fetch();
  return guild.channels.cache.find(c => c.id === identifier || c.name === identifier);
}

// --- WebSocket server ---
const wss = new WebSocketServer({ port: PORT });
const sockets = new Set();

wss.on('connection', (ws) => {
  sockets.add(ws);
  console.log('[WS] Client connected');

  ws.send(JSON.stringify({
    type: 'bridge',
    data: { status: 'connected', discordReady: !!client.user }
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // --- Send message ---
    if (msg?.type === 'sendMessage') {
      const { channelId, guildId, content, username, avatarURL } = msg;
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new Error('Guild not found');
        const channel = await findChannel(guild, channelId);
        if (!channel || !('send' in channel)) throw new Error('Channel not sendable');

        if (username || avatarURL) {
          const webhooks = await channel.fetchWebhooks();
          let webhook = webhooks.find(w => w.owner?.id === client.user.id);
          if (!webhook) {
            webhook = await channel.createWebhook({
              name: 'TurboWarp Bridge',
              avatar: client.user.displayAvatarURL()
            });
          }
          await webhook.send({
            content: String(content ?? ''),
            username: username ?? client.user.username,
            avatarURL: avatarURL ?? client.user.displayAvatarURL()
          });
        } else {
          await channel.send(String(content ?? ''));
        }

        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: false, error: String(e) }));
      }
    }

    // --- Get last N messages (max 250) ---
    if (msg?.type === 'getMessages') {
      const { guildId, channelId, limit } = msg;
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new Error('Guild not found');
        const channel = await findChannel(guild, channelId);
        if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Invalid text channel');

        const fetchLimit = Math.min(Number(limit) || 50, 250);
        let messages = [];
        let lastId;

        while (messages.length < fetchLimit) {
          const options = { limit: Math.min(100, fetchLimit - messages.length) };
          if (lastId) options.before = lastId;

          const batch = await channel.messages.fetch(options);
          if (batch.size === 0) break;

          messages.push(...batch.map(m =>
            `${m.id}§§§${m.author.username}§§§${m.content.replace(/\n/g, ' ')}§§§${m.createdTimestamp}`
          ));
          lastId = batch.last().id;
        }

        ws.send(JSON.stringify({
          type: 'messages',
          ref: msg.ref ?? null,
          data: messages.join('␟')
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'messages', ref: msg.ref ?? null, error: String(e) }));
      }
    }

    // --- Set presence ---
    if (msg?.type === 'setPresence') {
      const { text, kind } = msg;
      const typeMap = {
        Playing: ActivityType.Playing,
        Listening: ActivityType.Listening,
        Watching: ActivityType.Watching,
        Competing: ActivityType.Competing
      };
      try {
        await client.user.setPresence({
          activities: [{ name: String(text ?? ''), type: typeMap[kind] ?? ActivityType.Playing }],
          status: 'online'
        });
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: false, error: String(e) }));
      }
    }

    // --- Get guild + channels ---
    if (msg?.type === 'getGuildChannels') {
      try {
        const guilds = [];
        for (const [guildId, guild] of client.guilds.cache) {
          await guild.channels.fetch();
          const channels = guild.channels.cache.map(c => ({
            id: c.id,
            name: c.name,
            type: c.type
          }));
          guilds.push({
            guildId: guild.id,
            guildName: guild.name,
            channels
          });
        }

        ws.send(JSON.stringify({
          type: 'guildChannels',
          ref: msg.ref ?? null,
          data: guilds
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'guildChannels', ref: msg.ref ?? null, error: String(e) }));
      }
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    console.log('[WS] Client disconnected');
  });
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
}

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('[Discord] Login failed:', e);
  process.exit(1);
});

console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);
