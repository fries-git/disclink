// server.cjs
// Reliable Discord -> TurboWarp bridge: guaranteed displayText + attachments + mentions + ping detection
// Needs: npm i discord.js-selfbot-v13 ws dotenv
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client, Intents } = require('discord.js-selfbot-v13');

const PORT = Number(process.env.PORT || 3001);
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
if (!PORT) { console.error('[bridge] PORT not set'); process.exit(1); }
if (!TOKEN) { console.error('[bridge] DISCORD_TOKEN/TOKEN not set'); process.exit(1); }

function log(...args){ console.log('[bridge]', ...args); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.MESSAGE_CONTENT
  ]
});

// minimal runtime state (no recache-on-connect)
const state = { ready:false, servers:[], queue:[], processedRefs: new Set() };
let sockets = [];

// small dedupe
const lastMessagePerChannel = new Map();
const DEDUPE_WINDOW_MS = 1500;

// ws helpers
function safeSend(ws, obj){ try { ws.send(JSON.stringify(obj)); } catch(e){ log('safeSend failed', e && e.message ? e.message : e); } }
function broadcast(obj){ const s = JSON.stringify(obj); sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); }); }

// Fetch helper
async function ensureGuildsFetched(){
  if (client.guilds.cache && client.guilds.cache.size > 0) return;
  try {
    await client.guilds.fetch();
    const start = Date.now();
    while (client.guilds.cache.size === 0 && Date.now() - start < 5000) await sleep(200);
    log('guilds.cache size after fetch:', client.guilds.cache.size);
  } catch(e){
    log('ensureGuildsFetched error', e && e.message ? e.message : e);
  }
}

// build cache (called at startup or force)
async function buildCache(progressively=true){
  if (!client.guilds) return;
  state.servers = [];
  await ensureGuildsFetched();
  const guilds = Array.from(client.guilds.cache.values());
  for (let i=0;i<guilds.length;i++){
    const g = guilds[i];
    try {
      try { await g.channels.fetch(); } catch(e){}
      const channels = [];
      for (const [cid,ch] of g.channels.cache){
        if (ch && typeof ch.isText === 'function' && ch.isText()) channels.push({ id: ch.id, name: ch.name });
      }
      state.servers.push({ id: g.id, name: g.name, channels });
      if (progressively) broadcast({ type:'serverPartial', guild:{ id: g.id, name: g.name, channels }});
      log('Cached', g.name, 'channels=', channels.length);
    } catch(e){ log('cache guild error', e && e.message ? e.message : e); }
    if (i%5===0) await sleep(120);
  }
  state.ready = true;
  broadcast({ type:'ready', value:true });
  broadcast({ type:'serverList', servers: state.servers });
  log('Cache built. servers=', state.servers.length);
}

// safe small helper to pick best text to show
function pickDisplayText({ trimmed, embeds, attachments }){
  if (trimmed && trimmed.length > 0) return trimmed;
  // prefer embed description, then title
  if (Array.isArray(embeds) && embeds.length){
    if (embeds[0].description) return embeds[0].description;
    if (embeds[0].title) return embeds[0].title;
  }
  // prefer first attachment URL
  if (Array.isArray(attachments) && attachments.length){
    if (attachments[0].url) return attachments[0].url;
  }
  return '[no content]';
}

// handle messages: always include data with diagnostics and displayText
client.on('messageCreate', m => {
  try {
    if (!m.guild || !m.channel) return; // ignore DMs
    if (m.webhookId) return; // ignore webhooks

    // optionally ignore other bots (but allow ourself)
    if (m.author && m.author.bot && client.user && m.author.id !== client.user.id) return;

    const raw = typeof m.content === 'string' ? m.content : '';
    const trimmed = raw.replace(/\u200B/g,'').trim();
    const cLen = trimmed.length;

    const attachments = [];
    if (m.attachments && m.attachments.size){
      for (const [,a] of m.attachments){
        if (a && a.url) attachments.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
      }
    }

    const embeds = (m.embeds || []).map(e => ({ title: e.title || null, description: e.description || null, type: e.type || null }));

    const mentions = [];
    if (m.mentions && m.mentions.users && typeof m.mentions.users.forEach === 'function'){
      m.mentions.users.forEach(u => mentions.push({ id: u.id, username: u.username }));
    }

    const isReply = !!(m.reference && (m.reference.messageId || m.reference.channelId));

    // dedupe
    try {
      const last = lastMessagePerChannel.get(m.channel.id);
      if (last && last.id === m.id && (Date.now()-last.ts) < DEDUPE_WINDOW_MS) return;
      lastMessagePerChannel.set(m.channel.id, { id: m.id, ts: Date.now() });
    } catch(e){}

    const displayText = pickDisplayText({ trimmed, embeds, attachments });
    const fromSelf = client.user && m.author && (m.author.id === client.user.id);
    const pinged = (client.user && m.mentions && m.mentions.users && typeof m.mentions.users.has === 'function') ? m.mentions.users.has(client.user.id) : false;

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
        fromSelf,
        pinged
      }
    };

    broadcast(payload);

    // if pinged, send explicit ping event
    if (pinged){
      broadcast({
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
      });
    }
  } catch (err) {
    log('messageCreate error', err && err.message ? err.message : err);
  }
});

