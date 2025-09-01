// server.cjs
// Robust Discord <-> TurboWarp bridge
// Features:
// - binds exactly to process.env.PORT
// - loads/saves cache & processed refs to disk (cache.json)
// - filters out voice channels & categories from server lists
// - progressive caching, no recache on client connect
// - queued sends with idempotency (ref), persisted processedRefs
// - guarded queue processing (no repeated restarts)
// - forwards messages with displayText + attachments + ping detection
// - dedicated logging
//
// Requires: npm i discord.js-selfbot-v13 ws dotenv

'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const SAVE_DEBOUNCE_MS = 800;
const DEDUPE_WINDOW_MS = 1500;
const MAX_SEND_RETRIES = 5;
const BASE_BACKOFF_MS = 400;

if (!PORT) {
  console.error('[bridge] ERROR: PORT environment variable not set. Exiting.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('[bridge] ERROR: DISCORD_TOKEN (or TOKEN) environment variable not set. Exiting.');
  process.exit(1);
}

function log(...args){ console.log('[bridge]', ...args); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// discord client
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
  servers: [],         // [{ id, name, channels: [{id,name}] }]
  queue: [],           // [{ req: msg, tries: number, queuedAt: ts }]
  processedRefs: new Set()  // set of refs that were successfully sent
};

let sockets = [];
let processingQueue = false;
let cacheBuilding = false;
const lastMessagePerChannel = new Map();
let _saveTimer = null;

// ---------- disk persistence ----------
function loadStateFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed) return false;
    state.servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    state.ready = !!parsed.ready;
    state.queue = Array.isArray(parsed.queue) ? parsed.queue : [];
    state.processedRefs = new Set(Array.isArray(parsed.processedRefs) ? parsed.processedRefs : []);
    log('Loaded state from disk:', CACHE_FILE, 'servers=', state.servers.length, 'processedRefs=', state.processedRefs.size);
    return true;
  } catch (e) {
    log('Failed to load state from disk:', e && e.message ? e.message : e);
    return false;
  }
}

function saveStateToDiskDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const tmp = CACHE_FILE + '.tmp';
      const toSave = {
        ready: state.ready,
        servers: state.servers,
        queue: state.queue,
        processedRefs: Array.from(state.processedRefs)
      };
      fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
      log('Saved state to disk:', CACHE_FILE);
    } catch (e) {
      log('Failed to save state to disk:', e && e.message ? e.message : e);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ---------- websocket helpers ----------
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); }
  catch (e) { log('safeSend failed', e && e.message ? e.message : e); }
}
function safeSendAll(obj) {
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}
function broadcast(obj) { safeSendAll(obj); }

// ---------- channel/filter helpers ----------
function isTextLikeChannel(ch) {
  if (!ch) return false;
  // prefer runtime check
  if (typeof ch.isText === 'function') {
    try { return !!ch.isText(); } catch(e) {}
  }
  // fallback string types (v13/v14 differences)
  const textLike = new Set(['GUILD_TEXT','GUILD_NEWS','GUILD_PUBLIC_THREAD','GUILD_PRIVATE_THREAD','TEXT','NEWS','GUILD_FORUM']);
  const voiceOrCategory = new Set(['GUILD_VOICE','GUILD_STAGE_VOICE','GUILD_CATEGORY','VOICE','CATEGORY']);
  if (typeof ch.type === 'string') {
    if (voiceOrCategory.has(ch.type)) return false;
    if (textLike.has(ch.type)) return true;
  }
  if (typeof ch.type === 'number') {
    // common numeric mapping: 0 = text, 2 = voice, 13 = stage, 4 = category; 5 = news
    if (ch.type === 0 || ch.type === 5) return true;
    return false;
  }
  // conservative default: exclude
  return false;
}

// ---------- caching ----------
async function ensureGuildsFetched() {
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    log('guilds.cache empty — attempting client.guilds.fetch()');
    await client.guilds.fetch();
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 5000) await sleep(200);
    log('guilds.cache size after fetch:', client.guilds.cache.size);
  } catch (e) {
    log('client.guilds.fetch() error (nonfatal):', e && e.message ? e.message : e);
  }
}

async function buildCache({progressively=true} = {}) {
  if (cacheBuilding) { log('buildCache already running — skipping'); return; }
  cacheBuilding = true;
  log('Starting cache build (progressively=' + !!progressively + ')');

  state.servers = [];
  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());

  for (let i = 0; i < guilds.length; i++) {
    const guild = guilds[i];
    try {
      try { await guild.channels.fetch(); } catch(e) { /* ignore */ }
      const channels = [];
      for (const [cid, ch] of guild.channels.cache) {
        if (isTextLikeChannel(ch)) channels.push({ id: ch.id, name: ch.name });
      }
      state.servers.push({ id: guild.id, name: guild.name, channels });
      log(`Cached guild: ${guild.name} (${channels.length} text channels)`);
      if (progressively) broadcast({ type: 'serverPartial', guild: { id: guild.id, name: guild.name, channels } });
    } catch (e) {
      log('Error caching guild', guild && guild.id, e && e.message ? e.message : e);
    }
    if (i % 5 === 0) await sleep(120);
  }

  state.ready = true;
  broadcast({ type: 'ready', value: true });
  broadcast({ type: 'serverList', servers: state.servers });
  saveStateToDiskDebounced();
  log('Cache build complete; ready=true; servers=', state.servers.length);
  cacheBuilding = false;
}

