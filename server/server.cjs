// server.cjs
// Discord <-> TurboWarp bridge with persistent cache, dedupe, queueing, and media links
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
const DEDUPE_WINDOW_MS = 1500; // ms to dedupe repeated message events

if (!PORT) {
  console.error('[bootstrap] PORT environment variable not set. Exiting.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('[bootstrap] DISCORD_TOKEN (or TOKEN) environment variable not set. Exiting.');
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
  ready: false,       // true after successful cache build
  servers: [],        // [{ id, name, channels: [{id, name}] }]
  queue: []           // queued send requests when not ready
};

let sockets = [];
let _saveTimer = null;
const lastMessagePerChannel = new Map(); // dedupe map: channelId -> { id, ts }

// -------------------- disk cache helpers --------------------
function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.servers)) {
        state.servers = parsed.servers;
        state.ready = !!parsed.ready;
        log('Loaded cache from disk:', CACHE_FILE, 'servers=', state.servers.length, 'ready=', state.ready);
        return true;
      }
    }
  } catch (e) {
    log('Failed loading cache from disk:', e && e.message ? e.message : e);
  }
  return false;
}

function saveCacheToDiskDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const tmp = CACHE_FILE + '.tmp';
      const toSave = { ready: state.ready, servers: state.servers };
      fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
      log('Saved cache to disk:', CACHE_FILE);
    } catch (e) {
      log('Failed to save cache to disk:', e && e.message ? e.message : e);
    }
  }, SAVE_DEBOUNCE_MS);
}

// -------------------- websocket helpers --------------------
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj){
  const msg = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// -------------------- Discord caching --------------------
async function ensureGuildsFetched() {
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    log('guilds.cache empty — attempting client.guilds.fetch()');
    await client.guilds.fetch(); // best-effort
    // wait briefly for cache to fill
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 5000) await sleep(200);
    log('guilds.cache size after fetch:', client.guilds.cache.size);
  } catch (e) {
    log('client.guilds.fetch() error (nonfatal):', e && e.message ? e.message : e);
  }
}

async function buildCache({progressively=true} = {}) {
  log('Starting cache build (progressively=' + !!progressively + ')');
  state.servers = [];

  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());

  for (let i=0; i < guilds.length; i++) {
    const guild = guilds[i];
    try {
      // populate channel cache for this guild
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

    // gentle pacing to avoid bursts
    if (i % 5 === 0) await sleep(120);
  }

  state.ready = true;
  broadcast({ type: 'ready', value: true });
  broadcast({ type: 'serverList', servers: state.servers });
  log('Cache build complete; ready=true; servers=', state.servers.length);
  saveCacheToDiskDebounced();
}

