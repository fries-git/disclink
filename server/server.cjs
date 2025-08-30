require('dotenv').config();

const { WebSocketServer } = require('ws');
const { Client } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client({ checkUpdate: false });
const sockets = new Set();

async function getGuildData() {
  const guilds = [];
  for (const [, guild] of client.guilds.cache) {
    await guild.channels.fetch(); // populate cache
    guilds.push({
      guildId: guild.id,
      guildName: guild.name,
      channels: guild.channels.cache.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type
      }))
    });
  }
  return guilds;
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

client.on('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  broadcast({ type: 'discordReady', user: { id: client.user.id, tag: client.user.tag } });
});

client.on('messageCreate', msg => {
  broadcast({
    type: 'messageCreate',
    data: {
      id: msg.id,
      content: msg.content,
      author: { id: msg.author.id, username: msg.author.username },
      guildId: msg.guild?.id ?? null,
      channelId: msg.channel.id,
      channelName: msg.channel.name,
      timestamp: msg.createdTimestamp
    }
  });
});

const wss = new WebSocketServer({ port: PORT });
console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);

wss.on('connection', async ws => {
  sockets.add(ws);
  console.log('[WS] Client connected');

  ws.send(JSON.stringify({
    type: 'bridgeStatus',
    connected: true,
    discordReady: !!client.user
  }));

  if (client.user) {
    ws.send(JSON.stringify({ type: 'guildChannels', data: await getGuildData() }));
  }

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    }

    if (msg.type === 'getGuildChannels') {
      ws.send(JSON.stringify({ type: 'guildChannels', data: await getGuildData() }));
    }

    if (msg.type === 'sendMessage') {
      const { channelId, content } = msg;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          await channel.send(content || '');
          ws.send(JSON.stringify({ type: 'ack', ok: true, ref: msg.ref ?? null }));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ok: false, error: String(e), ref: msg.ref ?? null }));
      }
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    console.log('[WS] Client disconnected');
  });
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('[Discord] Login failed:', err);
  process.exit(1);
});
