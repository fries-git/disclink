// server.cjs
// Improved, idempotent Discord <-> TurboWarp bridge
// - persistent cache + processedRefs
// - queue processing guarded to avoid duplicate replays
// - displayText + attachments + ping detection
// - no recache on client connect
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
const SAVE_DEBOUNCE_MS = 1000;
const DEDUPE_WINDOW_MS = 1500;

if (!PORT) { console.error('[bootstrap] PORT env not set. Exiting.'); process.exit(1); }
if (!TOKEN) { console.error('[bootstrap] DISCORD_TOKEN (or TOKEN) env not set. Exiting.'); process.exit(1); }

function log(...args){ console.log('[bridge]', ...args); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

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
  servers: [],         // [{id, name, channels: [{id,name}]}]
  queue: [],           // [{ req, tries, queuedAt }]
  processedRefs: new Set() // refs that were already handled successfully
};

let sockets = [];
let _saveTimer = null;
let processingQueue = false;
const lastMessagePerChannel = new Map();

// -------------------- Disk persistence --------------------
function loadStateFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed) {
        if (Array.isArray(parsed.servers)) state.servers = parsed.servers;
        state.ready = !!parsed.ready;
        if (Array.isArray(parsed.processedRefs)) {
          state.processedRefs = new Set(parsed.processedRefs);
        } else {
          state.processedRefs = new Set();
        }
        log('Loaded cache from disk:', CACHE_FILE, 'servers=', state.servers.length, 'ready=', state.ready, 'processedRefs=', state.processedRefs.size);
        return true;
      }
    }
  } catch (e) {
    log('Failed to load state from disk:', e && e.message ? e.message : e);
  }
  return false;
}

function saveStateToDiskDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const tmp = CACHE_FILE + '.tmp';
      const toSave = {
        ready: state.ready,
        servers: state.servers,
        processedRefs: Array.from(state.processedRefs)
      };
      fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
      log('Saved cache/state to disk:', CACHE_FILE);
    } catch (e) {
      log('Failed to save state to disk:', e && e.message ? e.message : e);
    }
  }, SAVE_DEBOUNCE_MS);
}

// -------------------- WebSocket helpers --------------------
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj){
  const msg = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// -------------------- Discord cache & fetch --------------------
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

let cacheBuilding = false;
async function buildCache({progressively=true} = {}) {
  if (cacheBuilding) {
    log('buildCache called but cacheBuilding true — skipping duplicate build');
    return;
  }
  cacheBuilding = true;
  log('Starting cache build (progressively=' + !!progressively + ')');
  state.servers = [];

  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());

  for (let i = 0; i < guilds.length; i++) {
    const guild = guilds[i];
    try {
      try { await guild.channels.fetch(); } catch (e) { log(`guild.channels.fetch failed for ${guild.id}`, e && e.message ? e.message : e); }

      const channels = [];
      for (const [cid, ch] of guild.channels.cache) {
        if (ch && typeof ch.isText === 'function' && ch.isText()) {
          channels.push({ id: ch.id, name: ch.name });
        }
      }

      state.servers.push({ id: guild.id, name: guild.name, channels });
      log(`Cached guild: ${guild.name} (${guild.id}) channels=${channels.length}`);

      if (progressively) broadcast({ type: 'serverPartial', guild: { id: guild.id, name: guild.name, channels } });
    } catch (e) {
      log('Error caching guild', guild && guild.id, e && e.message ? e.message : e);
    }

    if (i % 5 === 0) await sleep(120);
  }

  state.ready = true;
  broadcast({ type: 'ready', value: true });
  broadcast({ type: 'serverList', servers: state.servers });
  log('Cache build complete; ready=true; servers=', state.servers.length);

  saveStateToDiskDebounced();
  cacheBuilding = false;
}

