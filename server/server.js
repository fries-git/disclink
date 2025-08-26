import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const PORT = Number(process.env.PORT || 3001);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const sockets = new Set();

// --- Discord ready ---
client.on('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
});

// --- Message received ---
client.on('messageCreate', msg => {
  const payload = {
    type: 'messageCreate',
    data: {
      messageId: msg.id,
      content: msg.content ?? '',
      author: { id: msg.author?.id, username: msg.author?.username, bot: msg.author?.bot ?? false },
      channelId: msg.channel?.id ?? null,
      channelName: msg.channel?.name ?? null,
      channelType: msg.channel?.type ?? null,
      guildId: msg.guild?.id ?? null,
      createdTimestamp: msg.createdTimestamp
    }
  };
  broadcast(payload);
});

// --- WebSocket server ---
const wss = new WebSocketServer({ port: PORT });
wss.on('connection', ws => {
  sockets.add(ws);
  console.log('[WS] Client connected');

  ws.send(JSON.stringify({ type:'bridge', data:{ status:'connected', discordReady: !!client.user } }));

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // --- Send message ---
    if(msg?.type === 'sendMessage'){
      const { guildId, channelId, content } = msg;
      if(!guildId || !channelId) return;
      try {
        const channel = await client.channels.fetch(channelId);
        if(channel && 'send' in channel) await channel.send(String(content ?? ''));
        ws.send(JSON.stringify({ type:'ack', ref: msg.ref ?? null, ok:true }));
      } catch(e){
        ws.send(JSON.stringify({ type:'ack', ref: msg.ref ?? null, ok:false, error: String(e) }));
      }
    }

    // --- Get guilds + channels ---
    if(msg?.type === 'getGuildChannels'){
      try {
        const guilds = [];
        for(const [guildId, guild] of client.guilds.cache){
          await guild.channels.fetch(); // make sure all channels are cached
          const channels = guild.channels.cache.map(c => ({ id:c.id, name:c.name, type:c.type }));
          guilds.push({ guildId:guild.id, guildName:guild.name, channels });
        }
        ws.send(JSON.stringify({ type:'guildChannels', data: guilds, ref: msg.ref ?? null }));
      } catch(e){
        ws.send(JSON.stringify({ type:'guildChannels', error:String(e), ref: msg.ref ?? null }));
      }
    }

    // --- Get last messages ---
    if(msg?.type === 'getMessages'){
      try {
        const channel = await client.channels.fetch(msg.channelId);
        if(!channel || !('messages' in channel)) throw new Error('Invalid channel');
        const fetched = await channel.messages.fetch({ limit: msg.limit || 50 });
        ws.send(JSON.stringify({ type:'messages', data: Array.from(fetched.values()).map(m=>m.content), ref: msg.ref ?? null }));
      } catch(e){
        ws.send(JSON.stringify({ type:'messages', error: String(e), ref: msg.ref ?? null }));
      }
    }
  });

  ws.on('close', () => { sockets.delete(ws); console.log('[WS] Client disconnected'); });
});

function broadcast(obj){
  const data = JSON.stringify(obj);
  for(const ws of sockets) if(ws.readyState === ws.OPEN) ws.send(data);
}

client.login(process.env.DISCORD_TOKEN).catch(e=>{
  console.error('[Discord] Login failed:', e);
  process.exit(1);
});

console.log(`[WS] Bridge listening on ws://localhost:${PORT}`);
