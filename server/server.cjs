// server.cjs
// Robust Discord <-> TurboWarp bridge (CommonJS)
// Features:
//  - never auto-refresh cache after initial startup (unless you delete cache.json or call refreshServers manually)
//  - text-channel filtering (no VCs/categories)
//  - idempotent sends via ref (persisted processedRefs)
//  - queue only when Discord is NOT connected
//  - guarded queue processing with retries/backoff
//  - message events include displayText, attachments, timestamp, fromSelf
//  - ping events include who/channel/server/timestamp
//  - WebSocket heartbeat (hb/hb_ack) and stale-socket cleanup
//
// Requirements:
//   npm install discord.js-selfbot-v13 ws dotenv
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CACHE_FILE = path.join(__dirname, 'cache.json');

if (!TOKEN) {
  console.error('[bridge] ERROR: DISCORD_TOKEN (or TOKEN) not set. Exiting.');
  process.exit(1);
}

// Config
const SAVE_DEBOUNCE_MS = 800;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_STALE_MS = 60_000;
const DEDUPE_WINDOW_MS = 1500;
const MAX_SEND_RETRIES = 5;
const BASE_BACKOFF_MS = 400;

function log(...args) { console.log('[bridge]', ...args); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Defensive global error logging (don't crash on unexpected promise rejections)
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaughtException', err && (err.stack || err));
});
process.on('unhandledRejection', (err) => {
  console.error('[bridge] unhandledRejection', err && (err.stack || err));
});

// Discord client
const client = new Client({
  intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.MESSAGE_CONTENT]
});

// Runtime state
const state = {
  discordConnected: false,    // true when client.on('ready') fires
  cacheReady: false,          // true when the persisted/in-memory cache is available
  servers: [],                // [{ id, name, channels: [{id,name}] }]
  queue: [],                  // queued sends only when discord NOT connected: [{ req: msg, tries, queuedAt }]
  processedRefs: new Set()    // refs that were successfully sent (persisted)
};

let sockets = [];
let processingQueue = false;
let cacheBuilding = false;
const lastMessagePerChannel = new Map();
let _saveTimer = null;

// Persistence: load and save cache + processed refs
function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed) return false;
    state.servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    state.cacheReady = !!parsed.cacheReady;
    state.queue = Array.isArray(parsed.queue) ? parsed.queue : [];
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
      const toSave = {
        cacheReady: state.cacheReady,
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

// WebSocket helpers
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

// Channel filter helper (exclude voice & categories)
function isTextLikeChannel(ch) {
  if (!ch) return false;
  if (typeof ch.isText === 'function') {
    try { return !!ch.isText(); } catch (e) {}
  }
  // fallback string types and numeric ids
  const textLike = new Set(['GUILD_TEXT','GUILD_NEWS','TEXT','NEWS','GUILD_FORUM','GUILD_PUBLIC_THREAD','GUILD_PRIVATE_THREAD']);
  const voiceOrCategory = new Set(['GUILD_VOICE','GUILD_STAGE_VOICE','GUILD_CATEGORY','VOICE','CATEGORY']);
  if (typeof ch.type === 'string') {
    if (voiceOrCategory.has(ch.type)) return false;
    if (textLike.has(ch.type)) return true;
  }
  if (typeof ch.type === 'number') {
    // common numeric mapping: 0 = text, 2 = voice, 4 = category, 5 = news
    if (ch.type === 0 || ch.type === 5) return true;
    return false;
  }
  return false;
}

// Ensure guilds fetch
async function ensureGuildsFetched() {
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    log('guilds.cache empty — attempting client.guilds.fetch()');
    await client.guilds.fetch();
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 5000) await sleep(200);
  } catch (e) {
    log('client.guilds.fetch error (nonfatal):', e && e.message ? e.message : e);
  }
}

// One-time cache build (called at startup only if disk cache missing OR manual request)
async function buildCacheOnce({progressively = true} = {}) {
  if (cacheBuilding) { log('buildCacheOnce already running — skipping'); return; }
  cacheBuilding = true;
  log('Starting one-time cache build...');
  state.servers = [];
  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());
  for (let i = 0; i < guilds.length; i++) {
    const g = guilds[i];
    try {
      try { await g.channels.fetch(); } catch (e) { /* ignore */ }
      const channels = [];
      for (const [cid, ch] of g.channels.cache) {
        if (isTextLikeChannel(ch)) channels.push({ id: ch.id, name: ch.name });
      }
      state.servers.push({ id: g.id, name: g.name, channels });
      if (progressively) broadcast({ type: 'serverPartial', guild: { id: g.id, name: g.name, channels }});
      log('Cached', g.name, 'text-channels=', channels.length);
    } catch (e) {
      log('Error caching guild', g && g.id, e && e.message ? e.message : e);
    }
    if (i % 5 === 0) await sleep(120);
  }
  state.cacheReady = true;
  broadcast({ type: 'serverList', servers: state.servers });
  saveStateToDiskDebounced();
  cacheBuilding = false;
  log('One-time cache build complete; cacheReady=true; servers=', state.servers.length);
}

