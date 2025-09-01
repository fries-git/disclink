// disclinkextension.js
class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.VERSION = '2.0.0';
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = []; // [{id,name}]
    this.channels = {}; // guildId -> [{id,name}]
    this._lastMessage = { content:'', channelName:'', guildName:'', authorName:'', authorId:'', timestamp:0 };
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
        { opcode: 'sendMessage', blockType: 'command', text: 'send [CONTENT] to [CHANNEL] in server [SERVER]', arguments: { CONTENT: { type: 'string', defaultValue: '' }, CHANNEL: { type: 'string', defaultValue: '' }, SERVER: { type: 'string', defaultValue: '' } } },
        { opcode: 'whenMessageReceived', blockType: 'hat', text: 'when message received' },
        { opcode: 'lastMessage', blockType: 'reporter', text: 'last message text' },
        { opcode: 'lastMessageChannel', blockType: 'reporter', text: 'last message channel' },
        { opcode: 'lastMessageServer', blockType: 'reporter', text: 'last message server' },
        { opcode: 'lastMessageAuthor', blockType: 'reporter', text: 'last message author' },
        { opcode: 'lastMessageAuthorId', blockType: 'reporter', text: 'last message author id' },
        { opcode: 'lastMessageTimestamp', blockType: 'reporter', text: 'last message timestamp' },
        { opcode: 'getVersion', blockType: 'reporter', text: 'extension version' }
      ]
    };
  }

  _log(...args){ try{ console.log('[DiscordLink ext]', ...args); }catch(e){} }

  connect({ URL }) {
    if (this.ws) { try { this.ws.close(); } catch(e){} this.ws = null; }
    this._log('connecting to', URL);
    try { this.ws = new WebSocket(URL); } catch(e){ this._log('WebSocket constructor failed', e); return; }

    this.ws.onopen = () => {
      this._log('ws open');
      this.connected = true;
      // ask for state
      try { this.ws.send(JSON.stringify({ type: 'getServerList' })); } catch(e){}
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(e){ this._log('parse failed', e); return; }

      if (msg.type === 'bridgeStatus') {
        this.connected = !!msg.bridgeConnected;
      }
      if (msg.type === 'ready') {
        this.discordReady = !!msg.value;
        this._log('discordReady', this.discordReady);
      }

      if (msg.type === 'serverPartial') {
        const g = msg.guild;
        if (!g) return;
        // add or update guild
        this.guilds = this.guilds.filter(x=>x.id!==g.id).concat({ id: g.id, name: g.name });
        this.channels[g.id] = (g.channels || []).map(c => ({ id: c.id, name: c.name }));
      }

      if (msg.type === 'serverList') {
        this.guilds = (msg.servers || []).map(s => ({ id: s.id, name: s.name }));
        this.channels = {};
        (msg.servers || []).forEach(s => { this.channels[s.id] = (s.channels||[]).map(c=>({id:c.id,name:c.name})); });
        this._log('serverList applied, count=', this.guilds.length);
      }

      if (msg.type === 'channelList') {
        this.channels[msg.guildId] = (msg.data || []).map(c => ({ id: c.id, name: c.name }));
      }

      if (msg.type === 'ack') {
        this._log('ack', msg);
      }

      if (msg.type === 'message') {
        const d = msg;
        this._lastMessage = {
          content: String(d.content || ''),
          channelName: String(d.channelName || ''),
          guildName: String(d.guildName || ''),
          authorName: String(d.authorName || d.author || ''),
          authorId: String(d.authorId || ''),
          timestamp: d.timestamp || Date.now()
        };
        this._log('lastMessage updated', this._lastMessage);
        try {
          if (this.runtime && typeof this.runtime.startHats === 'function') this.runtime.startHats('whenMessageReceived', {});
        } catch(e) { this._log('startHats fail', e); }
      }

      if (msg.type === 'pong') this._log('pong', msg.ts);
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev && ev.code, ev && ev.reason);
      this.connected = false;
      this.discordReady = false;
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(()=>{ this._log('reconnect attempt'); this.connect({ URL }); }, this.reconnectDelay);
      }
    };

    this.ws.onerror = (err) => { this._log('ws error', err); };
  }

  isConnected(){ return !!this.connected; }
  isDiscordReady(){ return !!this.discordReady; }
  getGuilds(){ return this.guilds.map(g=>g.name).join(', ') || 'No servers'; }
  getChannels({ SERVER }) {
    const guild = this.guilds.find(g => g.name === SERVER || g.id === SERVER);
    if (!guild) return 'No channels';
    return (this.channels[guild.id] || []).map(c => c.name).join(', ') || 'No channels';
  }

  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'getServerList', force: true })); } catch(e){ this._log('refresh send failed', e); }
    } else this._log('refreshServers: ws not open');
  }

  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this._log('sendMessage: ws not open'); return; }
    // try to prefer IDs if we have them in mapping
    const guild = this.guilds.find(g => g.name === SERVER || g.id === SERVER);
    const guildId = guild ? guild.id : null;
    const chObj = guildId ? (this.channels[guildId]||[]).find(c => c.name === CHANNEL || c.id === CHANNEL) : null;
    const channelId = chObj ? chObj.id : null;

    const payload = { type: 'sendMessage', guildId: guildId, channelId: channelId, guildName: SERVER, channelName: CHANNEL, content: String(CONTENT || ''), ref: Date.now() };
    try { this.ws.send(JSON.stringify(payload)); this._log('sent sendMessage payload', payload); } catch(e) { this._log('sendMessage failed', e); }
  }

  lastMessage(){ return this._lastMessage.content || ''; }
  lastMessageChannel(){ return this._lastMessage.channelName || ''; }
  lastMessageServer(){ return this._lastMessage.guildName || ''; }
  lastMessageAuthor(){ return this._lastMessage.authorName || ''; }
  lastMessageAuthorId(){ return this._lastMessage.authorId || ''; }
  lastMessageTimestamp(){ return String(this._lastMessage.timestamp || ''); }
  getVersion(){ return String(this.VERSION); }
}

Scratch.extensions.register(new DiscordLink());
