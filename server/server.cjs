// server.cjs
// Fixed: discordConnected vs cacheReady separation so "discord ready" shows true
// and sends aren't queued just because cache isn't built.
// Requires: npm i discord.js-selfbot-v13 ws dotenv

'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CACHE_FILE = path.join(__dirname, 'cache.json');
if (!TOKEN) { console.error('[bridge] DISCORD_TOKEN/TOKEN missing'); process.exit(1); }

function log(...a){ console.log('[bridge]', ...a); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const client = new Client({
  intents: [ Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.MESSAGE_CONTENT ]
});

// runtime state
const state = {
  discordConnected: false,   // true when client.on('ready') fires
  cacheReady: false,         // true when server list cache built (optional)
  servers: [],               // cached server list [{id,name,channels:[{id,name}]}]
  queue: [],                 // queued sends only when discord NOT connected
  processedRefs: new Set()
};

let sockets = [];
let processingQueue = false;
let cacheBuilding = false;
let _saveTimer = null;
const DEDUPE_WINDOW_MS = 1500;
const lastMessagePerChannel = new Map();

// --- persistence (cache + processed refs) ---
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed) return false;
    state.servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    state.cacheReady = !!parsed.cacheReady;
    state.processedRefs = new Set(Array.isArray(parsed.processedRefs) ? parsed.processedRefs : []);
    log('Loaded cache from disk', CACHE_FILE, 'servers=', state.servers.length);
    return true;
  } catch (e) {
    log('loadCache failed', e && e.message ? e.message : e);
    return false;
  }
}

function saveCacheDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const tmp = CACHE_FILE + '.tmp';
      const out = { cacheReady: state.cacheReady, servers: state.servers, processedRefs: Array.from(state.processedRefs) };
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
      log('Saved cache to disk');
    } catch (e) {
      log('saveCache failed', e && e.message ? e.message : e);
    }
  }, 700);
}

// --- ws helpers ---
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch(e){ log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj){
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

// --- channel filter ---
function isTextLikeChannel(ch){
  if (!ch) return false;
  if (typeof ch.isText === 'function') {
    try { return !!ch.isText(); } catch(e) {}
  }
  const textLike = new Set(['GUILD_TEXT','GUILD_NEWS','TEXT','NEWS','GUILD_FORUM','GUILD_PUBLIC_THREAD','GUILD_PRIVATE_THREAD']);
  const voiceOrCategory = new Set(['GUILD_VOICE','GUILD_STAGE_VOICE','GUILD_CATEGORY','VOICE','CATEGORY']);
  if (typeof ch.type === 'string') {
    if (voiceOrCategory.has(ch.type)) return false;
    if (textLike.has(ch.type)) return true;
  }
  if (typeof ch.type === 'number') {
    if (ch.type === 0 || ch.type === 5) return true; // text/news numeric ids
    return false;
  }
  return false;
}

// --- one-time cache build (optional) ---
async function ensureGuildsFetched(){
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    await client.guilds.fetch();
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 3000) await sleep(200);
  } catch(e){ log('guilds.fetch nonfatal', e && e.message ? e.message : e); }
}

async function buildCacheOnce(progressively=true){
  if (cacheBuilding) return;
  cacheBuilding = true;
  log('Building cache (one-time)');
  state.servers = [];
  await ensureGuildsFetched();
  for (const guild of Array.from(client.guilds.cache.values())) {
    try {
      try { await guild.channels.fetch(); } catch(e){}
      const channels = [];
      for (const [cid,ch] of guild.channels.cache) {
        if (isTextLikeChannel(ch)) channels.push({ id: ch.id, name: ch.name });
      }
      state.servers.push({ id: guild.id, name: guild.name, channels });
      if (progressively) broadcast({ type:'serverPartial', guild:{ id: guild.id, name: guild.name, channels } });
      log('Cached', guild.name, 'channels=', channels.length);
    } catch(e){ log('cache guild error', guild.id, e && e.message ? e.message : e); }
    await sleep(80);
  }
  state.cacheReady = true;
  broadcast({ type:'serverList', servers: state.servers });
  saveCacheDebounced();
  cacheBuilding = false;
  log('Cache built; cacheReady=true');
}