// ---------- sending / queue handling (idempotent) ----------
async function handleSendRequest(msg, fromQueue = false) {
  // msg: { guildId?, guildName?, channelId?, channelName?, content, ref? }
  const ref = msg.ref ? String(msg.ref) : null;
  if (ref && state.processedRefs.has(ref)) {
    log('handleSendRequest: skipping already-processed ref', ref);
    broadcast({ type: 'ack', ok: true, ref, skipped: true });
    return true;
  }

  let targetChannel = null;
  try {
    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch(e) { log('fetch channelId failed', e && e.message ? e.message : e); }
    }

    if (!targetChannel) {
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(String(msg.guildId)) || client.guilds.cache.find(g => g.id === String(msg.guildId));
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');

      try { await guild.channels.fetch(); } catch(e) { /* ignore */ }

      if (msg.channelId) targetChannel = guild.channels.cache.get(String(msg.channelId));
      if (!targetChannel && msg.channelName) {
        targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && isTextLikeChannel(c));
      }
    }

    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');

    const content = String(msg.content ?? '');
    await targetChannel.send(content);

    if (ref) {
      state.processedRefs.add(ref);
      saveStateToDiskDebounced();
    }

    broadcast({ type: 'ack', ok: true, ref });
    log('handleSendRequest: sent message to', targetChannel.id, 'ref=', ref);
    return true;
  } catch (e) {
    const errStr = e && e.message ? e.message : String(e);
    log('handleSendRequest error', errStr, 'ref=', ref);
    if (!state.ready && !fromQueue) {
      // not ready -> queue
      if (!state.queue.find(q => q.req && q.req.ref === ref)) {
        state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
        broadcast({ type: 'ack', ok: false, ref, queued: true, error: 'queued-not-ready' });
        saveStateToDiskDebounced();
        log('Queued send (not ready) ref=', ref);
      } else {
        log('Already queued (not ready) ref=', ref);
      }
      return false;
    }
    // otherwise failure — let processQueue handle retries if it came from queue
    return false;
  }
}

async function processQueue() {
  if (processingQueue) { log('processQueue already in progress — skipping'); return; }
  processingQueue = true;
  log('processQueue: starting. queueLen=', state.queue.length);

  try {
    while (state.queue.length > 0) {
      const item = state.queue.shift();
      const msg = item.req;
      item.tries = item.tries ? item.tries : 0;
      const ref = msg.ref ? String(msg.ref) : null;

      if (ref && state.processedRefs.has(ref)) {
        log('processQueue: skipping already processed ref', ref);
        broadcast({ type: 'ack', ok: true, ref, skipped: true });
        continue;
      }

      try {
        const ok = await handleSendRequest(msg, true);
        if (ok) {
          // success: small delay and continue
          await sleep(150);
          continue;
        } else {
          // not OK -> retry logic
          item.tries = (item.tries || 0) + 1;
          if (item.tries < MAX_SEND_RETRIES) {
            const backoff = BASE_BACKOFF_MS * Math.pow(2, Math.min(6, item.tries));
            log('processQueue: requeueing ref=', ref, 'tries=', item.tries, 'backoff=', backoff);
            item.queuedAt = Date.now();
            state.queue.push(item);
            await sleep(backoff);
          } else {
            log('processQueue: dropping item after retries ref=', ref);
            broadcast({ type: 'ack', ok: false, ref, error: 'max-retries' });
          }
        }
      } catch (e) {
        log('processQueue: unexpected error', e && e.message ? e.message : e);
      }
    }
  } finally {
    processingQueue = false;
    log('processQueue: finished. queueLen=', state.queue.length);
    saveStateToDiskDebounced();
  }
}

// ---------- message forwarding & ping detection ----------
function pickDisplayText({ trimmed, embeds, attachments }) {
  if (trimmed && trimmed.length > 0) return trimmed;
  if (Array.isArray(embeds) && embeds.length) {
    if (embeds[0].description) return embeds[0].description;
    if (embeds[0].title) return embeds[0].title;
  }
  if (Array.isArray(attachments) && attachments.length) {
    if (attachments[0].url) return attachments[0].url;
  }
  return '[no content]';
}

