import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';

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

const sockets = new Set();

// --- Helper functions ---
async function getChannelName(channel) {
  return channel?.name ?? null;
}

async function resolveChannelByName(guildName, channelName) {
  const guild = client.guilds.cache.find(g => g.name.toLowerCase() === guildName.toLowerCase());
  if (!guild) return null;
  await guild.channels.fetch();
  return guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase());
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
}

// --- Discord event handlers ---
client.on('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  broadcast({ type: 'ready', data: { user: { id: client.user.id, tag: client.user.tag } } });
});

client.on('messageCreate', async (msg) => {
  const payload = {
    type: 'messageCreate',
    data: {
      messageId: msg.id,
      content: msg.content ?? '',
      author: {
        id: msg.author?.id,
        username: msg.author?.username,
        bot: msg.author?.bot ?? false
      },
      channelId: msg.channel?.id ?? null,
      channelName: await getChannelName(msg.channel),
      channelType: msg.channel?.type ?? null,
      guildId: msg.guild?.id ?? null,
      createdTimestamp: msg.createdTimestamp
    }
  };
  broadcast(payload);
});

client.on('error', (err) => console.error('[Discord] Error:', err));
client.on('shardError', (err) => console.error('[Discord] Shard Error:', err));

// --- WebSocket server ---
const wss = new WebSocketServer({ port: PORT });

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

    // --- Send message by ID ---
    if (msg?.type === 'sendMessage') {
      const { channelId, content, username, avatarURL } = msg;
      try {
        const channel = await client.channels.fetch(channelId);
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

    // --- Send message by server+channel name ---
    if (msg?.type === 'sendMessageByName') {
      const { GUILD, CHANNEL, TEXT, username, avatarURL } = msg;
      try {
        const channel = await resolveChannelByName(GUILD, CHANNEL);
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
            content: String(TEXT ?? ''),
            username: username ?? client.user.username,
            avatarURL: avatarURL ?? client.user.displayAvatarURL()
          });
        } else {
          await channel.send(String(TEXT ?? ''));
        }

        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: false, error: String(e) }));
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

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('[Discord] Login failed:', e);
  process.exit(1);
});

console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);
