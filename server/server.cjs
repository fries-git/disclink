// server.cjs
// Never-auto-refresh Discord <-> TurboWarp bridge
// - require: npm i discord.js-selfbot-v13 ws dotenv
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const SAVE_DEBOUNCE_MS = 800;
const DEDUPE_WINDOW_MS = 1500;

if (!TOKEN) {
  console.error('[bridge] ERROR: DISCORD_TOKEN (or TOKEN) is not set in env. Exiting.');
  process.exit(1);
}

function log(...args){ console.log('[bridge]', ...args); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.MESSAGE_CONTENT
  ]
});

// runtime state
const state = {
  ready: false,
  servers: [],               // [{id,name,channels:[{id,name}]}]
  queue: [],                 // queued send requests while not ready
  processedRefs: new Set()   // refs we have sent to avoid duplicates across restarts
};

let sockets = [];
let _saveTimer = null;
const lastMessagePerChannel = new Map();

// ----- persistence helpers -----
function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed) return false;
    state.servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    state.ready = !!parsed.ready;
    state.processedRefs = new Set(Array.isArray(parsed.processedRefs) ? parsed.processedRefs : []);
    log('Loaded cache from disk:', CACHE_FILE, 'servers=', state.servers.length, 'processedRefs=', state.processedRefs.size);
    return true;
  } catch (e) {
    log('Failed to load cache from disk:', e && e.message ? e.message : e);
    return false;
  }
}

function saveStateToDiskDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const tmp = CACHE_FILE + '.tmp';
      const out = {
        ready: state.ready,
        servers: state.servers,
        processedRefs: Array.from(state.processedRefs)
      };
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
      log('Saved cache/state to disk:', CACHE_FILE);
    } catch (e) {
      log('Failed to save cache to disk:', e && e.message ? e.message : e);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ----- websocket helpers -----
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

// ----- channel filtering helper (exclude voice & category) -----
function isTextLikeChannel(ch) {
  if (!ch) return false;
  if (typeof ch.isText === 'function') {
    try { return !!ch.isText(); } catch (e) {}
  }
  // fallback string types
  const textLike = new Set(['GUILD_TEXT','GUILD_NEWS','GUILD_PUBLIC_THREAD','GUILD_PRIVATE_THREAD','TEXT','NEWS','GUILD_FORUM']);
  const voiceOrCategory = new Set(['GUILD_VOICE','GUILD_STAGE_VOICE','GUILD_CATEGORY','VOICE','CATEGORY']);
  if (typeof ch.type === 'string') {
    if (voiceOrCategory.has(ch.type)) return false;
    if (textLike.has(ch.type)) return true;
  }
  if (typeof ch.type === 'number') {
    // 0 = text, 2 = voice, 4 = category, 5 = news (v13/v14 differences)
    if (ch.type === 0 || ch.type === 5) return true;
    return false;
  }
  return false;
}

// ----- cache builder (only run once if no cache on disk) -----
async function ensureGuildsFetched() {
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    log('guilds.cache empty — attempting client.guilds.fetch()');
    await client.guilds.fetch();
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 5000) await sleep(200);
  } catch (e){ log('ensureGuildsFetched error', e && e.message ? e.message : e); }
}

async function buildCacheOnce({progressively=true} = {}) {
  log('Building cache (one-time build)...');
  state.servers = [];
  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());
  for (let i=0;i<guilds.length;i++){
    const g = guilds[i];
    try {
      try { await g.channels.fetch(); } catch(e){}
      const channels = [];
      for (const [cid,ch] of g.channels.cache) {
        if (isTextLikeChannel(ch)) channels.push({ id: ch.id, name: ch.name });
      }
      state.servers.push({ id: g.id, name: g.name, channels });
      if (progressively) broadcast({ type:'serverPartial', guild: { id: g.id, name: g.name, channels } });
      log('Cached', g.name, 'text-channels=', channels.length);
    } catch (e) {
      log('Error caching guild', g && g.id, e && e.message ? e.message : e);
    }
    if (i % 5 === 0) await sleep(120);
  }
  state.ready = true;
  broadcast({ type:'ready', value:true });
  broadcast({ type:'serverList', servers: state.servers });
  saveStateToDiskDebounced();
  log('Cache build completed; ready=true; servers=', state.servers.length);
}

// ----- displayText helper -----
function pickDisplayText({ trimmed, embeds, attachments }) {
  if (trimmed && trimmed.length > 0) return trimmed;
  if (Array.isArray(embeds) && embeds.length) {
    if (embeds[0].description) return embeds[0].description;
    if (embeds[0].title) return embeds[0].title;
  }
  if (Array.isArray(attachments) && attachments.length && attachments[0].url) return attachments[0].url;
  return '[no content]';
}

