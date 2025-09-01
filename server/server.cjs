// server.cjs
const WebSocket = require("ws");
const { Client } = require("discord.js-selfbot-v13");

const PORT = process.env.PORT || 3000;
const wsServer = new WebSocket.Server({ port: PORT });

console.log(`[Server] Starting Discord bridge on ws://localhost:${PORT}`);

// Discord client
const client = new Client();
let serverCache = new Map();

// Login
client.on("ready", () => {
  console.log(`[Discord] Logged in as ${client.user.username}`);
  buildCache();
});

// Build cache ONCE
function buildCache() {
  console.log(`[Discord] Building server & channel cache...`);
  client.guilds.cache.forEach((guild) => {
    const channels = guild.channels.cache
      .filter((ch) => ch.type === "GUILD_TEXT") // only text
      .map((ch) => ({ id: ch.id, name: ch.name }));
    serverCache.set(guild.id, {
      id: guild.id,
      name: guild.name,
      channels,
    });
  });
  console.log(
    `[Discord] Cached ${serverCache.size} servers and ${
      [...serverCache.values()].reduce((a, g) => a + g.channels.length, 0)
    } text channels`
  );
}

// Handle incoming WS messages
wsServer.on("connection", (socket) => {
  console.log("[Server] TurboWarp connected");

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "sendMessage") {
      const guild = client.guilds.cache.find((g) => g.name === msg.server);
      const channel = guild?.channels.cache.find((c) => c.name === msg.channel);
      if (channel && channel.isText()) {
        await channel.send(msg.content).catch(console.error);
      }
    }
  });
});

// Relay incoming Discord messages
client.on("messageCreate", (msg) => {
  if (!msg.guild || !msg.channel) return;
  if (msg.author.id === client.user.id) return; // ignore self

  const payload = {
    type: "message",
    content: msg.content || "",
    author: msg.author.username,
    channel: msg.channel.name,
    server: msg.guild.name,
    timestamp: msg.createdTimestamp,
    media:
      msg.attachments.size > 0
        ? msg.attachments.map((a) => a.url)
        : [],
  };

  // Send to all connected WS clients
  wsServer.clients.forEach((c) =>
    c.readyState === WebSocket.OPEN && c.send(JSON.stringify(payload))
  );

  // Check for pings
  if (msg.mentions.has(client.user)) {
    const pingPayload = {
      type: "ping",
      from: msg.author.username,
      channel: msg.channel.name,
      server: msg.guild.name,
      timestamp: msg.createdTimestamp,
      content: msg.content,
    };
    wsServer.clients.forEach((c) =>
      c.readyState === WebSocket.OPEN && c.send(JSON.stringify(pingPayload))
    );
  }
});

client.login(process.env.TOKEN);
