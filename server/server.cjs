require("dotenv").config();
const WebSocket = require("ws");
const { Client, Intents } = require("discord.js-selfbot-v13");

const PORT = Number(process.env.PORT || 3001);
if (!PORT) {
  console.error("PORT not set in environment!");
  process.exit(1);
}

// Discord client
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.MESSAGE_CONTENT
  ]
});

// Cache & sockets
const cache = { ready: false, servers: [] };
let sockets = [];

// Broadcast to all WS clients
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Send full server list
function sendServerList(target) {
  const payload = { type: "serverList", servers: cache.servers };
  if (target) target.send(JSON.stringify(payload));
  else broadcast(payload);
}

// Refresh guild/channel cache
async function refreshCache() {
  console.log("[Discord] Refreshing server cache...");
  cache.servers = [];

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await guild.channels.fetch();
      const textChannels = guild.channels.cache
        .filter(ch => typeof ch.isText === "function" && ch.isText())
        .map(ch => ({ id: ch.id, name: ch.name }));

      cache.servers.push({ id: guild.id, name: guild.name, channels: textChannels });
      console.log(`[Discord] Cached guild: ${guild.name} (${textChannels.length} channels)`);

      broadcast({ type: "serverPartial", guild: { id: guild.id, name: guild.name, channels: textChannels } });
    } catch (err) {
      console.error(`[Discord] Failed to fetch channels for ${guild.name}:`, err);
    }
  }

  cache.ready = true;
  broadcast({ type: "ready", value: true });
  sendServerList();
  console.log("[Discord] Cache complete, ready state sent.");
}

// Send message
async function sendMessageToDiscord(serverNameOrId, channelNameOrId, text) {
  if (!cache.ready) return console.log("[Discord] Cache not ready, cannot send message.");

  const guild = client.guilds.cache.find(g => g.id === serverNameOrId || g.name === serverNameOrId);
  if (!guild) return console.log(`[Discord] Server not found: ${serverNameOrId}`);

  const channel = guild.channels.cache.find(c => 
    (c.id === channelNameOrId || c.name === channelNameOrId) &&
    typeof c.isText === "function" && c.isText()
  );
  if (!channel) return console.log(`[Discord] Channel not found in ${guild.name}: ${channelNameOrId}`);

  try {
    await channel.send(String(text || ""));
    console.log(`[Discord] Sent message to #${channel.name} in ${guild.name}: ${text}`);
  } catch (err) {
    console.error("[Discord] Failed to send message:", err);
  }
}

// WebSocket server
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

  // Send ready state immediately
  ws.send(JSON.stringify({ type: "ready", value: cache.ready }));

  // Send cached servers if available
  if (cache.ready && cache.servers.length > 0) sendServerList(ws);
});

// Forward Discord messages
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

// Login
client.login(process.env.TOKEN)
  .then(() => {
    console.log(`[Discord] Logged in as ${client.user.username}`);
    refreshCache();
  })
  .catch(err => {
    console.error("[Discord] Login failed:", err);
    process.exit(1);
  });