// -------------------- send/queue handling --------------------
async function handleSendRequest(msg, fromQueue=false) {
  const ref = msg.ref ?? null;
  try {
    let targetChannel = null;

    // prefer direct channelId if provided
    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch(e){ log('client.channels.fetch failed for id', msg.channelId, e && e.message ? e.message : e); }
    }

    if (!targetChannel) {
      // find guild by id or name
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(String(msg.guildId)) || client.guilds.cache.find(g => g.id === String(msg.guildId));
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');

      // ensure channels fetched for that guild
      try { await guild.channels.fetch(); } catch(e){ log('channels.fetch failed while sending', e && e.message ? e.message : e); }

      // find channel by id or name
      if (msg.channelId) targetChannel = guild.channels.cache.get(String(msg.channelId));
      if (!targetChannel && msg.channelName) {
        targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && typeof c.isText === 'function' && c.isText());
      }
    }

    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');

    const content = String(msg.content ?? '');
    await targetChannel.send(content);
    broadcast({ type: 'ack', ok: true, ref });
    log('Message sent to', targetChannel.id, 'ref=', ref);
    return true;
  } catch (e) {
    const errStr = e && e.message ? e.message : String(e);
    if (!state.ready && !fromQueue) {
      // queue the request for later replay
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
  if (!state.queue.length) return;
  log('Processing send queue (len=' + state.queue.length + ')');
  // simple FIFO replay
  const q = state.queue.splice(0);
  for (const item of q) {
    try {
      await handleSendRequest(item.req, true);
    } catch (e) {
      log('Queued send failed:', e && e.message ? e.message : e);
    }
    await sleep(250);
  }
}

// -------------------- WebSocket server --------------------
const wss = new WebSocket.Server({ port: PORT }, () => {
  log(`WebSocket listening on 0.0.0.0:${PORT}`);
});

wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected from', req.socket.remoteAddress);

  // immediate status (reflect current cache state)
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.ready });
  safeSend(ws, { type: 'ready', value: !!state.ready });

  // send cached server list (no recache on connect)
  if (state.servers.length > 0) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'ping') { safeSend(ws, { type: 'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList' || msg.type === 'getGuildChannels') {
      if (msg.force) {
        // force rebuild cache and send updates
        state.ready = false;
        broadcast({ type: 'ready', value: false });
        await buildCache({progressively:true});
        await processQueue();
        return;
      }
      safeSend(ws, { type: 'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'refreshServers' ) {
      state.ready = false;
      broadcast({ type: 'ready', value: false });
      await buildCache({progressively:true});
      await processQueue();
      return;
    }

    if (msg.type === 'sendMessage') {
      // msg should include: guildId/channelId OR guildName/channelName, content, ref optional
      await handleSendRequest(msg);
      return;
    }

    safeSend(ws, { type: 'error', error: 'unknown-request', raw: msg });
  });

  ws.on('close', () => {
    sockets = sockets.filter(s => s !== ws);
    log('Client disconnected');
  });

  ws.on('error', (err) => log('ws error', err && err.message ? err.message : err));
});

// -------------------- Forward Discord messages to WS (with filters + media links) --------------------
client.on('messageCreate', m => {
  try {
    // only care about guild messages (ignore DMs)
    if (!m.guild || !m.channel) return;

    // ignore messages sent by this client (prevent loop)
    if (client.user && m.author && m.author.id === client.user.id) return;

    // ignore other bots/webhooks by default; remove this line if you want bot messages
    if (m.author && m.author.bot) return;

    // ignore non-default system messages
    if (m.type && m.type !== 'DEFAULT' && m.type !== 0) return;

    // ignore truly empty messages (no text, no attachments, no embeds)
    const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
    const hasAttachments = m.attachments && m.attachments.size > 0;
    const hasEmbeds = m.embeds && m.embeds.length > 0;
    if (!hasText && !hasAttachments && !hasEmbeds) return;

    // dedupe per channel to avoid duplicates
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) {
        return; // duplicate within window
      }
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch (e) {
      // ignore dedupe map errors
    }

    // collect attachment URLs (images, files)
    const attachments = [];
    if (hasAttachments) {
      for (const [, att] of m.attachments) {
        if (att && att.url) attachments.push(att.url);
      }
    }

    // Build payload: include attachments array (may be empty)
    const payload = {
      type: 'message',
      data: {
        messageId: m.id,
        content: m.content || '',
        attachments, // array of URLs (images/files)
        embeds: (m.embeds || []).map(e => ({ type: e.type || null })), // small embed info
        author: { id: m.author?.id || '', username: m.author?.username || '' },
        guildId: m.guild.id,
        guildName: m.guild.name || '',
        channelId: m.channel.id,
        channelName: m.channel.name || '',
        timestamp: m.createdTimestamp || Date.now()
      }
    };

    broadcast(payload);
  } catch (err) {
    log('messageCreate handler error', err && err.message ? err.message : err);
  }
});

// -------------------- startup --------------------
(async function startup(){
  const loaded = loadCacheFromDisk();

  try {
    await client.login(TOKEN);
    log('Discord login success as', client.user && (client.user.username || client.user.tag));
  } catch (e) {
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }

  if (loaded) {
    log('Serving cached data from disk. Use refreshServers/force to rebuild if desired.');
    // optionally perform a background refresh; commented out by default
    // (async () => { try { await buildCache({progressively:false}); await processQueue(); } catch(e){ log('Background refresh failed', e); } })();
  } else {
    try {
      await buildCache({progressively:true});
      await processQueue();
    } catch (e) {
      log('Initial cache build failed:', e && e.message ? e.message : e);
    }
  }
})();
