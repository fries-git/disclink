// disclinkextension.js
// TurboWarp/Scratch extension for the bridge.
// - sends ref per send
// - uses IDs when available
// - lastMessage uses displayText (or attachment url) to avoid invisible messages
// - has whenMessageReceived & whenPinged hats

class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.VERSION = '3.0.0';
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = []; // [{id,name}]
    this.channels = {}; // guildId -> [{id,name}]
    this._lastMessage = { content:'', channelName:'', guildName:'', authorName:'', authorId:'', timestamp:0, firstAttachmentUrl:'', fromSelf:false };
    this._lastPing = { pinged:false, from:'', content:'', timestamp:0 };
    this.reconnectDelay = 2000;
  }

  getInfo() {
    return {
      id: 'disclink',
      name: 'Discord Link',
      color1: '#7289DA',
      blocks: [
        { opcode:'connect', blockType:'command', text:'connect to bridge [URL]', arguments:{ URL:{ type:'string', defaultValue:'ws://localhost:3001' } } },
        { opcode:'isConnected', blockType:'Boolean', text:'bridge connected?' },
        { opcode:'isDiscordReady', blockType:'Boolean', text:'discord ready?' },
        { opcode:'getGuilds', blockType:'reporter', text:'server list' },
        { opcode:'getChannels', blockType:'reporter', text:'channels in server [SERVER]', arguments:{ SERVER:{ type:'string', defaultValue:'' } } },
        { opcode:'refreshServers', blockType:'command', text:'refresh servers' },
        { opcode:'sendMessage', blockType:'command', text:'send [CONTENT] to [CHANNEL] in server [SERVER]', arguments:{ CONTENT:{type:'string',defaultValue:''}, CHANNEL:{type:'string',defaultValue:''}, SERVER:{type:'string',defaultValue:''} } },
        { opcode:'whenMessageReceived', blockType:'hat', text:'when message received' },
        { opcode:'lastMessage', blockType:'reporter', text:'last message text' },
        { opcode:'lastMessageAttachment', blockType:'reporter', text:'last message attachment' },
        { opcode:'lastMessageChannel', blockType:'reporter', text:'last message channel' },
        { opcode:'lastMessageServer', blockType:'reporter', text:'last message server' },
        { opcode:'lastMessageAuthor', blockType:'reporter', text:'last message author' },
        { opcode:'lastMessageAuthorId', blockType:'reporter', text:'last message author id' },
        { opcode:'lastMessageTimestamp', blockType:'reporter', text:'last message timestamp' },
        { opcode:'whenPinged', blockType:'hat', text:'when pinged' },
        { opcode:'wasPinged', blockType:'Boolean', text:'was pinged?' },
        { opcode:'lastPingAuthor', blockType:'reporter', text:'last ping author' },
        { opcode:'lastPingMessage', blockType:'reporter', text:'last ping message' },
        { opcode:'getVersion', blockType:'reporter', text:'extension version' }
      ]
    };
  }

  _log(...args){ try{ console.log('[DiscordLink ext]', ...args); } catch(e) {} }

  connect({ URL }) {
    if (this.ws) { try { this.ws.close(); } catch(e){} this.ws = null; }
    this._log('connect to', URL);
    try { this.ws = new WebSocket(URL); } catch(e) { this._log('WS ctor failed', e); return; }

    this.ws.onopen = () => {
      this._log('ws open');
      this.connected = true;
      try { this.ws.send(JSON.stringify({ type:'getServerList' })); } catch(e) {}
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(e) { this._log('parse fail', e); return; }

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
        this.guilds = this.guilds.filter(x => x.id !== g.id).concat({ id: g.id, name: g.name });
        this.channels[g.id] = (g.channels || []).map(c => ({ id: c.id, name: c.name }));
      }

      if (msg.type === 'serverList') {
        this.guilds = (msg.servers || []).map(s => ({ id: s.id, name: s.name }));
        this.channels = {};
        (msg.servers || []).forEach(s => { this.channels[s.id] = (s.channels || []).map(c => ({ id:c.id, name:c.name })); });
        this._log('serverList applied; count=', this.guilds.length);
      }

      if (msg.type === 'channelList') {
        this.channels[msg.guildId] = (msg.data || []).map(c => ({ id: c.id, name: c.name }));
      }

      if (msg.type === 'ack') {
        this._log('ack', msg);
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
          rawContent: String(d.rawContent || ''),
          pinged: !!d.pinged
        };

        this._log('lastMessage updated', this._lastMessage);
        try { if (this.runtime && typeof this.runtime.startHats === 'function') this.runtime.startHats('whenMessageReceived', {}); } catch(e) { this._log('startHats fail', e); }
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
        this._log('ping received', this._lastPing);
        try { if (this.runtime && typeof this.runtime.startHats === 'function') this.runtime.startHats('whenPinged', {}); } catch(e) { this._log('startHats fail', e); }
      }

      if (msg.type === 'pong') this._log('pong', msg.ts);
    };

    this.ws.onclose = (ev) => {
      this._log('ws closed', ev && ev.code, ev && ev.reason);
      this.connected = false;
      this.discordReady = false;
      setTimeout(()=>{ try { this.connect({ URL }); } catch(e){} }, this.reconnectDelay);
    };

    this.ws.onerror = (err) => { this._log('ws error', err); };
  }

  isConnected(){ return !!this.connected; }
  isDiscordReady(){ return !!this.discordReady; }

  getGuilds(){ return this.guilds.map(g => g.name).join(', ') || 'No servers'; }
  getChannels({ SERVER }) {
    const guild = this.guilds.find(g => g.name === SERVER || g.id === SERVER);
    if (!guild) return 'No channels';
    return (this.channels[guild.id] || []).map(c => c.name).join(', ') || 'No channels';
  }

  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'getServerList', force: true })); } catch(e) { this._log('refresh send failed', e); }
    } else this._log('refreshServers: ws not open');
  }

  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this._log('sendMessage: ws not open'); return; }
    const guild = this.guilds.find(g => g.name === SERVER || g.id === SERVER);
    const guildId = guild ? guild.id : null;
    const chObj = guildId ? (this.channels[guildId]||[]).find(c => c.name === CHANNEL || c.id === CHANNEL) : null;
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
    try { this.ws.send(JSON.stringify(payload)); this._log('sendMessage payload', payload); } catch(e) { this._log('sendMessage failed', e); }
  }

  // reporters
  lastMessage(){ return String(this._lastMessage.content || ''); }
  lastMessageAttachment(){ return String(this._lastMessage.firstAttachmentUrl || ''); }
  lastMessageChannel(){ return String(this._lastMessage.channelName || ''); }
  lastMessageServer(){ return String(this._lastMessage.guildName || ''); }
  lastMessageAuthor(){ return String(this._lastMessage.authorName || ''); }
  lastMessageAuthorId(){ return String(this._lastMessage.authorId || ''); }
  lastMessageTimestamp(){ return String(this._lastMessage.timestamp || ''); }

  wasPinged(){ return !!(this._lastPing && this._lastPing.pinged); }
  lastPingAuthor(){ return String(this._lastPing.from || ''); }
  lastPingMessage(){ return String(this._lastPing.content || ''); }

  getVersion(){ return String(this.VERSION); }
}

Scratch.extensions.register(new DiscordLink());