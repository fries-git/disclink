// server.cjs
// Requirements: npm i discord.js-selfbot-v13 ws dotenv
require('dotenv').config();
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!PORT) {
  console.error('PORT environment variable must be set. Exiting.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('DISCORD_TOKEN (or TOKEN) environment variable must be set. Exiting.');
  process.exit(1);
}

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.MESSAGE_CONTENT
  ]
});

// In-memory state
const state = {
  ready: false,            // true after initial caching
  servers: [],             // [{ id, name, channels: [{id,name}] }]
  queue: []                // queued sends when not ready: {req, tries, timestamp}
};

let sockets = [];

// --- helpers ---
function log(...args){ console.log('[bridge]', ...args); }
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj){
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// --- fetch & cache functions ---
async function ensureGuildsFetched(){
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    log('guilds.cache empty — attempting client.guilds.fetch()');
    await client.guilds.fetch(); // best-effort
    // small wait for cache
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 5000) await sleep(200);
    log('guilds.cache size after fetch:', client.guilds.cache.size);
  } catch(e){
    log('client.guilds.fetch() error (nonfatal):', e && e.message ? e.message : e);
  }
}

async function buildCache({progressively=true} = {}){
  log('Starting cache build (progressively=' + !!progressively + ')');
  state.servers = [];
  await ensureGuildsFetched();

  // iterate guilds and fetch channels per guild (with mild pacing)
  const guilds = Array.from(client.guilds.cache.values());
  for (let i=0; i<guilds.length; i++){
    const guild = guilds[i];
    try {
      // fetch channels for this guild to populate cache
      try { await guild.channels.fetch(); } catch(e){ log(`guild.channels.fetch failed for ${guild.id}`, e && e.message ? e.message : e); }

      const channels = [];
      for (const [cid, ch] of guild.channels.cache) {
        if (ch && typeof ch.isText === 'function' && ch.isText()) {
          channels.push({ id: ch.id, name: ch.name });
        }
      }

      state.servers.push({ id: guild.id, name: guild.name, channels });

      // send partial update so UI can populate progressively
      if (progressively) broadcast({ type: 'serverPartial', guild: { id: guild.id, name: guild.name, channels } });

      log(`Cached guild ${guild.name} (${guild.id}) channels=${channels.length}`);
    } catch (e) {
      log('Error caching guild', guild && guild.id, e && e.message ? e.message : e);
    }
    // small pause between guild fetches to reduce chance of hitting rate limits
    if (i % 5 === 0) await sleep(150);
  }

  state.ready = true;
  broadcast({ type: 'ready', value: true });
  broadcast({ type: 'serverList', servers: state.servers });
  log('Cache build complete; ready=true; total servers=', state.servers.length);
}

// --- send processing (queue + retries) ---
async function processQueue(){
  if (state.queue.length === 0) return;
  log('Processing send queue (len=' + state.queue.length + ')');
  const queue = state.queue.splice(0); // take snapshot
  for (const item of queue){
    const { req } = item;
    try {
      const res = await handleSendRequest(req, true); // true = fromQueue
      // ack will be sent by handleSendRequest
    } catch (e) {
      log('Queued send failed:', e && e.message ? e.message : e);
    }
    await sleep(300);
  }
}

async function handleSendRequest(msg, fromQueue=false){
  // msg can contain: guildId, channelId, guildName, channelName, content, ref
  const ref = msg.ref ?? null;
  // prefer ids if provided
  try {
    let targetChannel = null;

    if (msg.channelId) {
      // direct fetch
      try {
        targetChannel = await client.channels.fetch(msg.channelId);
      } catch(e){ log('client.channels.fetch failed for id', msg.channelId, e && e.message ? e.message : e); }
    }

    if (!targetChannel) {
      // find guild
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(msg.guildId) ?? client.guilds.cache.find(g => g.id === msg.guildId);
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');

      // ensure channels fetched for that guild
      try { await guild.channels.fetch(); } catch(e){ log('channels.fetch failed while sending', e && e.message ? e.message : e); }

      // find channel by id or name
      if (msg.channelId) targetChannel = guild.channels.cache.get(msg.channelId);
      if (!targetChannel && msg.channelName) targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && typeof c.isText === 'function' && c.isText());
    }

    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');

    const content = String(msg.content ?? '');
    await targetChannel.send(content);
    // success ack
    broadcast({ type:'ack', ok:true, ref });
    log('Message sent to', targetChannel.id, 'ref=', ref);
    return true;
  } catch (e) {
    const errStr = e && e.message ? e.message : String(e);
    // if not ready and not fromQueue, queue it
    if (!state.ready && !fromQueue) {
      // push into queue for later processing (with simple retry counter)
      state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
      broadcast({ type:'ack', ok:false, ref, queued:true, error: 'queued-not-ready' });
      log('Send queued (not ready)', ref);
      return false;
    } else {
      // final failure ack
      broadcast({ type:'ack', ok:false, ref, error: errStr });
      log('Send failed', errStr, 'ref=', ref);
      return false;
    }
  }
}

// --- WebSocket server ---
const wss = new WebSocket.Server({ port: PORT }, () => {
  log(`WebSocket listening on 0.0.0.0:${PORT}`);
});

wss.on('connection', async (ws, req) => {
  sockets.push(ws);
  log('Client connected from', req.socket.remoteAddress);

  // send current state immediately
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.ready });
  safeSend(ws, { type: 'ready', value: !!state.ready });

  // if we already have servers cached, send them
  if (state.servers.length > 0) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if (msg.type === 'ping') { safeSend(ws, { type:'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList' || msg.type === 'getGuildChannels') {
      // optional force parameter
      if (msg.force) {
        state.ready = false;
        safeSend(ws, { type: 'ready', value: false });
        await buildCache(); // rebuild then send
        return;
      }
      safeSend(ws, { type: 'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'sendMessage') {
      // immediate attempt, may queue
      await handleSendRequest(msg);
      return;
    }

    // unknown
    safeSend(ws, { type:'error', error:'unknown-request', raw: msg });
  });

  ws.on('close', () => {
    sockets = sockets.filter(s => s !== ws);
    log('Client disconnected');
  });

  ws.on('error', e => log('ws error', e && e.message ? e.message : e));
});

// --- forward Discord messages to WS ---
client.on('messageCreate', m => {
  if (!m.guild || !m.channel) return;
  const payload = {
    type: 'message',
    data: {
      messageId: m.id,
      content: m.content || '',
      author: { id: m.author?.id || '', username: m.author?.username || '' },
      guildId: m.guild.id,
      guildName: m.guild.name,
      channelId: m.channel.id,
      channelName: m.channel.name,
      timestamp: m.createdTimestamp
    }
  };
  broadcast(payload);
});

// --- startup / login & cache build ---
client.login(TOKEN)
  .then(async () => {
    log('Discord login success as', client.user && (client.user.username || client.user.tag));
    // Build cache progressively but ensure at least some partial servers go out quickly
    try {
      await ensureGuildsFetched();
      // if still no guilds, wait a short while and try again
      if (!client.guilds.cache.size) {
        log('No guilds in cache yet, waiting 2s then trying fetch again');
        await sleep(2000);
        await ensureGuildsFetched();
      }
      // build cache (progressively) - sends partials and final ready
      await buildCache({progressively:true});
      // process any queued sends now that we are ready
      await processQueue();
    } catch(e){
      log('Initial cache build error:', e && e.message ? e.message : e);
    }
  })
  .catch(err => {
    log('Discord login failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
