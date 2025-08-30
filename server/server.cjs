// server.cjs — robust incremental bridge (CommonJS)
// Requires: npm i discord.js-selfbot-v13 ws dotenv
require('dotenv').config();
const WebSocket = require('ws');
const { Client, Partials } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const client = new Client({ partials: [Partials.Channel] });
const wss = new WebSocket.Server({ port: PORT });
const sockets = new Set();

// simple per-guild channel cache: guildId -> { channels, fetchedAt }
const guildCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 3; // 3 minutes

function L(...args){ console.log('[bridge]', ...args); }

/** Wait until client is 'ready' or timeout (ms) */
function waitForClientReady(timeoutMs = 15000) {
  return new Promise(resolve => {
    if (client.user) return resolve(true);
    let done = false;
    const onReady = () => { if (!done) { done = true; client.removeListener('ready', onReady); resolve(true); } };
    client.once('ready', onReady);
    setTimeout(() => { if (!done) { done = true; client.removeListener('ready', onReady); resolve(false); } }, timeoutMs);
  });
}

/** Ensure guild cache is populated (best-effort) */
async function ensureGuildsCached(timeoutMs = 15000) {
  if (client.guilds && client.guilds.cache && client.guilds.cache.size > 0) return true;

  // wait for ready first
  const ready = await waitForClientReady(timeoutMs);
  if (!ready) {
    L('ensureGuildsCached: client not ready after wait');
  }

  // try explicit fetch (may or may not populate depending on lib/version)
  try {
    L('ensureGuildsCached: attempting client.guilds.fetch()');
    // client.guilds.fetch() can accept an ID or fetch all depending on implementation
    // call it and ignore errors — it's best-effort to populate cache.
    await client.guilds.fetch();
    // wait up to a short time for cache to appear
    const start = Date.now();
    while ((client.guilds.cache.size === 0) && (Date.now() - start < timeoutMs)) {
      await new Promise(r => setTimeout(r, 250));
    }
    L('ensureGuildsCached: cache size=', client.guilds.cache.size);
    return client.guilds.cache.size > 0;
  } catch (e) {
    L('ensureGuildsCached: fetch() failed (nonfatal):', e && e.message ? e.message : e);
    return client.guilds.cache.size > 0;
  }
}

/** Fetch channels for a single guild and cache them */
async function fetchGuildChannels(guild) {
  try {
    // attempt to fetch channels (discord.js: guild.channels.fetch())
    await guild.channels.fetch();
  } catch (e) {
    L(`fetchGuildChannels: guild.channels.fetch() failed for ${guild.name} (${guild.id}):`, e && e.message ? e.message : e);
  }

  try {
    const channels = [];
    for (const [id, ch] of guild.channels.cache) {
      if (!ch || typeof ch.name !== 'string') continue;
      channels.push({ id: ch.id, name: ch.name, type: ch.type });
    }
    guildCache.set(guild.id, { fetchedAt: Date.now(), channels });
    return { guildId: guild.id, guildName: guild.name, channels };
  } catch (e) {
    L('fetchGuildChannels: build channels failed for', guild.id, e && e.message ? e.message : e);
    return { guildId: guild.id, guildName: guild.name, channels: [] };
  }
}

/** Send incremental guild/channel data to a WS client */
async function sendGuildChannelsIncremental(ws, options = { forceRefresh: false, concurrency: 5 }) {
  try {
    if (!client.user) {
      const payload = { type: 'guildChannels', data: [], info: 'discord-not-ready' };
      try { ws.send(JSON.stringify(payload)); } catch(_) {}
      L('-> guildChannels: discord not ready');
      return;
    }

    // ensure guilds cached (best-effort)
    await ensureGuildsCached();

    const guilds = Array.from(client.guilds.cache.values());
    // send quick summary (id+name) to show servers fast
    try {
      const summary = guilds.map(g => ({ guildId: g.id, guildName: g.name }));
      ws.send(JSON.stringify({ type: 'guildSummary', data: summary }));
      L('-> guildSummary sent (', summary.length, ' )');
    } catch (e) { L('send guildSummary failed', e); }

    // process guilds in limited concurrency batches
    const concurrency = Math.max(1, options.concurrency || 5);
    let i = 0;
    while (i < guilds.length) {
      const batch = guilds.slice(i, i + concurrency);
      await Promise.all(batch.map(async (guild) => {
        try {
          const cached = guildCache.get(guild.id);
          const now = Date.now();
          if (!options.forceRefresh && cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
            // send cached partial
            try {
              ws.send(JSON.stringify({ type: 'guildChannelsPartial', guild: { guildId: guild.id, guildName: guild.name, channels: cached.channels } }));
              L(`-> guildChannelsPartial (cache) ${guild.name} (${guild.id}) channels=${cached.channels.length}`);
            } catch (e) { L('send cached partial failed', e); }
            return;
          }

          // fetch and send
          const data = await fetchGuildChannels(guild);
          try {
            ws.send(JSON.stringify({ type: 'guildChannelsPartial', guild: data }));
            L(`-> guildChannelsPartial fetched ${guild.name} (${guild.id}) channels=${data.channels.length}`);
          } catch (e) { L('send partial failed', e); }
        } catch (e) {
          L('guild batch item error', e && e.message ? e.message : e);
        }
      }));
      i += concurrency;
      // small pause to avoid bursty behavior (tuneable)
      await new Promise(r => setTimeout(r, 100));
    }

    // all done
    try {
      ws.send(JSON.stringify({ type: 'guildChannelsComplete', ts: Date.now() }));
      L('-> guildChannelsComplete');
    } catch (e) { L('send complete failed', e); }

  } catch (e) {
    L('sendGuildChannelsIncremental error', e && e.message ? e.message : e);
    try { ws.send(JSON.stringify({ type: 'guildChannels', error: String(e) })); } catch(_) {}
  }
}

