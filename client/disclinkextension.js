(function (Scratch) {
  'use strict';

  const vmRuntime = Scratch.vm?.runtime;
  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;

  let ws = null;
  let connected = false;
  let wsUrl = 'ws://localhost:3001';

  let guildChannels = {}; // guildId -> { guildName, channels: [{id,name,type}] }
  const messageQueue = [];
  let lastMessage = { content:'', author:'', channelId:'', channelName:'', channelType:null, guildId:'', bot:false, bulkMessages:'' };

  function safeJSON(obj){ try{ return JSON.stringify(obj); } catch { return '{}'; } }

  function connectWS(url){
    if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
    wsUrl = url||wsUrl;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      connected = true;
      ws.send(safeJSON({ type:'getGuildChannels' }));
    });

    ws.addEventListener('close', () => {
      connected = false;
      setTimeout(()=>connectWS(wsUrl),1500);
    });

    ws.addEventListener('message', (evt)=>{
      let payload;
      try { payload = JSON.parse(evt.data); } catch{return;}

      if(payload?.type==='messageCreate' && payload.data){
        const d = payload.data;
        lastMessage = {
          content:String(d.content||''),
          author:String(d.author?.username||''),
          channelId:String(d.channelId||''),
          channelName:String(d.channelName||''),
          channelType:d.channelType||null,
          guildId:String(d.guildId||''),
          bot:!!d.author?.bot,
          bulkMessages:lastMessage.bulkMessages
        };
        messageQueue.push(lastMessage);
        if(vmRuntime) vmRuntime.startHats('discordBridge_whenMessageReceived');
      } else if(payload?.type==='guildChannels' && payload.data){
        guildChannels = {};
        for(const g of payload.data){
          guildChannels[g.guildId] = { guildName:g.guildName, channels:g.channels };
        }
      } else if(payload?.type==='messages' && payload.data){
        lastMessage.bulkMessages = payload.data;
      }
    });
  }

  class DiscordBridge {
    getInfo(){
      return {
        id:'discordBridge',
        name:'Discord Bridge',
        color1:'#5865F2',
        color2:'#404EED',
        blocks:[
          { opcode:'connect', blockType:BlockType.COMMAND, text:'connect to bridge at [URL]', arguments:{ URL:{ type:ArgumentType.STRING, defaultValue:'ws://localhost:3001' } } },
          { opcode:'isConnected', blockType:BlockType.BOOLEAN, text:'connected?' },

          { opcode:'sendMessage', blockType:BlockType.COMMAND, text:'send message [TEXT] to channel [CHANNEL] in server [GUILD]', arguments:{
            TEXT:{ type:ArgumentType.STRING, defaultValue:'Hello!' },
            CHANNEL:{ type:ArgumentType.STRING, defaultValue:'' },
            GUILD:{ type:ArgumentType.STRING, defaultValue:'' }
          }},
          { opcode:'refreshChannels', blockType:BlockType.COMMAND, text:'refresh server + channel list' },

          { opcode:'listGuilds', blockType:BlockType.REPORTER, text:'all servers' },
          { opcode:'textChannels', blockType:BlockType.REPORTER, text:'text channels in server [GUILD]', arguments:{ GUILD:{ type:ArgumentType.STRING, defaultValue:'' } } },
          { opcode:'voiceChannels', blockType:BlockType.REPORTER, text:'voice channels in server [GUILD]', arguments:{ GUILD:{ type:ArgumentType.STRING, defaultValue:'' } } },
          { opcode:'channelsWithTypes', blockType:BlockType.REPORTER, text:'all channels with types in server [GUILD]', arguments:{ GUILD:{ type:ArgumentType.STRING, defaultValue:'' } } },
          { opcode:'getChannelId', blockType:BlockType.REPORTER, text:'get channel id for [NAME] in server [GUILD]', arguments:{
            NAME:{ type:ArgumentType.STRING, defaultValue:'' },
            GUILD:{ type:ArgumentType.STRING, defaultValue:'' }
          }},

          { opcode:'whenMessageReceived', blockType:BlockType.HAT, text:'when discord message received' },
          { opcode:'lastContent', blockType:BlockType.REPORTER, text:'last msg content' },
          { opcode:'lastAuthor', blockType:BlockType.REPORTER, text:'last msg author' },
          { opcode:'lastChannel', blockType:BlockType.REPORTER, text:'last msg channel id' },
          { opcode:'lastChannelName', blockType:BlockType.REPORTER, text:'last msg channel name' },
          { opcode:'lastChannelType', blockType:BlockType.REPORTER, text:'last msg channel type' },
          { opcode:'lastGuild', blockType:BlockType.REPORTER, text:'last msg guild id' },

          { opcode:'getMessages', blockType:BlockType.REPORTER, text:'get last [LIMIT] messages from channel [CHANNEL] in server [GUILD]', arguments:{
            LIMIT:{ type:ArgumentType.NUMBER, defaultValue:50 },
            CHANNEL:{ type:ArgumentType.STRING, defaultValue:'' },
            GUILD:{ type:ArgumentType.STRING, defaultValue:'' }
          }}
        ]
      };
    }

    connect(args){ connectWS(String(args.URL||'')); }
    isConnected(){ return connected && ws && ws.readyState===WebSocket.OPEN; }

    refreshChannels(){ if(this.isConnected()) ws.send(safeJSON({ type:'getGuildChannels' })); }

    resolveChannelId(guildInput, channelInput){
      // Resolve guild by ID or name
      let g = guildChannels[guildInput] || Object.values(guildChannels).find(x=>x.guildName===guildInput);
      if(!g || !channelInput) return '';
      // Resolve channel by ID or name
      const ch = g.channels.find(c=>c.id===channelInput || c.name.toLowerCase()===String(channelInput).toLowerCase());
      return ch ? ch.id : '';
    }

    sendMessage(args){
      if(!this.isConnected()) return;
      const channelId = this.resolveChannelId(args.GUILD, args.CHANNEL);
      if(!channelId) return;
      ws.send(safeJSON({
        type:'sendMessage',
        ref: Math.random().toString(36).slice(2),
        guildId:String(args.GUILD||''),
        channelId,
        content:String(args.TEXT||'')
      }));
    }

    listGuilds(){ return Object.values(guildChannels).map(g=>g.guildName).join(', '); }

    textChannels(args){
      const g = guildChannels[args.GUILD] || Object.values(guildChannels).find(x=>x.guildName===args.GUILD);
      if(!g) return '';
      return g.channels.filter(c=>c.type===0).map(c=>c.name).join(', ');
    }

    voiceChannels(args){
      const g = guildChannels[args.GUILD] || Object.values(guildChannels).find(x=>x.guildName===args.GUILD);
      if(!g) return '';
      return g.channels.filter(c=>c.type===2).map(c=>c.name).join(', ');
    }

    channelsWithTypes(args){
      const g = guildChannels[args.GUILD] || Object.values(guildChannels).find(x=>x.guildName===args.GUILD);
      if(!g) return '';
      return g.channels.map(c=>`${c.name} (${c.type})`).join(', ');
    }

    getChannelId(args){ return this.resolveChannelId(args.GUILD, args.NAME); }

    whenMessageReceived(){ if(messageQueue.length>0){ messageQueue.shift(); return true; } return false; }
    lastContent(){ return lastMessage.content; }
    lastAuthor(){ return lastMessage.author; }
    lastChannel(){ return lastMessage.channelId; }
    lastChannelName(){ return lastMessage.channelName; }
    lastChannelType(){ return lastMessage.channelType; }
    lastGuild(){ return lastMessage.guildId; }

    getMessages(){ return lastMessage.bulkMessages||''; }
  }

  if(vmRuntime && !vmRuntime._hats) vmRuntime._hats={};
  if(vmRuntime) vmRuntime._hats['discordBridge_whenMessageReceived']={ edgeActivated:false, restartExistingThreads:false };

  Scratch.extensions.register(new DiscordBridge());
})(Scratch);
