import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { Client, GatewayIntentBits, Partials, ActivityType, TextChannel, WebhookClient } from 'discord.js';

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
  broadcast({ type: 'ready', data: { user: { id: client.user.id, tag: client.user.tag } } });
});

async function getChannelName(channel) {
  if (!channel) return null;
  if (channel.type === 0) return channel.name; // Text channel
  return null; // Add other types if needed
}

client.on('messageCreate', async (msg) => {
  const channelName = await getChannelName(msg.channel);
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
      channelName,
      guildId: msg.guild?.id ?? null,
      createdTimestamp: msg.createdTimestamp
    }
  };
  broadcast(payload);
});

client.on('error', (err) => console.error('[Discord] Error:', err));
client.on('shardError', (err) => console.error('[Discord] Shard Error:', err));

// --- WebSocket server setup ---
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
      const { channelId, content, username, avatarURL } = msg;

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !('send' in channel)) throw new Error('Channel not sendable');

        if (username || avatarURL) {
          // Send via webhook
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
          // Normal bot message
          await channel.send(String(content ?? ''));
        }

        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ref: msg.ref ?? null, ok: false, error: String(e) }));
      }
    }

    // --- Set presence ---
    if (msg?.type === 'setPresence') {
      const { text, kind } = msg; // kind: 'Playing' | 'Listening' | 'Watching' | 'Competing'
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

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('[Discord] Login failed:', e);
  process.exit(1);
});

console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);