// server.cjs
require("dotenv").config();
const WebSocket = require("ws");
const { Client } = require("discord.js-selfbot-v13");

const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error("PORT environment variable not set. Exiting.");
  process.exit(1);
}

// --- Discord Client Setup ---
const client = new Client();
const cache = { ready: false, servers: [] };
let sockets = [];

// --- Broadcast helper ---
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// --- Refresh guild/channel cache ---
async function refreshCache() {
  console.log("[Discord] Refreshing server cache...");
  cache.servers = [];

  try {
    for (const [guildId, guild] of client.guilds.cache) {
      await guild.channels.fetch(); // ensure channels are cached
      const textChannels = guild.channels.cache
        .filter(ch => ch.type === 'text')
        .map(ch => ({ id: ch.id, name: ch.name }));

      cache.servers.push({
        id: guild.id,
        name: guild.name,
        channels: textChannels
      });

      console.log(`[Discord] Cached guild: ${guild.name} (${textChannels.length} channels)`);
    }

    cache.ready = true;
    broadcast({ type: "ready", value: true });
    sendServerList();
    console.log("[Discord] Cache complete. Ready state sent.");

  } catch (err) {
    console.error("[Discord] Failed to cache servers/channels:", err);
    cache.ready = false;
    broadcast({ type: "ready", value: false });
  }
}

// --- Send server list ---
function sendServerList(target) {
  const payload = { type: "serverList", servers: cache.servers };
  if (target) {
    target.send(JSON.stringify(payload));
  } else {
    broadcast(payload);
  }
}

// --- Send message to Discord ---
async function sendMessageToDiscord(serverName, channelName, text) {
  try {
    const guild = client.guilds.cache.find(g => g.name === serverName || g.id === serverName);
    if (!guild) return console.log(`[Discord] Server not found: ${serverName}`);

    const channel = guild.channels.cache.find(c => (c.name === channelName || c.id === channelName) && c.type === 'text');
    if (!channel) return console.log(`[Discord] Channel not found in ${serverName}: ${channelName}`);

    await channel.send(text);
    console.log(`[Discord] Sent message to #${channel.name} in ${guild.name}: ${text}`);
  } catch (err) {
    console.error("[Discord] Failed to send message:", err);
  }
}

// --- Handle WebSocket connections ---
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`[Server] Bridge running on ws://0.0.0.0:${PORT}`);
});

wss.on("connection", ws => {
  console.log("[WS] Client connected");
  sockets.push(ws);

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
    sockets = sockets.filter(s => s !== ws);
  });

  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case "refreshServers":
          await refreshCache();
          break;

        case "getChannels":
          const guild = cache.servers.find(s => s.id === msg.guildId || s.name === msg.guildId);
          if (guild) ws.send(JSON.stringify({ type: "channelList", guildId: guild.id, data: guild.channels }));
          break;

        case "sendMessage":
          await sendMessageToDiscord(msg.server, msg.channel, msg.text);
          break;
      }

    } catch (err) {
      console.error("[WS] Error handling message:", err);
    }
  });

  // Send current ready state immediately
  ws.send(JSON.stringify({ type: "ready", value: cache.ready }));

  // Send server list if already cached
  if (cache.ready && cache.servers.length > 0) sendServerList(ws);
});

// --- Forward Discord messages to WS ---
client.on("messageCreate", msg => {
  if (!msg.guild || !msg.channel) return;
  const payload = {
    type: "message",
    guildId: msg.guild.id,
    guildName: msg.guild.name,
    channelId: msg.channel.id,
    channelName: msg.channel.name,
    authorId: msg.author.id,
    authorName: msg.author.username,
    content: msg.content
  };
  broadcast(payload);
});

// --- Login ---
client.login(process.env.TOKEN)
  .then(() => console.log("[Discord] Logged in"))
  .catch(err => {
    console.error("[Discord] Login failed:", err);
    process.exit(1);
  });