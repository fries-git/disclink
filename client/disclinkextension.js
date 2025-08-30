// disclinkextension.js — verbose, for TurboWarp (load in browser)
class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.channels = {};
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

  _log(...args) { try { console.log('[DiscordLink ext]', ...args); } catch(e) {} }

  connect({ URL }) {
    // close old
    if (this.ws) {
      try { this.ws.close(); } catch(e) {}
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
      // send ping and request guilds
      try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch(e){ this._log('ping send failed', e); }
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch(e){ this._log('getGuildChannels send failed', e); }
      // cancel reconnect
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    };

    this.ws.onmessage = (ev) => {
      this._log('raw message', ev.data && ev.data.toString ? ev.data.toString().slice(0,1000) : ev.data);
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { this._log('JSON parse failed', e); return; }

      if (msg.type === 'bridgeStatus') {
        this._log('bridgeStatus', msg);
        this.connected = !!msg.bridgeConnected;
        // if server told us discordReady, use it; otherwise we still wait for guildChannels
        if (typeof msg.discordReady !== 'undefined') this.discordReady = !!msg.discordReady;
      }

      if (msg.type === 'guildChannels') {
        this._log('guildChannels received. count=', Array.isArray(msg.data) ? msg.data.length : '!', msg);
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

      if (msg.type === 'ack') {
        this._log('ack', msg);
      }
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev.code, ev.reason);
      this.connected = false;
      this.discordReady = false;
      // attempt reconnect once after delay
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

  // reporters
  getGuilds() { return this.guilds.join(', ') || 'No servers'; }
  getChannels({ SERVER }) { return this.channels[SERVER]?.join(', ') || 'No channels'; }

  // actions
  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'getGuildChannels' })); } catch(e){ this._log('refresh send failed', e); }
    } else {
      this._log('refreshServers called but WS not open');
    }
  }
  refreshChannels({ SERVER }) { this.refreshServers(); }

  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this._log('sendMessage: ws not open'); return; }
    try { this.ws.send(JSON.stringify({ type: 'sendMessage', guildName: SERVER, channelName: CHANNEL, content: CONTENT })); } catch(e) { this._log('sendMessage failed', e); }
  }

  mentionUser({ ID }) { return `<@${ID}>`; }
}

Scratch.extensions.register(new DiscordLink());
