// server.cjs
require("dotenv").config();
const WebSocket = require("ws");
const { Client } = require("discord.js-selfbot-v13");

// --- Discord Client Setup ---
const client = new Client();
let cache = {
  ready: false,
  servers: []
};

client.on("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.username}`);
  cache.ready = true;
  await refreshCache();

  broadcast({ type: "ready", value: true });
  sendServerList();
});

// --- WebSocket Setup ---
const wss = new WebSocket.Server({ port: 3000 });
let sockets = [];

wss.on("connection", (ws) => {
  console.log("[WS] Client connected.");
  sockets.push(ws);

  // ✅ Always send current ready state on connection
  ws.send(JSON.stringify({ type: "ready", value: cache.ready }));

  // Send servers if already cached
  if (cache.ready && cache.servers.length > 0) {
    sendServerList(ws);
  }

  ws.on("close", () => {
    console.log("[WS] Client disconnected.");
    sockets = sockets.filter(s => s !== ws);
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log("[WS] Incoming:", data);

      if (data.type === "refreshServers") {
        console.log("[WS] Refresh request received.");
        sendServerList(ws);
      }

      if (data.type === "sendMessage") {
        console.log(`[WS] SendMessage request: server=${data.server} channel=${data.channel} text=${data.text}`);
        sendMessageToDiscord(data.server, data.channel, data.text);
      }

    } catch (err) {
      console.error("[WS] Failed to parse message:", err);
    }
  });
});

// --- Helpers ---
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

async function refreshCache() {
  console.log("[Discord] Refreshing server cache...");
  cache.servers = client.guilds.cache.map(g => ({
    id: g.id,
    name: g.name,
channels: g.channels.cache
      .filter(ch => ch.type === 'text')
      .map(ch => ({ id: ch.id, name: ch.name }))
  }));
  console.log(`[Discord] Cached ${cache.servers.length} servers.`);
}

function sendServerList(target) {
  const payload = { type: "serverList", servers: cache.servers };
  if (target) {
    console.log("[WS] Sending server list to a client.");
    target.send(JSON.stringify(payload));
  } else {
    console.log("[WS] Broadcasting server list to all clients.");
    broadcast(payload);
  }
}

async function sendMessageToDiscord(serverName, channelName, text) {
  try {
    const guild = client.guilds.cache.find(g => g.name === serverName || g.id === serverName);
    if (!guild) return console.log(`[Discord] Server not found: ${serverName}`);

    const channel = guild.channels.cache.find(c => c.name === channelName || c.id === channelName);
    if (!channel) return console.log(`[Discord] Channel not found in ${serverName}: ${channelName}`);

    await channel.send(text);
    console.log(`[Discord] Sent message to #${channel.name} in ${guild.name}: ${text}`);
  } catch (err) {
    console.error("[Discord] Failed to send message:", err);
  }
}

// --- Start ---
client.login(process.env.TOKEN);
console.log("[Server] Starting Discord bridge on ws://localhost:3000");