// Pick display text for forwarded messages
function pickDisplayText({ trimmed, embeds, attachments }) {
  if (trimmed && trimmed.length > 0) return trimmed;
  if (Array.isArray(embeds) && embeds.length) {
    if (embeds[0].description) return embeds[0].description;
    if (embeds[0].title) return embeds[0].title;
  }
  if (Array.isArray(attachments) && attachments.length && attachments[0].url) return attachments[0].url;
  return '[no content]';
}

// Message forwarding & ping detection
client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return; // ignore DMs
    if (m.webhookId) return; // ignore webhooks
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) return; // ignore other bots

    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g,'').trim();

    // attachments
    const attachments = [];
    if (m.attachments && m.attachments.size) {
      for (const [, a] of m.attachments) {
        if (a && a.url) attachments.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
      }
    }

    // embeds
    const embeds = (m.embeds || []).map(e => ({ title: e.title || null, description: e.description || null, type: e.type || null }));

    // mentions
    const mentions = [];
    if (m.mentions && m.mentions.users && typeof m.mentions.users.forEach === 'function') {
      m.mentions.users.forEach(u => mentions.push({ id: u.id, username: u.username }));
    }

    // dedupe per channel
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) return;
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch (e) { /* ignore */ }

    const displayText = pickDisplayText({ trimmed, embeds, attachments });
    const fromSelf = client.user && m.author && (m.author.id === client.user.id);

    const payload = {
      type: 'message',
      data: {
        messageId: m.id,
        rawContent: raw,
        trimmedContent: trimmed,
        contentLength: trimmed.length,
        displayText,
        attachments,
        embeds,
        mentions,
        isReply: !!(m.reference && (m.reference.messageId || m.reference.channelId)),
        author: { id: m.author?.id || '', username: m.author?.username || '', bot: !!m.author?.bot },
        guildId: m.guild.id,
        guildName: m.guild.name || '',
        channelId: m.channel.id,
        channelName: m.channel.name || '',
        timestamp: m.createdTimestamp || Date.now(),
        fromSelf
      }
    };

    broadcast(payload);

    // ping detection (mentions of our user)
    let pinged = false;
    if (client.user && m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') {
      try { pinged = m.mentions.users.has(client.user.id); } catch (e) { /* ignore */ }
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

// Sending (idempotent by ref). Called when discordConnected is true.
async function handleSendRequest(msg) {
  const ref = msg.ref ? String(msg.ref) : null;

  if (ref && state.processedRefs.has(ref)) {
    log('handleSendRequest: skipping already-processed ref', ref);
    broadcast({ type: 'ack', ok: true, ref, skipped: true });
    return { ok: true, skipped: true };
  }

  let targetChannel = null;
  try {
    // Try by channelId
    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch (e) { log('channel.fetch by id failed', e && e.message ? e.message : e); }
    }

    // otherwise try to resolve via guild
    if (!targetChannel) {
      let guild = null;
      if (msg.guildId) {
        guild = client.guilds.cache.get(String(msg.guildId)) || null;
      }
      if (!guild && msg.guildName) {
        guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName) || null;
      }
      if (!guild) throw new Error('Guild not found');

      try { await guild.channels.fetch(); } catch (e) { /* ignore */ }
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

    broadcast({ type: 'ack', ok: true, ref });
    log('handleSendRequest: sent message to', targetChannel.id, 'ref=', ref);
    return { ok: true, ref };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    log('handleSendRequest error', errMsg, 'ref=', ref);
    broadcast({ type: 'ack', ok: false, ref, error: errMsg });
    return { ok: false, error: errMsg, ref };
  }
}

// Queue processing (used only when discordConnected becomes true or to retry)
async function processQueue() {
  if (processingQueue) { log('processQueue already running — skip'); return; }
  processingQueue = true;
  log('processQueue starting. queueLen=', state.queue.length);

  try {
    while (state.queue.length > 0 && state.discordConnected) {
      const item = state.queue.shift();
      item.tries = item.tries ? item.tries : 0;
      const msg = item.req;
      const ref = msg.ref ? String(msg.ref) : null;

      if (ref && state.processedRefs.has(ref)) {
        log('processQueue skipping already processed ref', ref);
        broadcast({ type: 'ack', ok: true, ref, skipped: true });
        continue;
      }

      try {
        const res = await handleSendRequest(msg);
        if (res.ok) {
          await sleep(150);
          continue;
        } else {
          item.tries++;
          if (item.tries < MAX_SEND_RETRIES) {
            const backoff = BASE_BACKOFF_MS * Math.pow(2, Math.min(6, item.tries));
            log('processQueue requeueing ref=', ref, 'tries=', item.tries, 'backoff=', backoff);
            item.queuedAt = Date.now();
            state.queue.push(item);
            await sleep(backoff);
          } else {
            log('processQueue dropping item after retries ref=', ref);
            broadcast({ type: 'ack', ok: false, ref, error: 'max-retries' });
          }
        }
      } catch (e) {
        log('processQueue unexpected error', e && e.message ? e.message : e);
      }
    }
  } finally {
    processingQueue = false;
    log('processQueue finished; remaining queueLen=', state.queue.length);
    saveStateToDiskDebounced();
  }
}

