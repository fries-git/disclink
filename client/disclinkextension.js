(function (Scratch) {
  'use strict';

  const vmRuntime = Scratch.vm?.runtime;
  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;

  // ================= CONFIG =================
  const VERSION = '1.2.0'; // <-- edit here to update version shown by block
  // ==========================================

  let ws = null;
  let connected = false;
  let wsUrl = 'ws://localhost:3001';

  // guildChannels: guildId -> { guildName, channels: [{id,name,type}] }
  let guildChannels = {};
  const messageQueue = [];
  let lastMessage = {
    content: '',
    author: '',
    channelId: '',
    channelName: '',
    channelType: null,
    guildId: '',
    bot: false,
    bulkMessages: '' // string form (delimited) or raw array depending on server
  };

  // Delimiters
  const SERVER_DELIM = '␞'; // between servers in names/ids lists
  const MSG_DELIM = '␟';    // between messages in bulk payload
  const FIELD_DELIM = '§§§'; // between fields inside a message

  function safeJSON(obj) { try { return JSON.stringify(obj); } catch { return '{}'; } }

  function connectWS(url) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    wsUrl = url || wsUrl;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      connected = true;
      // ask for full guild/channel list immediately
      ws.send(safeJSON({ type: 'getGuildChannels' }));
    });

    ws.addEventListener('close', () => {
      connected = false;
      setTimeout(() => connectWS(wsUrl), 1500);
    });

    ws.addEventListener('message', (evt) => {
      let payload;
      try { payload = JSON.parse(evt.data); } catch { return; }

      // incoming single message broadcast
      if (payload?.type === 'messageCreate' && payload.data) {
        const d = payload.data;
        lastMessage = {
          content: String(d.content ?? ''),
          author: (d.author && (d.author.username ?? d.author.name)) ? String(d.author.username ?? d.author.name) : '',
          channelId: String(d.channelId ?? ''),
          channelName: String(d.channelName ?? ''),
          channelType: d.channelType ?? null,
          guildId: String(d.guildId ?? ''),
          bot: !!(d.author && d.author.bot),
          bulkMessages: lastMessage.bulkMessages
        };
        messageQueue.push(lastMessage);
        if (vmRuntime) vmRuntime.startHats('discordBridge_whenMessageReceived');
        return;
      }

      // incoming guildChannels list (bridge should send this on connect and on refresh)
      if (payload?.type === 'guildChannels' && Array.isArray(payload.data)) {
        guildChannels = {};
        for (const g of payload.data) {
          // expect each g to be { guildId, guildName, channels: [{id,name,type}, ...] }
          if (!g.guildId) continue;
          guildChannels[g.guildId] = {
            guildName: g.guildName ?? '',
            channels: Array.isArray(g.channels) ? g.channels : []
          };
        }
        return;
      }

      // incoming messages (bulk fetch): payload.data may be array of strings or array of objects
      if (payload?.type === 'messages') {
        const d = payload.data;
        // Normalize into delimited string stored in lastMessage.bulkMessages
        if (Array.isArray(d)) {
          // If items are plain strings -> join with MSG_DELIM
          if (d.length === 0 || typeof d[0] === 'string') {
            lastMessage.bulkMessages = d.join(MSG_DELIM);
          } else {
            // If items are objects, try to use id, author, content, timestamp -> field delim then msg delim
            const mapped = d.map(item => {
              const id = item.id ?? item.messageId ?? '';
              const author = (item.author && (item.author.username ?? item.author.name)) ? (item.author.username ?? item.author.name) : (item.author ?? '');
              // ensure single-line content to keep delimiter parsing simple
              const content = (item.content ?? '').toString().replace(/\r?\n/g, ' ');
              const ts = item.createdTimestamp ?? item.timestamp ?? item.time ?? '';
              return `${id}${FIELD_DELIM}${author}${FIELD_DELIM}${content}${FIELD_DELIM}${ts}`;
            });
            lastMessage.bulkMessages = mapped.join(MSG_DELIM);
          }
        } else if (typeof d === 'string') {
          lastMessage.bulkMessages = d;
        } else {
          // unknown shape -> stringify fallback
          try { lastMessage.bulkMessages = JSON.stringify(d); } catch { lastMessage.bulkMessages = ''; }
        }
        return;
      }

      // optional other payload types your server might send (ack / ready / userProfile etc.) are ignored here
    });
  }

  // Helpers to resolve guild and channel IDs robustly
  function resolveGuildIdFromCache(nameOrId) {
    if (!nameOrId) return '';
    if (Object.keys(guildChannels).length === 0) return ''; // not ready
    // direct ID
    if (guildChannels[nameOrId]) return nameOrId;
    // case-insensitive name match
    const lower = String(nameOrId).toLowerCase();
    const found = Object.entries(guildChannels).find(([, v]) => (v.guildName ?? '').toLowerCase() === lower);
    return found ? found[0] : '';
  }

  function resolveChannelIdFromCache(guildNameOrId, channelNameOrId) {
    const gid = resolveGuildIdFromCache(guildNameOrId);
    if (!gid) return '';
    const g = guildChannels[gid];
    if (!g || !Array.isArray(g.channels)) return '';
    const look = String(channelNameOrId ?? '');
    // direct ID
    const direct = g.channels.find(c => c.id === look);
    if (direct) return direct.id;
    // case-insensitive name
    const lower = look.toLowerCase();
    const byName = g.channels.find(c => (c.name ?? '').toLowerCase() === lower);
    return byName ? byName.id : '';
  }

  // Main class for extension
  class DiscordBridge {
    getInfo() {
      return {
        id: 'discordBridge',
        name: 'Discord Bridge',
        color1: '#5865F2',
        color2: '#404EED',
        blocks: [
          // version
          { opcode: 'version', blockType: BlockType.REPORTER, text: 'version' },

          // connection
          { opcode: 'connect', blockType: BlockType.COMMAND, text: 'connect to bridge at [URL]', arguments: { URL: { type: ArgumentType.STRING, defaultValue: 'ws://localhost:3001' } } },
          { opcode: 'isConnected', blockType: BlockType.BOOLEAN, text: 'connected?' },
          { opcode: 'refreshChannels', blockType: BlockType.COMMAND, text: 'refresh server + channel list' },

          // sending / messages
          { opcode: 'sendMessage', blockType: BlockType.COMMAND, text: 'send message [TEXT] to channel [CHANNEL] in server [GUILD]', arguments: { TEXT: { type: ArgumentType.STRING, defaultValue: 'Hello!' }, CHANNEL: { type: ArgumentType.STRING, defaultValue: '' }, GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'getMessages', blockType: BlockType.REPORTER, text: 'get last [LIMIT] messages from channel [CHANNEL] in server [GUILD]', arguments: { LIMIT: { type: ArgumentType.NUMBER, defaultValue: 50 }, CHANNEL: { type: ArgumentType.STRING, defaultValue: '' }, GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },

          // guild/channel helpers
          { opcode: 'listGuilds', blockType: BlockType.REPORTER, text: 'all servers' },
          { opcode: 'allServerNames', blockType: BlockType.REPORTER, text: 'all server names' },
          { opcode: 'allServerIds', blockType: BlockType.REPORTER, text: 'all server ids' },
          { opcode: 'getGuildId', blockType: BlockType.REPORTER, text: 'get server id for [NAME]', arguments: { NAME: { type: ArgumentType.STRING, defaultValue: '' } } },

          { opcode: 'textChannels', blockType: BlockType.REPORTER, text: 'text channels in server [GUILD]', arguments: { GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'voiceChannels', blockType: BlockType.REPORTER, text: 'voice channels in server [GUILD]', arguments: { GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'channelsWithTypes', blockType: BlockType.REPORTER, text: 'all channels with types in server [GUILD]', arguments: { GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'getChannelId', blockType: BlockType.REPORTER, text: 'get channel id for [NAME] in server [GUILD]', arguments: { NAME: { type: ArgumentType.STRING, defaultValue: '' }, GUILD: { type: ArgumentType.STRING, defaultValue: '' } } },

          // message events
          { opcode: 'whenMessageReceived', blockType: BlockType.HAT, text: 'when discord message received' },
          { opcode: 'lastContent', blockType: BlockType.REPORTER, text: 'last msg content' },
          { opcode: 'lastAuthor', blockType: BlockType.REPORTER, text: 'last msg author' },
          { opcode: 'lastChannel', blockType: BlockType.REPORTER, text: 'last msg channel id' },
          { opcode: 'lastChannelName', blockType: BlockType.REPORTER, text: 'last msg channel name' },
          { opcode: 'lastChannelType', blockType: BlockType.REPORTER, text: 'last msg channel type' },
          { opcode: 'lastGuild', blockType: BlockType.REPORTER, text: 'last msg guild id' }
        ]
      };
    }

    // Connection
    connect(args) { connectWS(String(args.URL || wsUrl)); }
    isConnected() { return connected && ws && ws.readyState === WebSocket.OPEN; }
    refreshChannels() { if (this.isConnected()) ws.send(safeJSON({ type: 'getGuildChannels' })); }

    // Version reporter
    version() { return VERSION; }

    // Sending messages (resolves names -> IDs client-side using cache, then sends IDs to server)
    sendMessage(args) {
      if (!this.isConnected()) return;
      const gid = resolveGuildIdFromCache(args.GUILD);
      const cid = resolveChannelIdFromCache(args.GUILD, args.CHANNEL);
      if (!gid || !cid) return;
      ws.send(safeJSON({
        type: 'sendMessage',
        ref: Math.random().toString(36).slice(2),
        guildId: gid,
        channelId: cid,
        content: String(args.TEXT ?? '')
      }));
    }

    // Bulk messages - sends request to server, server responds with 'messages' payload; returns last cached bulkMessages
    getMessages(args) {
      if (!this.isConnected()) return '';
      const cid = resolveChannelIdFromCache(args.GUILD, args.CHANNEL);
      if (!cid) return '';
      ws.send(safeJSON({
        type: 'getMessages',
        ref: Math.random().toString(36).slice(2),
        channelId: cid,
        limit: Number(args.LIMIT) || 50
      }));
      return lastMessage.bulkMessages || '';
    }

    // Guild / Channel helpers
    listGuilds() {
      return Object.values(guildChannels).map(g => g.guildName).join(', ');
    }

    // NEW: all server names (order matches allServerIds)
    allServerNames() {
      if (!guildChannels || Object.keys(guildChannels).length === 0) return '';
      return Object.values(guildChannels).map(g => g.guildName).join(SERVER_DELIM);
    }

    // NEW: all server ids (order matches allServerNames)
    allServerIds() {
      if (!guildChannels || Object.keys(guildChannels).length === 0) return '';
      return Object.entries(guildChannels).map(([id]) => id).join(SERVER_DELIM);
    }

    getGuildId(args) {
      return resolveGuildIdFromCache(args.NAME);
    }

    textChannels(args) {
      const gid = resolveGuildIdFromCache(args.GUILD);
      if (!gid) return '';
      const g = guildChannels[gid];
      if (!g) return '';
      return g.channels.filter(c => c.type === 0).map(c => c.name).join(', ');
    }

    voiceChannels(args) {
      const gid = resolveGuildIdFromCache(args.GUILD);
      if (!gid) return '';
      const g = guildChannels[gid];
      if (!g) return '';
      return g.channels.filter(c => c.type === 2).map(c => c.name).join(', ');
    }

    channelsWithTypes(args) {
      const gid = resolveGuildIdFromCache(args.GUILD);
      if (!gid) return '';
      const g = guildChannels[gid];
      if (!g) return '';
      return g.channels.map(c => `${c.name} (${c.type})`).join(', ');
    }

    getChannelId(args) {
      return resolveChannelIdFromCache(args.GUILD, args.NAME);
    }

    // Message events & reporters
    whenMessageReceived() { if (messageQueue.length > 0) { messageQueue.shift(); return true; } return false; }
    lastContent() { return lastMessage.content; }
    lastAuthor() { return lastMessage.author; }
    lastChannel() { return lastMessage.channelId; }
    lastChannelName() { return lastMessage.channelName; }
    lastChannelType() { return lastMessage.channelType; }
    lastGuild() { return lastMessage.guildId; }
  }

  // ensure hats exist in VM runtime
  if (vmRuntime && !vmRuntime._hats) vmRuntime._hats = {};
  if (vmRuntime) vmRuntime._hats['discordBridge_whenMessageReceived'] = { edgeActivated: false, restartExistingThreads: false };

  Scratch.extensions.register(new DiscordBridge());
})(Scratch);
