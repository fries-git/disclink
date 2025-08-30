class DiscordLink {
  constructor(runtime){
    this.runtime = runtime;
    this.VERSION = '1.3.0';
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.channels = {};
    this._lastMessage = { content:'', channelName:'', guildName:'', authorName:'', authorId:'', timestamp:0 };
  }

  getInfo(){
    return {
      id:'disclink',
      name:'Discord Link',
      color1:'#7289DA',
      blocks:[
        {opcode:'connect', blockType:'command', text:'connect to bridge [URL]',
         arguments:{URL:{type:'string',defaultValue:'ws://localhost:3001'}}},
        {opcode:'isConnected', blockType:'Boolean', text:'bridge connected?'},
        {opcode:'isDiscordReady', blockType:'Boolean', text:'discord ready?'},
        {opcode:'getGuilds', blockType:'reporter', text:'server list'},
        {opcode:'getChannels', blockType:'reporter', text:'channels in server [SERVER]',
         arguments:{SERVER:{type:'string',defaultValue:''}}},
        {opcode:'refreshServers', blockType:'command', text:'refresh servers'},
        {opcode:'sendMessage', blockType:'command', text:'send [CONTENT] to [CHANNEL] in server [SERVER]',
         arguments:{CONTENT:{type:'string',defaultValue:''},CHANNEL:{type:'string',defaultValue:''},SERVER:{type:'string',defaultValue:''}}},
        {opcode:'whenMessageReceived', blockType:'hat', text:'when message received'},
        {opcode:'lastMessage', blockType:'reporter', text:'last message text'},
        {opcode:'lastMessageChannel', blockType:'reporter', text:'last message channel'},
        {opcode:'lastMessageServer', blockType:'reporter', text:'last message server'},
        {opcode:'lastMessageAuthor', blockType:'reporter', text:'last message author'},
        {opcode:'lastMessageAuthorId', blockType:'reporter', text:'last message author id'},
        {opcode:'lastMessageTimestamp', blockType:'reporter', text:'last message timestamp'},
        {opcode:'getVersion', blockType:'reporter', text:'extension version'}
      ]
    };
  }

  _log(...args){ try{ console.log('[DiscordLink ext]',...args); } catch(e){} }

  connect({URL}){
    if(this.ws){ this.ws.close(); this.ws=null; }
    this.ws = new WebSocket(URL);

    this.ws.onopen = ()=>{
      this.connected=true;
      this.discordReady=false;
      try{ this.ws.send(JSON.stringify({type:'ping'})); }catch(e){}
      try{ this.ws.send(JSON.stringify({type:'getGuildChannels'})); }catch(e){}
      this._log('connected');
    };

    this.ws.onmessage = ev=>{
      let msg;
      try{ msg=JSON.parse(ev.data); }catch{return;}

      if(msg.type==='bridgeStatus'){ this.connected=!!msg.bridgeConnected; this.discordReady=!!msg.discordReady; }
      if(msg.type==='guildSummary'){ this.guilds=(msg.data||[]).map(g=>({name:g.guildName||'',id:g.guildId||''})); for(const g of this.guilds) if(!this.channels[g.id]) this.channels[g.id]=[]; }
      if(msg.type==='guildChannelsPartial'){
        const g = msg.guild || msg.data || {};
        if(g.guildId){ this.guilds=this.guilds.filter(x=>x.id!==g.guildId).concat({name:g.guildName,id:g.guildId}); this.channels[g.guildId]=(g.channels||[]).map(c=>({name:c.name||'',id:c.id||''})); this.discordReady=true; }
      }
      if(msg.type==='messageCreate'){
        const d=msg.data||{};
        this._lastMessage={ content:String(d.content||''), channelName:String(d.channelName||''), guildName:String(d.guildName||''), authorName:String((d.author&&d.author.username)||''), authorId:String((d.author&&d.author.id)||''), timestamp:d.createdTimestamp||Date.now() };
        try{ if(this.runtime && typeof this.runtime.startHats==='function') this.runtime.startHats('whenMessageReceived',{}); }catch(e){ this._log('startHats error',e); }
      }
    };

    this.ws.onclose = ()=>{ this.connected=false; this.discordReady=false; this._log('disconnected'); };
    this.ws.onerror = e=>{ this._log('ws error',e); };
  }

  isConnected(){ return !!this.connected; }
  isDiscordReady(){ return !!this.discordReady; }
  getGuilds(){ return this.guilds.map(g=>g.name).join(', ') || 'No servers'; }
  getChannels({SERVER}){ const guild=this.guilds.find(g=>g.name===SERVER); if(!guild) return 'No channels'; return (this.channels[guild.id]||[]).map(c=>c.name).join(', ') || 'No channels'; }
  refreshServers(){ if(this.ws&&this.ws.readyState===WebSocket.OPEN) try{ this.ws.send(JSON.stringify({type:'getGuildChannels',force:true})); }catch(e){} }
  sendMessage({CONTENT,CHANNEL,SERVER}){ const guild=this.guilds.find(g=>g.name===SERVER); if(!guild) return; const ch=(this.channels[guild.id]||[]).find(c=>c.name===CHANNEL); if(!ch) return; try{ this.ws.send(JSON.stringify({type:'sendMessage',guildId:guild.id,channelId:ch.id,content:String(CONTENT||'')})); }catch(e){} }
  lastMessage(){ return this._lastMessage.content||''; }
  lastMessageChannel(){ return this._lastMessage.channelName||''; }
  lastMessageServer(){ return this._lastMessage.guildName||''; }
  lastMessageAuthor(){ return this._lastMessage.authorName||''; }
  lastMessageAuthorId(){ return this._lastMessage.authorId||''; }
  lastMessageTimestamp(){ return String(this._lastMessage.timestamp||''); }
  getVersion(){ return String(this.VERSION); }
}

Scratch.extensions.register(new DiscordLink());