// WebSocket server and heartbeat logic
const wss = new WebSocket.Server({ port: PORT }, () => log('WebSocket listening on 0.0.0.0:' + PORT));

loadCacheFromDisk();

// Accept connections
wss.on('connection', (ws, req) => {
  ws._lastSeen = Date.now();
  sockets.push(ws);
  log('[WS] Client connected', req.socket.remoteAddress);

  // send initial status & cache
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.discordConnected });
  safeSend(ws, { type: 'ready', value: !!state.discordConnected });
  if (state.servers.length > 0) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { safeSend(ws, { type: 'error', error: 'bad-json' }); return; }

    // app-level heartbeat ack
    if (msg.type === 'hb_ack') {
      ws._lastSeen = Date.now();
      return;
    }

    // ping/pong
    if (msg.type === 'ping') { safeSend(ws, { type: 'pong', ts: Date.now() }); return; }

    // get server list (no auto-rebuild)
    if (msg.type === 'getServerList') {
      safeSend(ws, { type: 'serverList', servers: state.servers });
      return;
    }

    // manual refresh (developer action) - optional one-time rebuild
    if (msg.type === 'refreshServers' || msg.type === 'forceRefresh') {
      try {
        await buildCacheOnce({progressively: true});
      } catch (e) { log('manual refresh failed', e && e.message ? e.message : e); }
      return;
    }

    // send message
    if (msg.type === 'sendMessage') {
      if (!msg.ref) msg.ref = Date.now().toString();
      // if discord connected, try immediate send (do not queue just because cache missing)
      if (state.discordConnected) {
        await handleSendRequest(msg);
      } else {
        // queue only when discord not connected
        if (!state.queue.find(q => q.req && q.req.ref === msg.ref)) {
          state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
          safeSend(ws, { type: 'ack', ok: false, ref: msg.ref, queued: true, error: 'queued-not-connected' });
          saveStateToDiskDebounced();
          log('Queued send since discord not connected ref=', msg.ref);
        } else {
          log('Send already queued ref=', msg.ref);
        }
      }
      return;
    }

    safeSend(ws, { type: 'error', error: 'unknown-request', raw: msg });
  });

  ws.on('close', () => {
    sockets = sockets.filter(s => s !== ws);
    log('[WS] Client disconnected');
  });

  ws.on('error', (err) => {
    log('[WS] socket error', err && err.message ? err.message : err);
    try { ws.terminate(); } catch (_) {}
  });
});

// Periodic server -> client heartbeat and stale-socket cleanup
setInterval(() => {
  const now = Date.now();
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // if no recent hb_ack, close it
    const last = ws._lastSeen || 0;
    if (now - last > HEARTBEAT_STALE_MS) {
      log('[WS] closing stale client (no hb_ack for', now - last, 'ms)');
      try { ws.terminate(); } catch (e) {}
      return;
    }
    // send hb -> client should respond with hb_ack
    try { ws.send(JSON.stringify({ type: 'hb' })); } catch (e) { log('[WS] hb send failed', e && e.message ? e.message : e); }
  });
}, HEARTBEAT_INTERVAL_MS);

// Discord client ready handler & startup
client.on('ready', async () => {
  try {
    log('[Discord] Ready as', client.user && (client.user.tag || client.user.username));
    state.discordConnected = true;

    // broadcast ready/discord info immediately so extension sees discordReady = true quickly
    broadcast({ type: 'ready', value: true });
    broadcast({ type: 'discordReady', data: { id: client.user?.id || null, username: client.user?.username || null } });

    // one-time cache build if we have no servers loaded from disk
    if (!state.servers || state.servers.length === 0) {
      try { await buildCacheOnce({progressively: true}); } catch (e) { log('buildCacheOnce failed', e && e.message ? e.message : e); }
    } else {
      // re-send cached serverList to new clients
      safeSendAll({ type: 'serverList', servers: state.servers });
    }

    // process queued sends now that discord is connected
    if (state.queue.length > 0) {
      processQueue().catch(e => log('processQueue error', e && e.message ? e.message : e));
    }
  } catch (e) {
    log('client.ready handler error', e && e.message ? e.message : e);
  }
});

(async function start() {
  try {
    await client.login(TOKEN);
    log('Discord login attempted');
  } catch (e) {
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
