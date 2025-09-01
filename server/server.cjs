// server.cjs
// Discord <-> TurboWarp bridge with echo of sent messages and ping detection
// Requires: npm i discord.js-selfbot-v13 ws dotenv
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!PORT) { console.error('[bootstrap] PORT not set. Exiting.'); process.exit(1); }
if (!TOKEN) { console.error('[bootstrap] DISCORD_TOKEN (or TOKEN) not set. Exiting.'); process.exit(1); }

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
  servers: [],      // [{id,name,channels:[{id,name}]}]
  queue: []         // queued send requests while not ready
};

let sockets = [];
const lastMessagePerChannel = new Map();
const DEDUPE_WINDOW_MS = 1500;

// -------------------- caching (startup) --------------------
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
  log('Starting cache build (progressively=' + !!progressively + ')');
  state.servers = [];
  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());

  for (let i=0;i<guilds.length;i++){
    const guild = guilds[i];
    try {
      try { await guild.channels.fetch(); } catch(e){ log('channels.fetch failed for', guild.id, e && e.message ? e.message : e); }

      const channels = [];
      for (const [cid, ch] of guild.channels.cache) {
        if (ch && typeof ch.isText === 'function' && ch.isText()) channels.push({ id: ch.id, name: ch.name });
      }

      state.servers.push({ id: guild.id, name: guild.name, channels });
      log(`Cached guild: ${guild.name} (${channels.length} channels)`);

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
}

// -------------------- ws helpers --------------------
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch(e){ log('safeSend failed', e && e.message ? e.message : e); }
}
function broadcast(obj){
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

// -------------------- send/queue --------------------
async function handleSendRequest(msg, fromQueue=false) {
  // msg: { guildId?, guildName?, channelId?, channelName?, content, ref? }
  const ref = msg.ref ?? null;
  try {
    let targetChannel = null;

    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch(e){ log('fetch channel by id failed', e && e.message ? e.message : e); }
    }

    if (!targetChannel) {
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(String(msg.guildId)) || client.guilds.cache.find(g => g.id === String(msg.guildId));
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');

      try { await guild.channels.fetch(); } catch(e){ log('guild.channels.fetch failed', e && e.message ? e.message : e); }

      if (msg.channelId) targetChannel = guild.channels.cache.get(String(msg.channelId));
      if (!targetChannel && msg.channelName) targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && typeof c.isText === 'function' && c.isText());
    }

    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');

    const content = String(msg.content ?? '');
    const sent = await targetChannel.send(content);

    // do not broadcast an immediate "echo" here; rely on messageCreate which will emit the message
    // ack success:
    safeSendAll({ type:'ack', ok:true, ref });
    log('Sent message to', targetChannel.id, 'ref=', ref);
    return true;
  } catch (e) {
    const errStr = e && e.message ? e.message : String(e);
    if (!state.ready && !fromQueue) {
      state.queue.push({ req: msg, tries: 0, queuedAt: Date.now() });
      safeSendAll({ type:'ack', ok:false, ref, queued:true, error:'queued-not-ready' });
      log('Send queued (not ready) ref=', ref);
      return false;
    } else {
      safeSendAll({ type:'ack', ok:false, ref, error: errStr });
      log('Send failed', errStr, 'ref=', ref);
      return false;
    }
  }
}

function safeSendAll(obj){
  const s = JSON.stringify(obj);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}

async function processQueue() {
  if (!state.queue.length) return;
  log('Processing send queue len=', state.queue.length);
  const q = state.queue.splice(0);
  for (const item of q){
    try { await handleSendRequest(item.req, true); } catch(e){ log('queued send failed', e && e.message ? e.message : e); }
    await sleep(250);
  }
}