// --- pick display text ---
function pickDisplayText({ trimmed, embeds, attachments }) {
  if (trimmed && trimmed.length) return trimmed;
  if (Array.isArray(embeds) && embeds.length) {
    if (embeds[0].description) return embeds[0].description;
    if (embeds[0].title) return embeds[0].title;
  }
  if (Array.isArray(attachments) && attachments.length && attachments[0].url) return attachments[0].url;
  return '[no content]';
}

// --- message forwarding & ping detection ---
client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return;
    if (m.webhookId) return;
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) return;

    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g,'').trim();
    const attachments = [];
    if (m.attachments && m.attachments.size) for (const [,a] of m.attachments) if (a && a.url) attachments.push({ url:a.url, name:a.name||null });

    // dedupe per-channel
    const last = lastMessagePerChannel.get(m.channel.id);
    if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) return;
    lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });

    const displayText = pickDisplayText({ trimmed, embeds: m.embeds || [], attachments });
    const payload = {
      type: 'message',
      data: {
        messageId: m.id,
        rawContent: raw,
        trimmedContent: trimmed,
        displayText,
        attachments,
        author: { id: m.author?.id||'', username: m.author?.username||'', bot: !!m.author?.bot },
        guildId: m.guild.id,
        guildName: m.guild.name || '',
        channelId: m.channel.id,
        channelName: m.channel.name || '',
        timestamp: m.createdTimestamp || Date.now(),
        fromSelf: client.user && m.author && (m.author.id === client.user.id)
      }
    };

    broadcast(payload);

    // ping detection
    let pinged = false;
    if (client.user && m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') {
      try { pinged = m.mentions.users.has(client.user.id); } catch(e){}
    }
    if (pinged) {
      const pingPayload = {
        type: 'ping',
        data: {
          messageId: m.id,
          from: { id: m.author?.id||'', username: m.author?.username||'' },
          guildId: m.guild.id,
          guildName: m.guild.name || '',
          channelId: m.channel.id,
          channelName: m.channel.name || '',
          content: displayText,
          timestamp: m.createdTimestamp || Date.now()
        }
      };
      broadcast(pingPayload);
      log('Ping forwarded from', m.author && m.author.username);
    }
  } catch (err) { log('messageCreate error', err && err.message ? err.message : err); }
});

// --- robust send: DO NOT queue if discordConnected, only queue when discord NOT connected ---
async function handleSend(msg) {
  // msg: { guildId?, guildName?, channelId?, channelName?, content, ref? }
  const ref = msg.ref ? String(msg.ref) : null;
  if (ref && state.processedRefs.has(ref)) {
    log('Skipping already processed ref', ref);
    broadcast({ type:'ack', ok:true, ref, skipped:true });
    return { ok:true, skipped:true };
  }

  let channel = null;
  try {
    // direct by channelId first
    if (msg.channelId) {
      try { channel = await client.channels.fetch(String(msg.channelId)); } catch(e){ log('channel.fetch failed', e && e.message ? e.message : e); }
    }

    // otherwise find via guild
    if (!channel) {
      let guild = null;
      if (msg.guildId) {
        try { guild = await client.guilds.fetch(String(msg.guildId)); } catch(e){ log('guild.fetch by id failed', e && e.message ? e.message : e); }
      }
      if (!guild && msg.guildName) {
        guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName) || null;
      }
      if (!guild) throw new Error('Guild not found');

      try { await guild.channels.fetch(); } catch(e){ /* nonfatal */ }
      if (msg.channelId) channel = guild.channels.cache.get(String(msg.channelId));
      if (!channel && msg.channelName) {
        channel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && isTextLikeChannel(c));
      }
    }

    if (!channel || !('send' in channel)) throw new Error('Channel not found or not sendable');

    await channel.send(String(msg.content || ''));

    if (ref) { state.processedRefs.add(ref); saveCacheDebounced(); }

    broadcast({ type:'ack', ok:true, ref });
    log('Sent message to', channel.id, 'ref=', ref);
    return { ok:true, ref };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    log('handleSend error', err, 'ref=', ref);
    broadcast({ type:'ack', ok:false, ref, error: err });
    return { ok:false, error: err, ref };
  }
}

