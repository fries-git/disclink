// server.cjs
require("dotenv").config();
const WebSocket = require("ws");
const { Client } = require("discord.js-selfbot-v13");

const PORT = process.env.PORT || 3000;

// --- Discord client setup ---
const client = new Client({ checkUpdate: false });

// Caches
const cache = {
  guilds: new Map(),   // id → { id, name }
  channels: new Map(), // id → { id, guildId, name }
};

// WebSocket server
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`✅ Bridge running on ws://localhost:${PORT}`);
});

// Rate limit refresh calls
let lastRefresh = 0;
const REFRESH_COOLDOWN = 5000; // 5 seconds

// Broadcast helper
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// --- Discord login ---
client.on("ready", () => {
  console.log(`🔗 Logged in as ${client.user.username}`);
  refreshCache(true);
});

// Cache refresh
async function refreshCache(first = false) {
  const now = Date.now();
  if (!first && now - lastRefresh < REFRESH_COOLDOWN) {
    console.log("⏳ Refresh skipped (rate limit)");
    return;
  }
  lastRefresh = now;

  cache.guilds.clear();
  cache.channels.clear();

  client.guilds.cache.forEach((guild) => {
    cache.guilds.set(guild.id, { id: guild.id, name: guild.name });
    guild.channels.cache.forEach((ch) => {
      if (ch.type === "GUILD_TEXT") {
        cache.channels.set(ch.id, { id: ch.id, guildId: guild.id, name: ch.name });
      }
    });
  });

  console.log(`📦 Cached ${cache.guilds.size} servers & ${cache.channels.size} channels`);

  broadcast({
    type: "serverList",
    data: Array.from(cache.guilds.values()),
  });
}

// --- Handle messages from Turbowarp ---
wss.on("connection", (ws) => {
  console.log("🌐 Turbowarp client connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.type) {
        case "refreshServers":
          await refreshCache();
          break;

        case "getChannels":
          if (cache.guilds.has(data.guildId)) {
            const channels = Array.from(cache.channels.values()).filter(
              (ch) => ch.guildId === data.guildId
            );
            ws.send(JSON.stringify({ type: "channelList", guildId: data.guildId, data: channels }));
          }
          break;

        case "sendMessage":
          if (cache.channels.has(data.channelId)) {
            const channel = client.channels.cache.get(data.channelId);
            if (channel) {
              await channel.send(data.content);
              ws.send(JSON.stringify({ type: "sentMessage", ok: true }));
            }
          }
          break;
      }
    } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });

  // On connect, immediately send current server list
  ws.send(JSON.stringify({
    type: "serverList",
    data: Array.from(cache.guilds.values())
  }));
});

// Forward Discord messages to Turbowarp
client.on("messageCreate", (msg) => {
  if (!msg.guild || msg.author.bot) return;
  broadcast({
    type: "message",
    guildId: msg.guild.id,
    channelId: msg.channel.id,
    content: msg.content,
    author: msg.author.username,
    guildName: msg.guild.name,
    channelName: msg.channel.name,
  });
});

client.login(process.env.TOKEN);