// -------------------- message forwarding + ping detection --------------------
client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return;

    // allow own messages as well (we want to echo sent messages)
    // but skip messages generated by webhooks
    if (m.webhookId) return;

    // ignore bot messages except ourself (so bots won't flood)
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) return;

    // Normalize content data
    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g,'').trim();
    const contentLen = trimmed.length;

    // attachments -> urls
    const attachments = [];
    if (m.attachments && m.attachments.size) {
      for (const [, a] of m.attachments) {
        if (a && a.url) attachments.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
      }
    }

    const embeds = (m.embeds || []).map(e => ({ type: e.type || null, title: e.title || null }));
    const stickers = (m.stickers && m.stickers.size) ? Array.from(m.stickers.values()).map(s=>({id:s.id,name:s.name})) : [];
    const isReply = !!(m.reference && (m.reference.messageId || m.reference.channelId));
    let emptyReason = null;
    if (contentLen === 0) {
      if (attachments.length) emptyReason = 'attachments-only';
      else if (embeds.length) emptyReason = 'embeds-only';
      else if (stickers.length) emptyReason = 'stickers-only';
      else emptyReason = 'whitespace-or-zero-width';
    }

    let displayText = '';
    if (contentLen > 0) displayText = trimmed;
    else if (attachments.length) displayText = attachments[0].url;
    else if (embeds.length) displayText = '[embed] ' + (embeds[0].title || '');
    else if (stickers.length) displayText = '[sticker] ' + (stickers[0].name || '');
    else displayText = '[no content]';

    // dedupe
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now() - last.ts) < DEDUPE_WINDOW_MS) return;
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch(e){}

    const fromSelf = client.user && m.author && (m.author.id === client.user.id);
    const payload = {
      type: 'message',
      data: {
        messageId: m.id,
        rawContent: raw,
        trimmedContent: trimmed,
        contentLength,
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

    // ping detection: did the message mention our user id?
    let pinged = false;
    if (client.user) {
      try {
        // m.mentions.users is a Collection in v13
        if (m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') {
          pinged = m.mentions.users.has(client.user.id);
        }
      } catch(e){ log('ping detect error', e && e.message ? e.message : e); }
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

// -------------------- WebSocket server --------------------
const wss = new WebSocket.Server({ port: PORT }, () => log(`WebSocket listening on 0.0.0.0:${PORT}`));

wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected from', req.socket.remoteAddress);

  safeSend(ws, { type:'bridgeStatus', bridgeConnected:true, discordReady: !!state.ready });
  safeSend(ws, { type:'ready', value: !!state.ready });
  if (state.servers.length > 0) safeSend(ws, { type:'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if (msg.type === 'ping') { safeSend(ws, { type:'pong', ts: Date.now() }); return; }

    if (msg.type === 'getServerList' || msg.type === 'getGuildChannels') {
      if (msg.force) {
        state.ready = false;
        safeSendAll({ type:'ready', value:false });
        await buildCache({progressively:true});
        await processQueue();
        return;
      }
      safeSend(ws, { type:'serverList', servers: state.servers });
      return;
    }

    if (msg.type === 'refreshServers') {
      state.ready = false;
      safeSendAll({ type:'ready', value:false });
      await buildCache({progressively:true});
      await processQueue();
      return;
    }

    if (msg.type === 'sendMessage') {
      // expects: { guildId?, guildName?, channelId?, channelName?, content, ref? }
      await handleSendRequest(msg);
      return;
    }

    safeSend(ws, { type:'error', error:'unknown-request', raw: msg });
  });

  ws.on('close', () => { sockets = sockets.filter(s => s !== ws); log('Client disconnected'); });
  ws.on('error', e => log('ws error', e && e.message ? e.message : e));
});

// -------------------- startup --------------------
(async function start(){
  try {
    await client.login(TOKEN);
    log('Discord login success as', client.user && (client.user.username || client.user.tag));
  } catch (e) {
    log('Discord login failed:', e && e.message ? e.message : e);
    process.exit(1);
  }

  try {
    await buildCache({progressively:true});
    await processQueue();
  } catch (e) { log('Initial cache build error:', e && e.message ? e.message : e); }
})();
