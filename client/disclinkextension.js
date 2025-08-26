(function (Scratch) {
  'use strict';

  const vmRuntime = Scratch.vm?.runtime;
  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;

  // ================= CONFIG =================
  const VERSION = '1.4.0'; // updated version
  const MSG_DELIM = '␟';   // delimiter between messages
  // ==========================================

  let ws = null;
  let connected = false;
  let wsUrl = 'ws://localhost:3001';
  let guildChannels = {}; // guildId -> { guildName, channels: [{id,name,type}] }
  const messageQueue = [];
  let lastMessage = {
    content: '',
    author: '',
    channelId: '',
    channelName: '',
    channelType: null,
    guildId: '',
    bot: false,
    bulkMessages: ''
  };

  function safeJSON(obj) { try { return JSON.stringify(obj); } catch { return '{}'; } }

  function connectWS(url) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    wsUrl = url || wsUrl;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      connected = true;
      ws.send(safeJSON({ type: 'getGuildChannels' }));
    });

    ws.addEventListener('close', () => {
      connected = false;
      setTimeout(() => connectWS(wsUrl), 1500);
    });

    ws.addEventListener('message', (evt) => {
      let payload;
      try { payload = JSON.parse(evt.data); } catch { return; }

      // Single message
      if (payload?.type === 'messageCreate' && payload.data) {
        const d = payload.data;
        lastMessage = {
          content: String(d.content ?? ''),
          author: String(d.author?.username ?? ''),
          channelId: String(d.channelId ?? ''),
          channelName: String(d.channelName ?? ''),
          channelType: d.channelType ?? null,
          guildId: String(d.guildId ?? ''),
          bot: !!d.author?.bot,
          bulkMessages: lastMessage.bulkMessages
        };
        messageQueue.push(lastMessage);
        if (vmRuntime) vmRuntime.startHats('discordBridge_whenMessageReceived');
      }

      // Guild channels
      if (payload?.type === 'guildChannels' && Array.isArray(payload.data)) {
        guildChannels = {};
        for (const g of payload.data) {
          if (!g.guildId) continue;
          guildChannels[g.guildId] = {
            guildName: g.guildName ?? '',
            channels: Array.isArray(g.channels) ? g.channels : []
          };
        }
      }

      // Bulk messages
      if (payload?.type === 'messages' && Array.isArray(payload.data)) {
        const mapped = payload.data.map(item => {
          const chName = item.channelName ?? '';
          const author = (item.author && (item.author.username ?? item.author.name)) ? (item.author.username ?? item.author.name) : '';
          const content = (item.content ?? '').toString().replace(/\r?\n/g, ' ');
          return `#${chName} - ${author}: ${content}`;
        });
        lastMessage.bulkMessages = mapped.join(MSG_DELIM);
      }
    });
  }

  // === Helpers ===
  function resolveGuildId(nameOrId) {
    if (!nameOrId) return '';
    if (!guildChannels) return '';
    if (guildChannels[nameOrId]) return nameOrId;
    const lower = String(nameOrId).toLowerCase();
    const found = Object.entries(guildChannels).find(([, v]) => (v.guildName ?? '').toLowerCase() === lower);
    return found ? found[0] : '';
  }

  function resolveChannelId(guildNameOrId, channelNameOrId) {
    const gid = resolveGuildId(guildNameOrId);
    if (!gid) return '';
    const g = guildChannels[gid];
    if (!g || !Array.isArray(g.channels)) return '';
    const direct = g.channels.find(c => c.id === channelNameOrId);
    if (direct) return direct.id;
    const lower = String(channelNameOrId ?? '').toLowerCase();
    const byName = g.channels.find(c => (c.name ?? '').toLowerCase() === lower);
    return byName ? byName.id : '';
  }

  class DiscordBridge {
    getInfo() {
      return {
        id: 'discordBridge',
        name: 'Discord Bridge',
        color1: '#5865F2',
        color2: '#404EED',
        blocks: [
          { opcode: 'version', blockType: BlockType.REPORTER, text: 'version' },

          { opcode: 'connect', blockType: BlockType.COMMAND, text: 'connect to bridge at [URL]', arguments: { URL: { type: ArgumentType.STRING, defaultValue: 'ws://localhost:3001' } } },
          { opcode: 'isConnected', blockType: BlockType.BOOLEAN, text: 'connected?' },
          { opcode: 'refreshChannels', blockType: BlockType.COMMAND, text: 'refresh server + channel list' },

          { opcode: 'sendMessage', blockType: BlockType.COMMAND, text: 'send message [TEXT] to channel [CHANNEL] in server [GUILD] with username [USERNAME]', arguments: { TEXT: { type: ArgumentType.STRING, defaultValue: 'Hello!' }, CHANNEL: { type: ArgumentType.STRING, defaultValue: '' }, GUILD: { type: ArgumentType.STRING, defaultValue: '' }, USERNAME: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'getMessages', blockType: BlockType.REPORTER, text: 'get last [LIMIT] messages from channel [CHANNEL] in server [GUILD]', arguments: { LIMIT: { type: ArgumentType.NUMBER, defaultValue: 50 }, CHANNEL: { type: ArgumentType.STRING, defaultValue: '' }, GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },

          { opcode: 'listGuilds', blockType: BlockType.REPORTER, text: 'all servers' },
          { opcode: 'allServerNames', blockType: BlockType.REPORTER, text: 'all server names' },
          { opcode: 'allServerIds', blockType: BlockType.REPORTER, text: 'all server ids' },
          { opcode: 'getGuildId', blockType: BlockType.REPORTER, text: 'get server id for [NAME]', arguments: { NAME: { type: ArgumentType.STRING, defaultValue: '' } } },

          { opcode: 'textChannels', blockType: BlockType.REPORTER, text: 'text channels in server [GUILD]', arguments: { GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'voiceChannels', blockType: BlockType.REPORTER, text: 'voice channels in server [GUILD]', arguments: { GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'channelsWithTypes', blockType: BlockType.REPORTER, text: 'all channels with types in server [GUILD]', arguments: { GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'getChannelId', blockType: BlockType.REPORTER, text: 'get channel id for [NAME] in server [GUILD]', arguments: { NAME: { type: ArgumentType.STRING, defaultValue: '' }, GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },

          { opcode: 'whenMessageReceived', blockType: BlockType.HAT, text: 'when discord message received' },
          { opcode: 'lastContent', blockType: BlockType.REPORTER, text: 'last msg content' },
          { opcode: 'lastAuthor', blockType: BlockType.REPORTER, text: 'last msg author' },
          { opcode: 'lastChannel', blockType: BlockType.REPORTER, text: 'last msg channel id' },
          { opcode: 'lastChannelName', blockType: BlockType.REPORTER, text: 'last msg channel name' },
          { opcode: 'lastChannelType', blockType: BlockType.REPORTER, text: 'last msg channel type' },
          { opcode: 'lastGuild', blockType: BlockType.REPORTER, text: 'last msg guild id' },
          { opcode: 'lastBulkMessages', blockType: BlockType.REPORTER, text: 'last bulk messages' }
        ]
      };
    }

    version() { return VERSION; }

    connect(args) { connectWS(String(args.URL ?? '')); }
    isConnected() { return connected && ws && ws.readyState === WebSocket.OPEN; }
    refreshChannels() { if (this.isConnected()) ws.send(safeJSON({ type: 'getGuildChannels' })); }

    listGuilds() { return Object.values(guildChannels).map(g => g.guildName).join(MSG_DELIM); }
    allServerNames() { return Object.values(guildChannels).map(g => g.guildName).join(MSG_DELIM); }
    allServerIds() { return Object.keys(guildChannels).join(MSG_DELIM); }
    getGuildId(args) { return resolveGuildId(args.NAME); }

    textChannels(args) {
      const gid = resolveGuildId(args.GUILD); if (!gid) return '';
      const g = guildChannels[gid]; if (!g) return '';
      return g.channels.filter(c => c.type === 0).map(c => c.name).join(MSG_DELIM);
    }

    voiceChannels(args) {
      const gid = resolveGuildId(args.GUILD); if (!gid) return '';
      const g = guildChannels[gid]; if (!g) return '';
      return g.channels.filter(c => c.type === 2).map(c => c.name).join(MSG_DELIM);
    }

    channelsWithTypes(args) {
      const gid = resolveGuildId(args.GUILD); if (!gid) return '';
      const g = guildChannels[gid]; if (!g) return '';
      return g.channels.map(c => `${c.name} (${c.type})`).join(MSG_DELIM);
    }

    getChannelId(args) { return resolveChannelId(args.GUILD, args.NAME); }

    sendMessage(args) {
      if (!this.isConnected()) return;
      const gid = resolveGuildId(args.GUILD); if (!gid) return;
      const chId = resolveChannelId(args.GUILD, args.CHANNEL); if (!chId) return;

      ws.send(safeJSON({ type: 'sendMessage', channelId: chId, guildId: gid, content: String(args.TEXT ?? ''), username: String(args.USERNAME ?? '') }));
    }

    getMessages(args) {
      const gid = resolveGuildId(args.GUILD); if (!gid) return '';
      const chId = resolveChannelId(args.GUILD, args.CHANNEL); if (!chId) return '';
      const limit = Math.min(Math.max(Number(args.LIMIT) || 50, 1), 250);

      lastMessage.bulkMessages = '';
      ws.send(safeJSON({ type: 'getMessages', guildId: gid, channelId: chId, limit }));

      const start = Date.now();
      while (Date.now() - start < 15000) { // max 15s wait
        if (lastMessage.bulkMessages) break;
      }
      return lastMessage.bulkMessages;
    }

    whenMessageReceived() { if (messageQueue.length > 0) { messageQueue.shift(); return true; } return false; }
    lastContent() { return lastMessage.content; }
    lastAuthor() { return lastMessage.author; }
    lastChannel() { return lastMessage.channelId; }
    lastChannelName() { return lastMessage.channelName; }
    lastChannelType() { return lastMessage.channelType; }
    lastGuild() { return lastMessage.guildId; }
    lastBulkMessages() { return lastMessage.bulkMessages; }
  }

  if (vmRuntime && !vmRuntime._hats) vmRuntime._hats = {};
  if (vmRuntime) vmRuntime._hats['discordBridge_whenMessageReceived'] = { edgeActivated: false, restartExistingThreads: false };

  Scratch.extensions.register(new DiscordBridge());
})(Scratch);