// -------------------- Send queue handling (idempotent) --------------------
async function handleSendRequest(msg, fromQueue=false) {
  // msg: { guildId?, guildName?, channelId?, channelName?, content, ref? }
  const ref = msg.ref ?? null;

  // if ref exists and already processed, skip
  if (ref && state.processedRefs.has(String(ref))) {
    log('Skipping send because ref already processed:', ref);
    // still ack as ok to client
    broadcast({ type: 'ack', ok: true, ref, skipped:true });
    return true;
  }

  try {
    let targetChannel = null;

    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch(e){ log('client.channels.fetch failed for id', msg.channelId, e && e.message ? e.message : e); }
    }

    if (!targetChannel) {
      // find guild
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(String(msg.guildId)) || client.guilds.cache.find(g => g.id === String(msg.guildId));
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');

      try { await guild.channels.fetch(); } catch(e){ log('guild.channels.fetch failed while sending', e && e.message ? e.message : e); }

      if (msg.channelId) targetChannel = guild.channels.cache.get(String(msg.channelId));
      if (!targetChannel && msg.channelName) {
        targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && typeof c.isText === 'function' && c.isText());
      }
    }

    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');

    const content = String(msg.content ?? '');
    const sent = await targetChannel.send(content);

    // mark processed if ref present
    if (ref) {
      state.processedRefs.add(String(ref));
      saveStateToDiskDebounced();
    }

    broadcast({ type: 'ack', ok: true, ref });
    log('Message sent to', targetChannel.id, 'ref=', ref);
    return true;
  } catch (e) {
    const errStr = e && e.message ? e.message : String(e);
    if (!state.ready && !fromQueue) {
      // queue it for later (FIFO)
      state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
      broadcast({ type: 'ack', ok: false, ref, queued: true, error: 'queued-not-ready' });
      log('Send queued (not ready) ref=', ref);
      return false;
    } else {
      broadcast({ type: 'ack', ok: false, ref, error: errStr });
      log('Send failed', errStr, 'ref=', ref);
      return false;
    }
  }
}

async function processQueue() {
  if (processingQueue) {
    log('processQueue called but already processing - ignoring duplicate call');
    return;
  }
  processingQueue = true;

  try {
    if (!state.queue.length) {
      processingQueue = false;
      return;
    }
    log('Processing send queue (len=' + state.queue.length + ')');

    // process a snapshot to avoid infinite loop if new items pushed concurrently
    const snapshot = state.queue.splice(0);
    for (const item of snapshot) {
      const { req, tries = 0 } = item;
      // skip if already processed by ref
      if (req.ref && state.processedRefs.has(String(req.ref))) {
        log('Skipping queued item, ref already processed:', req.ref);
        continue;
      }

      try {
        const ok = await handleSendRequest(req, true);
        if (!ok) {
          // handleSendRequest queued it (if not ready) or failed; we may retry depending on tries
          item.tries = (item.tries || 0) + 1;
          if ((item.tries || 0) < 5) {
            // requeue with incremented tries
            item.queuedAt = Date.now();
            state.queue.push(item);
            log('Requeued item (tries < 5) ref=', req.ref);
          } else {
            log('Dropping queued item after retries ref=', req.ref);
          }
        }
      } catch (e) {
        log('Queued item processing error', e && e.message ? e.message : e, 'ref=', req.ref);
      }

      await sleep(250);
    }
  } finally {
    processingQueue = false;
  }
}