/** Graceful send helper that logs failures */
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { L('safeSend failed', e && e.message ? e.message : e); }
}

/** Start WebSocket server behavior */
wss.on('connection', async (ws, req) => {
  sockets.add(ws);
  L('Client connected from', req.socket.remoteAddress);

  // initial bridge status
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!client.user });

  // send incremental guilds & channels (don't block)
  sendGuildChannelsIncremental(ws, { forceRefresh: false, concurrency: 5 }).catch(e => L('sendGuildChannelsIncremental crashed', e));

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { L('bad JSON from client', e); return; }
    L('<-', 'received', msg.type || '(unknown)');

    if (msg.type === 'ping') { safeSend(ws, { type: 'pong', ts: Date.now() }); return; }

    if (msg.type === 'getGuildChannels') {
      await sendGuildChannelsIncremental(ws, { forceRefresh: !!msg.force, concurrency: msg.concurrency || 5 });
      return;
    }

    if (msg.type === 'sendMessage') {
      // accept guildId/channelId (preferred) or fall back to names (compat)
      const { guildId, channelId, guildName, channelName, content } = msg;
      try {
        let targetChannelId = channelId;
        if (!targetChannelId) {
          // find guild id by name if provided
          let gid = guildId;
          if (!gid && guildName) {
            const g = client.guilds.cache.find(x => x.name === guildName || x.id === guildName);
            gid = g ? g.id : null;
          }
          if (!gid) throw new Error('Guild not specified or not found');

          // ensure channels cached for that guild
          const gobj = client.guilds.cache.get(gid);
          if (!gobj) throw new Error('Guild not in cache: ' + gid);
          try { await gobj.channels.fetch(); } catch(e) { L('channels.fetch failed in sendMessage', e && e.message ? e.message : e); }

          // find channel by name
          if (!channelId && channelName) {
            const ch = gobj.channels.cache.find(c => c.name === channelName || c.id === channelName);
            targetChannelId = ch ? ch.id : null;
          }
        }

        if (!targetChannelId) throw new Error('Channel not specified or not found');

        // fetch channel and send
        const channel = await client.channels.fetch(targetChannelId);
        if (!channel || !('send' in channel)) throw new Error('Channel not sendable');
        await channel.send(String(content || ''));
        safeSend(ws, { type: 'ack', ok: true, ref: msg.ref ?? null });
        L('Sent message to channel', targetChannelId);
      } catch (e) {
        L('sendMessage error', e && e.message ? e.message : e);
        safeSend(ws, { type: 'ack', ok: false, error: String(e), ref: msg.ref ?? null });
      }
      return;
    }

    // unknown
    safeSend(ws, { type: 'error', error: 'unknown-request', raw: msg });
  });

  ws.on('close', (code, reason) => {
    sockets.delete(ws);
    L(`Client disconnected (code=${code} reason=${String(reason)})`);
  });

  ws.on('error', (err) => {
    L('WS client error', err && err.message ? err.message : err);
  });
});

/** Forward Discord messages to connected clients */
client.on('messageCreate', msg => {
  const payload = {
    type: 'messageCreate',
    data: {
      messageId: msg.id,
      content: msg.content || '',
      author: { id: msg.author?.id || '', username: msg.author?.username || '' },
      channelId: msg.channel?.id || '',
      channelName: msg.channel?.name || '',
      guildId: msg.guild?.id || '',
      guildName: msg.guild?.name || '',
      createdTimestamp: msg.createdTimestamp || Date.now()
    }
  };
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      safeSend(ws, payload);
    }
  }
});

client.login(process.env.DISCORD_TOKEN).then(() => {
  L('Discord login attempt done (check ready event)');
}).catch(e => {
  L('Discord login failed (will not crash):', e && e.message ? e.message : e);
});

L(`[WS] Bridge listening on ws://localhost:${PORT}`);