client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return; // ignore DMs
    if (m.webhookId) return; // ignore webhooks
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) return; // ignore other bots

    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g, '').trim();
    const cLen = trimmed.length;

    const attachments = [];
    if (m.attachments && m.attachments.size) {
      for (const [, a] of m.attachments) {
        if (a && a.url) attachments.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
      }
    }

    const embeds = (m.embeds || []).map(e => ({ title: e.title || null, description: e.description || null, type: e.type || null }));
    const mentions = [];
    if (m.mentions && m.mentions.users && typeof m.mentions.users.forEach === 'function') {
      m.mentions.users.forEach(u => mentions.push({ id: u.id, username: u.username }));
    }
    const isReply = !!(m.reference && (m.reference.messageId || m.reference.channelId));

    // dedupe
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) return;
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch (e) {}

    const displayText = pickDisplayText({ trimmed, embeds, attachments });
    const fromSelf = client.user && m.author && (m.author.id === client.user.id);

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
        isReply,
        author: { id: m.author?.id || '', username: m.author?.username || '', bot: !!m.author?.bot },
        guildId: m.guild.id,
        guildName: m.guild.name || '',
        channelId: m.channel.id,
        channelName: m.channel.name || '',
        timestamp: m.createdTimestamp || Date.now(),
        fromSelf
      }
    };

    // detect pings to our user
    let pinged = false;
    if (client.user && m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') {
      try { pinged = m.mentions.users.has(client.user.id); } catch (e) {}
    }

    safeSendAll(payload);

    if (pinged) {
      const pingPayload = {
        type: 'ping',
        data: {
          messageId: m.id,
          from: { id: m.author?.id || '', username: m.author?.username || '' },
          content: displayText,
          guildId: m.guild.id,
          guildName: m.guild.name || '',
          channelId: m.channel.id,
          channelName: m.channel.name || '',
          timestamp: m.createdTimestamp || Date.now()
        }
      };
      safeSendAll(pingPayload);
      log('Ping forwarded from', m.author && m.author.username, 'in', m.guild && m.guild.name);
    }

  } catch (err) {
    log('messageCreate handler error', err && err.message ? err.message : err);
  }
});

// ---------- WebSocket server ----------
const wss = new WebSocket.Server({ port: PORT }, () => {
  log(`WebSocket listening on 0.0.0.0:${PORT}`);
});

// Load persisted cache & processedRefs if any
loadStateFromDisk();

wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected from', req.socket.remoteAddress);

  // immediate status & cached list (no recache)
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.ready });
  safeSend(ws, { type: 'ready', value: !!state.ready });
  if (state.servers.length > 0) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { log('Bad JSON from WS client'); return; }

    if (msg.type === 'ping') { safeSend(ws, { type: 'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList' || msg.type === 'getGuildChannels') {
      if (msg.force) {
        // explicit client-initiated force refresh
        state.ready = false;
        broadcast({ type: 'ready', value: false });
        await buildCache({progressively: true});
        // after cache built, process queue once
        if (!processingQueue) processQueue().catch(e => log('processQueue crash', e && e.message));
        return;
      }
      safeSend(ws, { type: 'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'refreshServers') {
      state.ready = false;
      broadcast({ type: 'ready', value: false });
      await buildCache({progressively: true});
      if (!processingQueue) processQueue().catch(e => log('processQueue crash', e && e.message));
      return;
    }

    if (msg.type === 'sendMessage') {
      // ensure a ref (idempotency)
      if (!msg.ref) msg.ref = Date.now().toString();
      // immediate attempt
      if (state.ready) {
        const ok = await handleSendRequest(msg, false);
        if (!ok) {
          // if immediate failed, ensure in queue
          if (!state.queue.find(q => q.req && q.req.ref === msg.ref)) {
            state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
            log('sendMessage: pushed to queue after immediate failure ref=', msg.ref);
            saveStateToDiskDebounced();
          }
          if (!processingQueue) processQueue().catch(e => log('processQueue crash', e && e.message));
        }
      } else {
        // not ready -> queue
        if (!state.queue.find(q => q.req && q.req.ref === msg.ref)) {
          state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
          broadcast({ type: 'ack', ok: false, ref: msg.ref, queued: true, error: 'queued-not-ready' });
          saveStateToDiskDebounced();
          log('sendMessage: queued (not ready) ref=', msg.ref);
        } else {
          log('sendMessage: already queued ref=', msg.ref);
        }
      }
      return;
    }

    safeSend(ws, { type: 'error', error: 'unknown-request', raw: msg });
  });

  ws.on('close', () => { sockets = sockets.filter(s => s !== ws); log('Client disconnected'); });
  ws.on('error', (err) => log('ws error', err && err.message ? err.message : err));
});

// ---------- startup ----------
(async function startup() {
  try {
    await client.login(TOKEN);
    log('Discord login success as', client.user && (client.user.username || client.user.tag));
  } catch (e) {
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }

  // if no cache on disk, build once
  if (!state.servers || state.servers.length === 0) {
    try {
      await buildCache({progressively: true});
    } catch (e) {
      log('Initial cache build failed:', e && e.message ? e.message : e);
    }
  } else {
    log('Serving cached server list from disk; use refreshServers to force rebuild.');
  }

  // After starting up and being ready, process queue once
  if (state.ready && state.queue.length > 0 && !processingQueue) {
    processQueue().catch(e => log('processQueue crash', e && e.message));
  }
})();