// --- queue processing (only used when discord not connected, or to retry) ---
async function processQueue(){
  if (processingQueue) return;
  processingQueue = true;
  log('processQueue start; len=', state.queue.length);
  try {
    while (state.queue.length > 0 && state.discordConnected) {
      const item = state.queue.shift();
      try {
        await handleSend(item.req);
        await sleep(120);
      } catch(e){ log('processQueue item error', e && e.message ? e.message : e); }
    }
  } finally {
    processingQueue = false;
    log('processQueue finished; remaining=', state.queue.length);
    saveCacheDebounced();
  }
}

// --- WebSocket server ---
const wss = new WebSocket.Server({ port: PORT }, () => log('WebSocket listening on', PORT));
loadCache();

wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected', req.socket.remoteAddress);

  // send immediate status: discordConnected matters for "discord ready"
  safeSend(ws, { type:'bridgeStatus', bridgeConnected:true, discordReady: !!state.discordConnected });
  safeSend(ws, { type:'ready', value: !!state.discordConnected }); // extension expects 'ready'
  if (state.servers.length) safeSend(ws, { type:'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ safeSend(ws, { type:'error', error:'bad-json' }); return; }

    if (msg.type === 'ping') { safeSend(ws, { type:'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList') {
      safeSend(ws, { type:'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'sendMessage') {
      if (!msg.ref) msg.ref = Date.now().toString();
      // if discord is connected, attempt send now (don't queue just because cache not ready)
      if (state.discordConnected) {
        const res = await handleSend(msg);
        // if handleSend failed for some reason (e.g., channel not found), reply already sent by handleSend
        // we only queue if discord not connected
      } else {
        // discord not connected -> queue for later
        if (!state.queue.find(q => q.req && q.req.ref === msg.ref)) {
          state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
          safeSend(ws, { type:'ack', ok:false, ref: msg.ref, queued:true, error:'queued-not-connected' });
          saveCacheDebounced();
          log('Queued send since discord not connected ref=', msg.ref);
        } else log('Already queued ref=', msg.ref);
      }
      return;
    }

    if (msg.type === 'refreshServers' || msg.type === 'forceRefresh') {
      // we intentionally do NOT auto-refresh; allow manual one-time refresh if you ask
      try {
        await buildCacheOnce(true);
      } catch(e){ log('manual buildCacheOnce failed', e && e.message ? e.message : e); }
      return;
    }

    safeSend(ws, { type:'error', error:'unknown-request', raw: msg });
  });

  ws.on('close', () => { sockets = sockets.filter(s => s !== ws); log('WS client disconnected'); });
  ws.on('error', e => log('ws error', e && e.message ? e.message : e));
});

// --- client login & ready handler ---
client.on('ready', async () => {
  try {
    log('Discord client ready as', client.user && (client.user.tag || client.user.username));
    state.discordConnected = true;

    // immediately broadcast discord-ready so extension shows true
    broadcast({ type:'ready', value: true });            // extension expects 'ready'
    broadcast({ type:'discordReady', data: { id: client.user?.id || null, username: client.user?.username || null } });

    // build cache once if no cached servers exist (non-blocking)
    if (!state.servers || state.servers.length === 0) {
      try { await buildCacheOnce(true); } catch(e){ log('buildCacheOnce failed', e && e.message ? e.message : e); }
    } else {
      // still broadcast cached server list
      safeSendAll({ type:'serverList', servers: state.servers });
    }

    // process queue now that we're connected
    if (state.queue.length > 0) processQueue().catch(e => log('processQueue error', e && e.message ? e.message : e));
  } catch (e) {
    log('ready handler error', e && e.message ? e.message : e);
  }
});

(async function startup(){
  try {
    await client.login(TOKEN);
    log('Attempted Discord login');
  } catch(e){
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
