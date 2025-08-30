// disclinkextension.js
// TurboWarp extension — adds a "when message received" hat + message reporters
class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.channels = {}; // serverName -> array of channel names

    // last received message (updated whenever server sends messageCreate)
    this._lastMessage = {
      content: '',
      channelName: '',
      guildName: '',
      authorName: '',
      authorId: '',
      timestamp: 0
    };

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

        // reporters for servers/channels
        { opcode: 'getGuilds', blockType: 'reporter', text: 'server list' },
        { opcode: 'getChannels', blockType: 'reporter', text: 'channels in server [SERVER]', arguments: { SERVER: { type: 'string', defaultValue: '' } } },
        { opcode: 'refreshServers', blockType: 'command', text: 'refresh servers' },
        { opcode: 'refreshChannels', blockType: 'command', text: 'refresh channels for server [SERVER]', arguments: { SERVER: { type: 'string', defaultValue: '' } } },

        // sending
        { opcode: 'sendMessage', blockType: 'command', text: 'send [CONTENT] to [CHANNEL] in server [SERVER]', arguments: { CONTENT: { type: 'string', defaultValue: '' }, CHANNEL: { type: 'string', defaultValue: '' }, SERVER: { type: 'string', defaultValue: '' } } },

        // --- NEW: hat + reporters for incoming messages ---
        { opcode: 'whenMessageReceived', blockType: 'hat', text: 'when message received' },
        { opcode: 'lastMessage', blockType: 'reporter', text: 'last message text' },
        { opcode: 'lastMessageChannel', blockType: 'reporter', text: 'last message channel' },
        { opcode: 'lastMessageServer', blockType: 'reporter', text: 'last message server' },
        { opcode: 'lastMessageAuthor', blockType: 'reporter', text: 'last message author' },
        { opcode: 'lastMessageAuthorId', blockType: 'reporter', text: 'last message author id' },
        { opcode: 'lastMessageTimestamp', blockType: 'reporter', text: 'last message timestamp' },

        // mention helper
        { opcode: 'mentionUser', blockType: 'reporter', text: 'mention user [ID]', arguments: { ID: { type: 'string', defaultValue: '' } } }
      ]
    };
  }

  _log(...args) { try { console.log('[DiscordLink ext]', ...args); } catch(e) {} }

  connect({ URL }) {
    // close any existing connection
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }

    this._log('connecting to', URL);
    try {
      this.ws = new WebSocket(URL);
    } catch (e) {
      this._log('WebSocket constructor failed', e);
      return;
    }

    this.ws.onopen = () => {
      this._log('ws open');
      this.connected = true;
      this.discordReady = false;
      // immediately request guilds and ping
      try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch(e){}
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch(e){}
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    };

    this.ws.onmessage = (ev) => {
      this._log('raw message', ev.data && ev.data.toString ? ev.data.toString().slice(0,2000) : ev.data);
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { this._log('JSON parse failed', e); return; }

      if (msg.type === 'bridgeStatus') {
        this._log('bridgeStatus', msg);
        this.connected = !!msg.bridgeConnected;
        if (typeof msg.discordReady !== 'undefined') this.discordReady = !!msg.discordReady;
      }

      if (msg.type === 'guildChannels') {
        this._log('guildChannels received, count=', Array.isArray(msg.data) ? msg.data.length : '!', msg);
        this.discordReady = true;
        this.guilds = (msg.data || []).map(g => g.guildName || 'Unknown');
        this.channels = {};
        (msg.data || []).forEach(g => {
          this.channels[g.guildName] = (g.channels || []).map(c => c.name || '');
        });
      }

      // handle new messages forwarded from bridge
      if (msg.type === 'messageCreate' || msg.type === 'message') {
        // normalize fields — server/guild might be in msg.data
        const content     = String(d.content ?? msg.content ?? '');
        const channelName = String(d.channelName ?? msg.channelName ?? '');
        const guildName   = String(d.guildName ?? msg.guildName ?? d.guildId ?? msg.guildId ?? '');
        const authorName  = String((d.author && d.author.username) ?? d.authorUsername ?? (msg.author && msg.author.username) ?? '');
        const authorId    = String((d.author && d.author.id) ?? d.authorId ?? (msg.author && msg.author.id) ?? '');
        const timestamp   = d.timestamp ?? msg.timestamp ?? Date.now();


        // update last message
        this._lastMessage = {
          content: String(content || ''),
          channelName: String(channelName || ''),
          guildName: String(guildName || ''),
          authorName: String(authorName || ''),
          authorId: String(authorId || ''),
          timestamp: d.timestamp ?? (msg.timestamp ?? Date.now())
        };

        this._log('lastMessage updated', this._lastMessage);

        // start attached hat blocks in the runtime
        try {
          // 'whenMessageReceived' is the opcode we declared above
          // runtime.startHats triggers attached hat blocks to run
          if (this.runtime && typeof this.runtime.startHats === 'function') {
            this.runtime.startHats('whenMessageReceived', {}); // no fields required
          } else {
            this._log('runtime.startHats not available (environment mismatch)');
          }
        } catch (e) {
          this._log('startHats threw', e);
        }
      }

      if (msg.type === 'pong') {
        this._log('pong', msg.ts);
      }

      if (msg.type === 'ack') {
        this._log('ack', msg);
      }
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev && ev.code, ev && ev.reason);
      this.connected = false;
      this.discordReady = false;
      // attempt a reconnect once after delay
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this._log('reconnect attempt');
          try { this.connect({ URL }); } catch(e){ this._log('reconnect failed', e); }
        }, this.reconnectDelay || 2000);
      }
    };

    this.ws.onerror = (ev) => {
      this._log('ws error', ev);
    };
  }

  // booleans
  isConnected() { return !!this.connected; }
  isDiscordReady() { return !!this.discordReady; }

  // reporters for server/channel lists
  getGuilds() { return this.guilds.join(', ') || 'No servers'; }
  getChannels({ SERVER }) { return this.channels[SERVER]?.join(', ') || 'No channels'; }

  // refresh blocks
  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch(e){ this._log('refresh send failed', e); }
    } else { this._log('refreshServers: ws not open'); }
  }
  refreshChannels({ SERVER }) { this.refreshServers(); }

  // send message (server + channel names or ids supported)
  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this._log('sendMessage: ws not open'); return; }
    try { this.ws.send(JSON.stringify({ type: 'sendMessage', guildName: SERVER, channelName: CHANNEL, content: CONTENT })); } catch(e){ this._log('sendMessage failed', e); }
  }

  // --- NEW: reporters for last message info ---
  lastMessage() { return this._lastMessage.content || ''; }
  lastMessageChannel() { return this._lastMessage.channelName || ''; }
  lastMessageServer() { return this._lastMessage.guildName || ''; }
  lastMessageAuthor() { return this._lastMessage.authorName || ''; }
  lastMessageAuthorId() { return this._lastMessage.authorId || ''; }
  lastMessageTimestamp() { return String(this._lastMessage.timestamp || ''); }

  // mention helper
  mentionUser({ ID }) { return `<@${ID}>`; }
}

Scratch.extensions.register(new DiscordLink());
