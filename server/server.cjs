// server.cjs
require('dotenv').config();
const WebSocket = require('ws');
const { Client, Partials } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client({ partials: [Partials.Channel] });
const sockets = new Set();
const guildCache = new Map(); // guildId -> { channels: [], fetchedAt }

const CACHE_TTL_MS = 1000 * 60 * 3; // 3 minutes

function log(...args){ console.log('[bridge]', ...args); }

// fetch and cache channels for a guild
async function fetchGuildChannels(guild){
  try {
    await guild.channels.fetch();
    const channels = guild.channels.cache.map(c => ({ id:c.id, name:c.name, type:c.type }));
    guildCache.set(guild.id, { channels, fetchedAt: Date.now() });
    return { guildId:guild.id, guildName:guild.name, channels };
  } catch(e){
    log('Failed fetching channels for', guild.name, e.message);
    return { guildId:guild.id, guildName:guild.name, channels: [] };
  }
}

// send incremental guilds + channels to WS client
async function sendGuildChannels(ws, force=false){
  if(!client.user){
    ws.send(JSON.stringify({ type:'guildChannels', data: [], info:'discord-not-ready' }));
    return;
  }

  const guilds = Array.from(client.guilds.cache.values());
  ws.send(JSON.stringify({ type:'guildSummary', data: guilds.map(g=>({guildId:g.id, guildName:g.name})) }));

  for(const guild of guilds){
    const cached = guildCache.get(guild.id);
    const now = Date.now();
    if(!force && cached && (now - cached.fetchedAt) < CACHE_TTL_MS){
      ws.send(JSON.stringify({ type:'guildChannelsPartial', guild: { guildId:guild.id, guildName:guild.name, channels: cached.channels }}));
      continue;
    }
    const data = await fetchGuildChannels(guild);
    ws.send(JSON.stringify({ type:'guildChannelsPartial', guild: data }));
  }

  ws.send(JSON.stringify({ type:'guildChannelsComplete', ts: Date.now() }));
}

// login selfbot
client.login(process.env.DISCORD_TOKEN).catch(e=>{
  log('Login failed:', e.message);
  process.exit(1);
});

client.on('ready', ()=>log('[Discord] Logged in as', client.user.tag));

// forward messages to connected clients
client.on('messageCreate', msg=>{
  const payload = {
    type:'messageCreate',
    data:{
      messageId: msg.id,
      content: msg.content || '',
      author: { id: msg.author.id, username: msg.author.username, bot: msg.author.bot },
      channelId: msg.channel.id,
      channelName: msg.channel.name || '',
      channelType: msg.channel.type,
      guildId: msg.guild?.id || '',
      guildName: msg.guild?.name || '',
      createdTimestamp: msg.createdTimestamp
    }
  };
  for(const ws of sockets) if(ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
});

// WebSocket server
const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', async ws=>{
  sockets.add(ws);
  log('[WS] Client connected');

  ws.send(JSON.stringify({ type:'bridgeStatus', bridgeConnected:true, discordReady:!!client.user }));

  await sendGuildChannels(ws);

  ws.on('message', async raw=>{
    let msg;
    try{ msg = JSON.parse(raw.toString()); }catch{return;}

    if(msg?.type==='sendMessage'){
      const { guildId, channelId, content } = msg;
      if(!guildId || !channelId) return;
      try{
        const channel = await client.channels.fetch(channelId);
        if(!channel || !('send' in channel)) throw new Error('Invalid channel');
        await channel.send(String(content||''));
        ws.send(JSON.stringify({ type:'ack', ref: msg.ref??null, ok:true }));
      } catch(e){
        ws.send(JSON.stringify({ type:'ack', ref: msg.ref??null, ok:false, error:String(e) }));
      }
    }

    if(msg?.type==='getGuildChannels'){
      await sendGuildChannels(ws, !!msg.force);
    }
  });

  ws.on('close', ()=>{ sockets.delete(ws); log('[WS] Client disconnected'); });
  ws.on('error', e=>log('WS error', e.message));
});

log(`[WS] Bridge listening on ws://localhost:${PORT}`);