// -------------------- message forwarding + ping detection --------------------
client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return;
    if (m.webhookId) return; // ignore webhooks

    // allow our own messages too (fromSelf flag included)
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) {
      // ignore other bots but allow ourself
      return;
    }

    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g, '').trim();
    const cLen = trimmed.length;

    const attachments = [];
    if (m.attachments && m.attachments.size) {
      for (const [, a] of m.attachments) {
        if (a && a.url) attachments.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
      }
    }

    const embeds = (m.embeds || []).map(e => ({ type: e.type || null, title: e.title || null }));
    const stickers = (m.stickers && m.stickers.size) ? Array.from(m.stickers.values()).map(s => ({ id: s.id, name: s.name })) : [];
    const isReply = !!(m.reference && (m.reference.messageId || m.reference.channelId));

    let emptyReason = null;
    if (cLen === 0) {
      if (attachments.length) emptyReason = 'attachments-only';
      else if (embeds.length) emptyReason = 'embeds-only';
      else if (stickers.length) emptyReason = 'stickers-only';
      else emptyReason = 'whitespace-or-zero-width';
    }

    let displayText = '';
    if (cLen > 0) displayText = trimmed;
    else if (attachments.length) displayText = attachments[0].url;
    else if (embeds.length) displayText = '[embed] ' + (embeds[0].title || '');
    else if (stickers.length) displayText = '[sticker] ' + (stickers[0].name || '');
    else displayText = '[no content]';

    // dedupe per-channel
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) return;
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch (e) { /* ignore */ }

    const fromSelf = client.user && m.author && (m.author.id === client.user.id);
    const payload = {
      type: 'message',
      data: {
        messageId: m.id,
        rawContent: raw,
        trimmedContent: trimmed,
        contentLength: cLen,
        emptyReason,
        displayText,
        attachments,
        embeds,
        stickers,
        author: { id: m.author?.id || '', username: m.author?.username || '', bot: !!m.author?.bot },
        guildId: m.guild.id,
        guildName: m.guild.name || '',
        channelId: m.channel.id,
        channelName: m.channel.name || '',
        isReply,
        timestamp: m.createdTimestamp || Date.now(),
        fromSelf
      }
    };

    // detect pings to our user
    let pinged = false;
    if (client.user) {
      try {
        if (m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') {
          pinged = m.mentions.users.has(client.user.id);
        }
      } catch (e) { log('ping detect error', e && e.message ? e.message : e); }
    }

    safeSendAll(payload);

    if (pinged) {
      const pingPayload = {
        type: 'ping',
        data: {
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
      log('Ping event forwarded from', m.author && m.author.username, 'in', m.guild && m.guild.name);
    }
  } catch (err) {
    log('messageCreate handler error', err && err.message ? err.message : err);
  }
});

function safeSendAll(obj) {
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

// -------------------- WebSocket server --------------------
const wss = new WebSocket.Server({ port: PORT }, () => {
  log(`WebSocket listening on 0.0.0.0:${PORT}`);
});

wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected from', req.socket.remoteAddress);

  // send immediate state (no recache on connect)
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.ready });
  safeSend(ws, { type: 'ready', value: !!state.ready });

  if (state.servers.length > 0) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if (msg.type === 'ping') { safeSend(ws, { type:'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList' || msg.type === 'getGuildChannels') {
      if (msg.force) {
        state.ready = false;
        broadcast({ type: 'ready', value: false });
        await buildCache({progressively:true});
        await processQueue();
        return;
      }
      safeSend(ws, { type: 'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'refreshServers') {
      state.ready = false;
      broadcast({ type: 'ready', value: false });
      await buildCache({progressively:true});
      await processQueue();
      return;
    }

    if (msg.type === 'sendMessage') {
      // if msg has ref and processedRefs contains it, reply ack immediately
      if (msg.ref && state.processedRefs.has(String(msg.ref))) {
        safeSend(ws, { type: 'ack', ok: true, ref: msg.ref, skipped: true });
        return;
      }
      // otherwise attempt send (may queue)
      await handleSendRequest(msg);
      // if state.ready is true and queue was processed we will later processQueue automatically in flow after build
      return;
    }

    safeSend(ws, { type: 'error', error: 'unknown-request', raw: msg });
  });

  ws.on('close', () => { sockets = sockets.filter(s => s !== ws); log('Client disconnected'); });
  ws.on('error', (err) => log('ws error', err && err.message ? err.message : err));
});

// -------------------- startup --------------------
(async function startup(){
  const loaded = loadStateFromDisk();

  try {
    await client.login(TOKEN);
    log('Discord login success as', client.user && (client.user.username || client.user.tag));
  } catch (e) {
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }

  // If we loaded disk cache, we serve it and don't rebuild automatically.
  if (loaded) {
    log('Serving cached data from disk. Use refreshServers/force to rebuild if desired.');
  } else {
    try {
      await buildCache({progressively:true});
    } catch (e) {
      log('Initial cache build failed:', e && e.message ? e.message : e);
    }
  }

  // After ready, process any queued sends once (guarded inside processQueue)
  if (state.ready) {
    await processQueue();
  }
})();
