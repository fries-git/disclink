// disclinkextension.js
// TurboWarp extension — incremental-friendly, text-inputs, last-message hat + version reporter

class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;

    // extension version
    this.VERSION = '1.1.0'; // bump this when you change the extension

    // WebSocket / state
    this.ws = null;
    this.connected = false;
    this.discordReady = false;

    // guild/channel storage (text-input style)
    this.guilds = [];              // array of guild names
    this.channels = {};           // map: guildName -> array of channel names

    // last received message (for hat + reporters)
    this._lastMessage = {
      content: '',
      channelName: '',
      guildName: '',
      authorName: '',
      authorId: '',
      timestamp: 0
    };

    // reconnect config
    this.reconnectDelay = 2000;
    this.reconnectTimer = null;
  }

  getInfo() {
    return {
      id: 'disclink',
      name: 'Discord Link',
      color1: '#7289DA',
      blocks: [
        // connection + status
        { opcode: 'connect', blockType: 'command', text: 'connect to bridge [URL]', arguments: { URL: { type: 'string', defaultValue: 'ws://localhost:3001' } } },
        { opcode: 'isConnected', blockType: 'Boolean', text: 'bridge connected?' },
        { opcode: 'isDiscordReady', blockType: 'Boolean', text: 'discord ready?' },

        // servers & channels as text inputs
        { opcode: 'getGuilds', blockType: 'reporter', text: 'server list' },
        { opcode: 'getChannels', blockType: 'reporter', text: 'channels in server [SERVER]', arguments: { SERVER: { type: 'string', defaultValue: '' } } },
        { opcode: 'refreshServers', blockType: 'command', text: 'refresh servers' },
        { opcode: 'refreshChannels', blockType: 'command', text: 'refresh channels for server [SERVER]', arguments: { SERVER: { type: 'string', defaultValue: '' } } },

        // sending
        { opcode: 'sendMessage', blockType: 'command', text: 'send [CONTENT] to [CHANNEL] in server [SERVER]', arguments: { CONTENT: { type: 'string', defaultValue: '' }, CHANNEL: { type: 'string', defaultValue: '' }, SERVER: { type: 'string', defaultValue: '' } } },

        // message hat + reporters
        { opcode: 'whenMessageReceived', blockType: 'hat', text: 'when message received' },
        { opcode: 'lastMessage', blockType: 'reporter', text: 'last message text' },
        { opcode: 'lastMessageChannel', blockType: 'reporter', text: 'last message channel' },
        { opcode: 'lastMessageServer', blockType: 'reporter', text: 'last message server' },
        { opcode: 'lastMessageAuthor', blockType: 'reporter', text: 'last message author' },
        { opcode: 'lastMessageAuthorId', blockType: 'reporter', text: 'last message author id' },
        { opcode: 'lastMessageTimestamp', blockType: 'reporter', text: 'last message timestamp' },

        // version reporter
        { opcode: 'getVersion', blockType: 'reporter', text: 'extension version' },

        // convenience
        { opcode: 'mentionUser', blockType: 'reporter', text: 'mention user [ID]', arguments: { ID: { type: 'string', defaultValue: '' } } }
      ]
    };
  }

  /* ---------- internal logging ---------- */
  _log(...args) {
    try { console.log('[DiscordLink ext]', ...args); } catch (e) {}
  }

  /* ---------- connect / WS lifecycle ---------- */
  connect({ URL }) {
    // close existing
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }

    this._log('connecting to', URL);
    try { this.ws = new WebSocket(URL); } catch (e) { this._log('WebSocket constructor failed', e); return; }

    this.ws.onopen = () => {
      this._log('ws open');
      this.connected = true;
      this.discordReady = false;
      // request quick summary + data
      try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { this._log('ping send failed', e); }
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch (e) { this._log('getGuildChannels send failed', e); }
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    };

    this.ws.onmessage = (ev) => {
      // log raw message trimmed
      this._log('raw message', ev.data && ev.data.toString ? ev.data.toString().slice(0,1200) : ev.data);

      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { this._log('JSON parse failed', e); return; }

      // handle bridgeStatus
      if (msg.type === 'bridgeStatus') {
        this._log('bridgeStatus', msg);
        this.connected = !!msg.bridgeConnected;
        if (typeof msg.discordReady !== 'undefined') this.discordReady = !!msg.discordReady;
      }

      // handle lightweight summary (fast)
      if (msg.type === 'guildSummary') {
        const summary = Array.isArray(msg.data) ? msg.data : [];
        this.guilds = summary.map(g => g.guildName || 'Unknown');
        // ensure placeholders exist
        for (const s of summary) {
          if (!this.channels[s.guildName]) this.channels[s.guildName] = [];
        }
        this._log('guildSummary applied', this.guilds.length);
      }

      // handle partials for one guild
      if (msg.type === 'guildChannelsPartial') {
        const g = msg.guild || msg.data || null;
        if (g) {
          const name = g.guildName || g.guildId || 'Unknown';
          this.guilds = Array.from(new Set([...this.guilds, name]));
          this.channels[name] = (g.channels || []).map(c => c.name || '');
          this.discordReady = true; // first partial => we can consider ready
          this._log('guildChannelsPartial applied for', name, 'channels', this.channels[name].length);
        }
      }

      // final completion signal
      if (msg.type === 'guildChannelsComplete') {
        this._log('guildChannelsComplete');
        // optional: set flag if you want to detect complete state
        this._guildsFullyLoaded = true;
      }

      // classic full payload fallback (old-style)
      if (msg.type === 'guildChannels' && Array.isArray(msg.data)) {
        this._log('full guildChannels received, count=', msg.data.length);
        this.guilds = msg.data.map(g => g.guildName || 'Unknown');
        this.channels = {};
        (msg.data || []).forEach(g => {
          this.channels[g.guildName] = (g.channels || []).map(c => c.name || '');
        });
        this.discordReady = true;
      }

      // message events forwarded by the bridge
      if (msg.type === 'messageCreate' || msg.type === 'message') {
        const d = msg.data || {};
        // compact one-line safe picks using nullish coalescing
        const content     = String(d.content ?? msg.content ?? '');
        const channelName = String(d.channelName ?? msg.channelName ?? '');
        const guildName   = String(d.guildName ?? msg.guildName ?? d.guildId ?? msg.guildId ?? '');
        const authorName  = String((d.author && d.author.username) ?? d.authorUsername ?? (msg.author && msg.author.username) ?? '');
        const authorId    = String((d.author && d.author.id) ?? d.authorId ?? (msg.author && msg.author.id) ?? '');
        const timestamp   = d.timestamp ?? msg.timestamp ?? Date.now();

        this._lastMessage = {
          content,
          channelName,
          guildName,
          authorName,
          authorId,
          timestamp
        };

        this._log('lastMessage updated', this._lastMessage);

        // trigger hats in the runtime
        try {
          if (this.runtime && typeof this.runtime.startHats === 'function') {
            this.runtime.startHats('whenMessageReceived', {}); // start hats attached to this opcode
          } else {
            this._log('runtime.startHats not available in this environment');
          }
        } catch (e) {
          this._log('startHats threw', e);
        }
      }

      // ack/pong/other — log for debugging
      if (msg.type === 'ack') this._log('ack', msg);
      if (msg.type === 'pong') this._log('pong', msg);
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev && ev.code, ev && ev.reason);
      this.connected = false;
      this.discordReady = false;
      // schedule a reconnect attempt (one-shot)
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this._log('reconnect attempt');
          try { this.connect({ URL }); } catch (e) { this._log('reconnect failed', e); }
        }, this.reconnectDelay || 2000);
      }
    };

    this.ws.onerror = (ev) => {
      this._log('ws error', ev);
    };
  }

  /* ---------- booleans ---------- */
  isConnected() { return !!this.connected; }
  isDiscordReady() { return !!this.discordReady; }

  /* ---------- reporters for guilds/channels ---------- */
  getGuilds() { return this.guilds.join(', ') || 'No servers'; }
  getChannels({ SERVER }) { return this.channels[SERVER]?.join(', ') || 'No channels'; }

  /* ---------- refresh blocks ---------- */
  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch (e) { this._log('refresh send failed', e); }
    } else {
      this._log('refreshServers: ws not open');
    }
  }
  refreshChannels({ SERVER }) { this.refreshServers(); }

  /* ---------- send message ---------- */
  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this._log('sendMessage: ws not open'); return; }
    try {
      // do not auto-format here (server handles ID/name lookup), but convert simple @id forms
      const fixed = String(CONTENT || '').replace(/@(\d{5,})/g, '<@$1>');
      this.ws.send(JSON.stringify({ type: 'sendMessage', guildName: SERVER, channelName: CHANNEL, content: fixed }));
    } catch (e) { this._log('sendMessage failed', e); }
  }

  /* ---------- last message reporters (for hat) ---------- */
  lastMessage() { return this._lastMessage.content || ''; }
  lastMessageChannel() { return this._lastMessage.channelName || ''; }
  lastMessageServer() { return this._lastMessage.guildName || ''; }
  lastMessageAuthor() { return this._lastMessage.authorName || ''; }
  lastMessageAuthorId() { return this._lastMessage.authorId || ''; }
  lastMessageTimestamp() { return String(this._lastMessage.timestamp || ''); }

  /* ---------- version reporter ---------- */
  getVersion() { return String(this.VERSION); }

  /* ---------- helper ---------- */
  mentionUser({ ID }) { return `<@${ID}>`; }
}

Scratch.extensions.register(new DiscordLink());
