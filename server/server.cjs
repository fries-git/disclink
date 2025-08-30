// server.cjs — incremental, concurrency-limited guild/channel sender
require('dotenv').config();
const WebSocket = require('ws');
const { Client } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client();
const sockets = new Set();

function L(...args){ console.log('[bridge]', ...args); }

// Simple concurrency limiter
async function pMapLimit(inputs, mapper, limit = 5) {
  const results = [];
  const executing = [];
  for (const input of inputs) {
    const p = Promise.resolve().then(() => mapper(input));
    results.push(p);

    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing).catch(()=>{}); // wait for first to resolve
      // remove settled promises
      for (let i = executing.length - 1; i >= 0; --i) {
        if (executing[i].isFulfilled || executing[i].isRejected) {
          executing.splice(i, 1);
        }
      }
      // NOTE: Node Promises don't have isFulfilled by default. We wrap to mark settled below.
    }
  }
  return Promise.all(results);
}

// small wrapper to mark settled state (because plain Promise doesn't expose isFulfilled)
function makeTrackedPromise(p) {
  const t = { p, isSettled: false };
  t.p = p.then(
    (v) => { t.isSettled = true; return v; },
    (e) => { t.isSettled = true; throw e; }
  );
  return t;
}

// concurrency-limited mapper helper using tracked promises
async function mapWithLimit(items, mapper, limit = 5) {
  const results = [];
  const queue = []; // tracked promises
  for (const item of items) {
    const tracked = makeTrackedPromise(mapper(item));
    results.push(tracked.p);
    queue.push(tracked);
    if (queue.length >= limit) {
      // wait until one settles
      await Promise.race(queue.map(x => x.p)).catch(()=>{});
      // drop settled
      for (let i = queue.length - 1; i >= 0; --i) {
        if (queue[i].isSettled) queue.splice(i, 1);
      }
    }
  }
  return Promise.all(results);
}

// Simple in-memory cache: guildId -> { fetchedAt, channels: [{id,name,type}] }
const guildCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 3; // 3 minutes

async function ensureGuildsCached() {
  try {
    if (!client.guilds || client.guilds.cache.size === 0) {
      L('guild cache empty — attempting client.guilds.fetch()');
      try { await client.guilds.fetch(); } catch(e){ L('client.guilds.fetch() failed (nonfatal):', e && e.message ? e.message : e); }
    }
  } catch (e) { L('ensureGuildsCached error', e); }
}

// New: incremental send function
async function sendGuildChannelsIncremental(ws, options = { forceRefresh: false, concurrency: 5 }) {
  try {
    if (!client.user) {
      ws.send(JSON.stringify({ type: 'guildChannels', data: [], info: 'discord-not-ready' }));
      L('-> guildChannels: discord not ready');
      return;
    }

    await ensureGuildsCached();

    // Build lightweight guild summary to send immediately
    const guildSummaries = [];
    for (const [id, guild] of client.guilds.cache) {
      guildSummaries.push({ guildId: guild.id, guildName: guild.name });
    }

    // Send the fast summary so extension can show guild names quickly
    try {
      ws.send(JSON.stringify({ type: 'guildSummary', data: guildSummaries }));
      L('-> guildSummary (sent', guildSummaries.length, 'guilds)');
    } catch (e) {
      L('send guildSummary failed', e);
    }

    // Prepare list of guilds to fetch channels for
    const guildList = Array.from(client.guilds.cache.values());

    // mapper fetches channels for one guild and sends a partial message when ready
    const mapper = async (guild) => {
      const guildId = guild.id;
      // Use cache unless forceRefresh or expired
      const cached = guildCache.get(guildId);
      const now = Date.now();
      if (!options.forceRefresh && cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
        // send cached partial quickly
        try {
          ws.send(JSON.stringify({ type: 'guildChannelsPartial', guild: { guildId, guildName: guild.name, channels: cached.channels } }));
          L(`-> guildChannelsPartial (from cache) for ${guild.name} (${guild.id}) — ${cached.channels.length} channels`);
        } catch (e) { L('send cached partial failed', e); }
        return { guildId, fromCache: true };
      }

      // fetch channel cache for this guild
      try {
        await guild.channels.fetch();
      } catch (e) {
        L(`channels.fetch failed for guild ${guild.name} (${guild.id}):`, e && e.message ? e.message : e);
      }

      // gather text-like channels only (lightweight)
      const channels = guild.channels.cache
        .filter(c => c && typeof c.name === 'string')
        .map(c => ({ id: c.id, name: c.name, type: c.type }));

      // update cache
      guildCache.set(guildId, { fetchedAt: Date.now(), channels });

      // send partial for this guild
      try {
        ws.send(JSON.stringify({ type: 'guildChannelsPartial', guild: { guildId, guildName: guild.name, channels } }));
        L(`-> guildChannelsPartial for ${guild.name} (${guild.id}) — ${channels.length} channels`);
      } catch (e) {
        L('send partial failed', e);
      }

      return { guildId, fromCache: false };
    };

    // Process guilds with concurrency limit
    await mapWithLimit(guildList, mapper, options.concurrency || 5);

    // After all partials are sent, inform client we are done
    try {
      ws.send(JSON.stringify({ type: 'guildChannelsComplete', ts: Date.now() }));
      L('-> guildChannelsComplete');
    } catch (e) { L('send complete failed', e); }

  } catch (e) {
    L('sendGuildChannelsIncremental error', e && e.message ? e.message : e);
    try { ws.send(JSON.stringify({ type: 'guildChannels', error: String(e) })); } catch {}
  }
}
