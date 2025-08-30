// disclinkextension.js (load in TurboWarp)
class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.channels = {}; // serverName -> array of channel names
    this.lastRaw = null;
    this.reconnectDelay = 2000;
    this.reconnectTimer = null;
  }

  getInfo() {
    return {
      id: 'disclink',
      name: 'Discord Link',
      color1: '#7289DA',
      blocks: [
        { opcode: 'connect', blockType: 'command', text: 'connect to bridge [URL]', arguments: { URL: { type: 'string', defaultValue: 'ws://localhost:3001' } } },
        { opcode: 'isConnected', blockType: 'Boolean', text: 'bridge connected?' },
        { opcode: 'isDiscordReady', blockType: 'Boolean', text: 'discord ready?' },
        { opcode: 'getGuilds', blockType: 'reporter', text: 'server list' },
        { opcode: 'getChannels', blockType: 'reporter', text: 'channels in server [SERVER]', arguments: { SERVER: { type: 'string', defaultValue: '' } } },
        { opcode: 'refreshServers', blockType: 'command', text: 'refresh servers' },
        { opcode: 'refreshChannels', blockType: 'command', text: 'refresh channels for server [SERVER]', arguments: { SERVER: { type: 'string', defaultValue: '' } } },
        { opcode: 'sendMessage', blockType: 'command', text: 'send [CONTENT] to [CHANNEL] in server [SERVER]', arguments: { CONTENT: { type: 'string', defaultValue: '' }, CHANNEL: { type: 'string', defaultValue: '' }, SERVER: { type: 'string', defaultValue: '' } } },
        { opcode: 'mentionUser', blockType: 'reporter', text: 'mention user [ID]', arguments: { ID: { type: 'string', defaultValue: '' } } }
      ]
    };
  }

  _log(...args) { try { console.log('[DiscordLink extension]', ...args); } catch(e){} }

  connect({ URL }) {
    // close existing
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try { this.ws.close(); } catch (e) {}
    }

    try {
      this.ws = new WebSocket(URL);
    } catch (e) {
      this._log('WebSocket constructor failed:', e);
      return;
    }

    this.ws.onopen = () => {
      this._log('ws open');
      this.connected = true;
      this.discordReady = false;
      // request guilds immediately
      this.refreshServers();
      // clear reconnect if any
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev.code, ev.reason);
      this.connected = false;
      this.discordReady = false;
      // try reconnect after delay
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this._log('attempting reconnect...');
          try { this.connect({ URL }); } catch(e) { this._log('reconnect failed', e); }
        }, this.reconnectDelay);
      }
    };

    this.ws.onerror = (ev) => {
      this._log('ws error', ev);
    };

    this.ws.onmessage = (ev) => {
      this.lastRaw = ev.data;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { this._log('invalid JSON', e); return; }

      if (msg.type === 'bridgeStatus') {
        this.connected = !!msg.bridgeConnected;
        this.discordReady = !!msg.discordReady;
        this._log('bridgeStatus', msg);
      }

      if (msg.type === 'guildChannels') {
        this._log('got guildChannels, length=', Array.isArray(msg.data) ? msg.data.length : '!', msg);
        this.discordReady = true;
        this.guilds = (msg.data || []).map(g => g.guildName || 'Unknown');
        this.channels = {};
        (msg.data || []).forEach(g => {
          this.channels[g.guildName] = (g.channels || []).map(c => c.name || '');
        });
      }

      if (msg.type === 'pong') {
        this._log('pong', msg.ts);
      }

      // ack and other messages can be inspected in console if needed
    };
  }

  // booleans
  isConnected() { return !!this.connected; }
  isDiscordReady() { return !!this.discordReady; }

  // reporters
  getGuilds() { return this.guilds.join(', ') || 'No servers'; }
  getChannels({ SERVER }) { return this.channels[SERVER]?.join(', ') || 'No channels'; }

  // actions
  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch(e){ this._log('send failed', e); }
    }
  }
  refreshChannels({ SERVER }) { this.refreshServers(); }

  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'sendMessage', guildName: SERVER, channelName: CHANNEL, content: CONTENT }));
      } catch (e) { this._log('sendMessage failed', e); }
    }
  }

  // convenience
  mentionUser({ ID }) { return `<@${ID}>`; }
}

Scratch.extensions.register(new DiscordLink());