// ----- message forwarding + ping detection -----
client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return; // ignore DMs
    if (m.webhookId) return; // ignore webhooks
    // ignore other bot messages (but allow ourself)
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) return;

    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g,'').trim();
    const cLen = trimmed.length;

    const attachments = [];
    if (m.attachments && m.attachments.size) {
      for (const [,a] of m.attachments) {
        if (a && a.url) attachments.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
      }
    }

    const embeds = (m.embeds || []).map(e => ({ title: e.title || null, description: e.description || null, type: e.type || null }));
    const mentions = [];
    if (m.mentions && m.mentions.users && typeof m.mentions.users.forEach === 'function') {
      m.mentions.users.forEach(u => mentions.push({ id: u.id, username: u.username }));
    }

    // dedupe per-channel
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) return;
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch (e) {}

    const displayText = pickDisplayText({ trimmed, embeds, attachments });
    const fromSelf = client.user && m.author && (m.author.id === client.user.id);

    // build outgoing payload
    const payload = {
      type: 'message',
      data: {
        messageId: m.id,
        rawContent: raw,
        trimmedContent: trimmed,
        contentLength: cLen,
        displayText,
        attachments,
        embeds,
        mentions,
        author: { id: m.author?.id || '', username: m.author?.username || '', bot: !!m.author?.bot },
        guildId: m.guild.id,
        guildName: m.guild.name || '',
        channelId: m.channel.id,
        channelName: m.channel.name || '',
        timestamp: m.createdTimestamp || Date.now(),
        fromSelf
      }
    };

    // broadcast message
    broadcast(payload);

    // ping detection (mentions of our user)
    let pinged = false;
    if (client.user && m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') {
      try { pinged = m.mentions.users.has(client.user.id); } catch (e) {}
    }

    if (pinged) {
      const pingPayload = {
        type: 'ping',
        data: {
          messageId: m.id,
          from: { id: m.author?.id || '', username: m.author?.username || '' },
          guildId: m.guild.id,
          guildName: m.guild.name || '',
          channelId: m.channel.id,
          channelName: m.channel.name || '',
          content: displayText,
          timestamp: m.createdTimestamp || Date.now()
        }
      };
      broadcast(pingPayload);
      log('Ping forwarded from', m.author && m.author.username, 'in', m.guild && m.guild.name);
    }

  } catch (err) {
    log('messageCreate handler error', err && err.message ? err.message : err);
  }
});

// ----- sending (idempotent by ref) -----
async function handleSendFromClient(msg) {
  const ref = msg.ref ? String(msg.ref) : null;
  if (ref && state.processedRefs.has(ref)) {
    log('Skipping already processed ref', ref);
    return { ok: true, skipped: true, ref };
  }

  try {
    let targetChannel = null;
    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch (e) { log('channel fetch by id failed', e && e.message ? e.message : e); }
    }

    if (!targetChannel) {
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(String(msg.guildId)) || client.guilds.cache.find(g => g.id === String(msg.guildId));
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');

      try { await guild.channels.fetch(); } catch(e) {}
      if (msg.channelId) targetChannel = guild.channels.cache.get(String(msg.channelId));
      if (!targetChannel && msg.channelName) {
        targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && isTextLikeChannel(c));
      }
    }

    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');

    await targetChannel.send(String(msg.content || ''));

    if (ref) {
      state.processedRefs.add(ref);
      saveStateToDiskDebounced();
    }

    return { ok: true, ref };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    return { ok: false, error: err, ref };
  }
}

// ----- WebSocket Server -----
const wss = new WebSocket.Server({ port: PORT }, () => log(`WebSocket listening on 0.0.0.0:${PORT}`));

// load disk cache (and processed refs) if available — we will NOT rebuild automatically after this
loadCacheFromDisk();

wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected', req.socket.remoteAddress);

  // immediate status + cached servers (no recache)
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.ready });
  safeSend(ws, { type: 'ready', value: !!state.ready });
  if (state.servers.length > 0) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { safeSend(ws, { type:'error', error:'bad-json' }); return; }

    if (msg.type === 'ping') { safeSend(ws, { type:'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList') {
      // server will not rebuild cache automatically — it only returns what it has on disk or built at startup
      safeSend(ws, { type:'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'sendMessage') {
      // ensure ref
      if (!msg.ref) msg.ref = Date.now().toString();
      const res = await handleSendFromClient(msg);
      if (res.ok) safeSend(ws, { type:'ack', ok:true, ref: res.ref, skipped: !!res.skipped });
      else safeSend(ws, { type:'ack', ok:false, ref: res.ref, error: res.error });
      return;
    }

    safeSend(ws, { type:'error', error:'unknown-request', raw: msg });
  });

  ws.on('close', () => { sockets = sockets.filter(s => s !== ws); log('Client disconnected'); });
  ws.on('error', e => log('ws error', e && e.message ? e.message : e));
});

// ----- startup -----
(async function startup() {
  try {
    await client.login(TOKEN);
    log('Discord logged in as', client.user && (client.user.username || client.user.tag));
  } catch (e) {
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }

  // If cache missing on disk, build once now and save it. After this, server will not refresh again.
  if (!state.servers || state.servers.length === 0) {
    try {
      await buildCacheOnce({progressively:true});
    } catch (e) {
      log('Initial cache build failed:', e && e.message ? e.message : e);
    }
  } else {
    log('Serving cached server list from disk. Will not rebuild automatically.');
  }
})();