// basic sendMessage handling (ack + queue handled by your existing logic if present)
// accept sendMessage from clients and attempt send
async function handleSendFromClient(msg, ws){
  const ref = msg.ref ?? null;
  try {
    // prefer direct channelId if provided
    let targetChannel = null;
    if (msg.channelId) {
      try { targetChannel = await client.channels.fetch(String(msg.channelId)); } catch(e){}
    }
    if (!targetChannel) {
      let guild = null;
      if (msg.guildId) guild = client.guilds.cache.get(String(msg.guildId)) || client.guilds.cache.find(g => g.id === String(msg.guildId));
      if (!guild && msg.guildName) guild = client.guilds.cache.find(g => g.name === msg.guildName || g.id === msg.guildName);
      if (!guild) throw new Error('Guild not found');
      try { await guild.channels.fetch(); } catch(e){}
      if (msg.channelId) targetChannel = guild.channels.cache.get(String(msg.channelId));
      if (!targetChannel && msg.channelName) {
        targetChannel = guild.channels.cache.find(c => (c.name === msg.channelName || c.id === msg.channelName) && typeof c.isText === 'function' && c.isText());
      }
    }
    if (!targetChannel || !('send' in targetChannel)) throw new Error('Channel not found or not sendable');
    const content = String(msg.content ?? '');
    await targetChannel.send(content);
    safeSend(ws, { type:'ack', ok:true, ref });
    // we do NOT echo here — the messageCreate handler will send back the actual message with fromSelf=true
  } catch (e) {
    safeSend(ws, { type:'ack', ok:false, ref, error: e && e.message ? e.message : String(e) });
  }
}

// WebSocket server
const wss = new WebSocket.Server({ port: PORT }, () => log('WebSocket listening on 0.0.0.0:' + PORT));
wss.on('connection', (ws, req) => {
  sockets.push(ws);
  log('Client connected', req.socket.remoteAddress);

  // send status + cached servers (if any)
  safeSend(ws, { type: 'bridgeStatus', bridgeConnected: true, discordReady: !!state.ready });
  safeSend(ws, { type: 'ready', value: !!state.ready });
  if (state.servers.length) safeSend(ws, { type: 'serverList', servers: state.servers });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if (msg.type === 'getServerList') {
      if (msg.force) {
        state.ready = false;
        broadcast({ type:'ready', value:false });
        await buildCache(true);
      } else {
        safeSend(ws, { type:'serverList', servers: state.servers });
      }
      return;
    }

    if (msg.type === 'sendMessage') {
      await handleSendFromClient(msg, ws);
      return;
    }

    // ping/pong
    if (msg.type === 'ping') { safeSend(ws, { type:'pong', ts: Date.now() }); return; }

    safeSend(ws, { type:'error', error:'unknown-request', raw: msg });
  });

  ws.on('close', () => { sockets = sockets.filter(s => s !== ws); log('Client disconnected'); });
  ws.on('error', e => log('ws error', e && e.message ? e.message : e));
});

// startup: login + optional initial cache build (you can skip building to avoid rate usage)
(async function start(){
  try {
    await client.login(TOKEN);
    log('Discord logged in as', client.user && (client.user.username || client.user.tag));
  } catch(e){
    log('Discord login failed', e && e.message ? e.message : e);
    process.exit(1);
  }

  // build cache once at startup (progressively)
  try {
    await buildCache(true);
  } catch(e) {
    log('Initial cache build error', e && e.message ? e.message : e);
  }
})();
