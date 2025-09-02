// disclinkextension.js
class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.VERSION = '4.1.1-heartbeat';
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.channels = {};
    this._lastMessage = {};
    this._lastPing = {};
    this._pendingMessage = false;
    this._pendingPing = false;

    // reconnect/backoff state
    this.reconnectBase = 1000;    // 1s
    this.reconnectMax = 30_000;   // 30s
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;

    // heartbeat
    this.clientHeartbeatInterval = 20_000; // send app-level ping to server optionally
    this._clientHbTimer = null;
  }

  getInfo() {
    return {
      id: 'disclink',
      name: 'Discord Link',
      color1: '#7289DA',
      blocks: [
        { opcode: 'connect', blockType: 'command', text: 'connect to bridge [URL]', arguments: { URL: { type: 'string', defaultValue: 'ws://localhost:3001' } } },
        // ... other blocks remain unchanged; you can paste your previous getInfo blocks here
      ]
    };
  }

  _log(...args) { try { console.log('[DiscordLink ext]', ...args); } catch (e) {} }

  // --- connect with backoff + jitter ---
  connect({ URL }) {
    // clear any previous reconnect timer
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    // close existing socket cleanly
    if (this.ws) {
      try { this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null; this.ws.close(); } catch(e) {}
      this.ws = null;
    }

    this.url = URL;
    this._createSocket();
  }

  _createSocket() {
    // create new socket
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._log('ws open');
      this.connected = true;
      this.reconnectAttempts = 0; // reset backoff on successful connect

      // ask for data immediately
      try { this.ws.send(JSON.stringify({ type: 'getServerList' })); } catch (e) {}

      // start client heartbeat (optional)
      if (this._clientHbTimer) clearInterval(this._clientHbTimer);
      this._clientHbTimer = setInterval(() => {
        try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'hb_ack' })); } catch (e) {}
      }, this.clientHeartbeatInterval);
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { this._log('parse fail', e); return; }

      // If server requests heartbeat, reply immediately
      if (msg.type === 'hb') {
        try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'hb_ack' })); } catch (e) {}
        return;
      }

      // Normal messages follow existing semantics
      if (msg.type === 'bridgeStatus') this.connected = !!msg.bridgeConnected;
      if (msg.type === 'ready') this.discordReady = !!msg.value;
      if (msg.type === 'serverList') {
        this.guilds = (msg.servers || []).map(s => ({ id: s.id, name: s.name }));
        this.channels = {};
        (msg.servers || []).forEach(s => this.channels[s.id] = (s.channels || []).map(c => ({ id: c.id, name: c.name })));
      }

      if (msg.type === 'message') {
        const d = msg.data || {};
        const visible = String(d.displayText ?? d.trimmedContent ?? d.rawContent ?? '').trim();
        const attachments = Array.isArray(d.attachments) ? d.attachments : [];
        const firstAttachment = attachments.length ? (attachments[0].url || '') : '';

        this._lastMessage = {
          content: visible || (firstAttachment || '[no content]'),
          channelName: String(d.channelName || ''),
          guildName: String(d.guildName || ''),
          authorName: String(d.author?.username || ''),
          authorId: String(d.author?.id || ''),
          timestamp: d.timestamp || Date.now(),
          firstAttachmentUrl: firstAttachment,
          fromSelf: !!d.fromSelf,
          rawContent: String(d.rawContent || '')
        };

        this._pendingMessage = true;
        try { if (this.runtime && typeof this.runtime.startHats === 'function') this.runtime.startHats('whenMessageReceived', {}); } catch (e) {}
      }

      if (msg.type === 'ping') {
        const d = msg.data || {};
        this._lastPing = {
          pinged: true,
          from: String(d.from?.username || ''),
          fromId: String(d.from?.id || ''),
          guildName: String(d.guildName || ''),
          channelName: String(d.channelName || ''),
          content: String(d.content || ''),
          timestamp: d.timestamp || Date.now()
        };
        this._pendingPing = true;
        try { if (this.runtime && typeof this.runtime.startHats === 'function') this.runtime.startHats('whenPinged', {}); } catch (e) {}
      }

      // handle ack/pong types if needed...
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev && ev.code, ev && ev.reason);
      this._cleanupSocket();
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      this._log('ws error', err && err.message ? err.message : err);
      // socket will likely close and onclose will schedule reconnect
    };
  }

  _cleanupSocket() {
    this.connected = false;
    this.discordReady = false;
    if (this._clientHbTimer) { clearInterval(this._clientHbTimer); this._clientHbTimer = null; }
    if (this.ws) {
      try { this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null; } catch(e){}
      try { this.ws.close(); } catch(e){}
      this.ws = null;
    }
  }

  _scheduleReconnect() {
    this.reconnectAttempts = Math.min(30, (this.reconnectAttempts || 0) + 1);
    const base = Math.min(this.reconnectBase * Math.pow(2, this.reconnectAttempts - 1), this.reconnectMax);
    // add jitter 0..500ms
    const jitter = Math.floor(Math.random() * 500);
    const delay = Math.max(500, base + jitter);
    this._log('scheduling reconnect in', delay, 'ms (attempt', this.reconnectAttempts, ')');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this._createSocket();
    }, delay);
  }

  // ... implement the rest of your blocks exactly as you had them (sendMessage, reporters, hats) ...
  // For brevity, I will include the key hat consumption functions here:

  whenMessageReceived() {
    if (this._pendingMessage) { this._pendingMessage = false; return true; }
    return false;
  }
  lastMessage() { return String(this._lastMessage.content || ''); }
  lastMessageAttachment() { return String(this._lastMessage.firstAttachmentUrl || ''); }
  lastMessageChannel() { return String(this._lastMessage.channelName || ''); }
  lastMessageServer() { return String(this._lastMessage.guildName || ''); }
  lastMessageAuthor() { return String(this._lastMessage.authorName || ''); }
  lastMessageTimestamp() { return String(this._lastMessage.timestamp || ''); }

  whenPinged() {
    if (this._pendingPing) { this._pendingPing = false; return true; }
    return false;
  }
  wasPinged() { return !!(this._lastPing && this._lastPing.pinged); }
  lastPingAuthor() { return String(this._lastPing.from || ''); }
  lastPingChannel() { return String(this._lastPing.channelName || ''); }
  lastPingServer() { return String(this._lastPing.guildName || ''); }
  lastPingMessage() { return String(this._lastPing.content || ''); }

  // sendMessage example (include ref)
  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this._log('sendMessage: ws not open'); return; }
    const guild = this.guilds.find(g => g.name === SERVER || g.id === SERVER);
    const guildId = guild ? guild.id : null;
    const chObj = guildId ? (this.channels[guildId] || []).find(c => c.name === CHANNEL || c.id === CHANNEL) : null;
    const channelId = chObj ? chObj.id : null;
    const payload = {
      type: 'sendMessage',
      guildId: guildId,
      guildName: SERVER,
      channelId: channelId,
      channelName: CHANNEL,
      content: String(CONTENT || ''),
      ref: Date.now().toString()
    };
    try { this.ws.send(JSON.stringify(payload)); this._log('sendMessage payload', payload); } catch (e) { this._log('sendMessage failed', e); }
  }

  // getVersion and other reporters...
  getVersion() { return String(this.VERSION); }
}

Scratch.extensions.register(new DiscordLink());
