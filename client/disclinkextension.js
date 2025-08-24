(function (Scratch) {
  'use strict';

  const vmRuntime = Scratch.vm?.runtime;
  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;

  // Store guild + channel structure
  let guildChannels = {};

  const messageQueue = [];
  let lastMessage = {
    content: '',
    author: '',
    channelId: '',
    guildId: '',
    bot: false
  };

  let ws = null;
  let wsUrl = 'ws://localhost:3001';
  let connected = false;

  function safeJSON(obj) {
    try { return JSON.stringify(obj); } catch { return '{}'; }
  }

  function connectWS(url) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    wsUrl = url || wsUrl;

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      connected = true;
      // request guild + channel scan on connect
      ws.send(safeJSON({ type: 'getGuildChannels' }));
    });

    ws.addEventListener('close', () => {
      connected = false;
      setTimeout(() => connectWS(wsUrl), 1500);
    });

    ws.addEventListener('message', (evt) => {
      let payload;
      try { payload = JSON.parse(evt.data); } catch { return; }

      if (payload?.type === 'messageCreate' && payload.data) {
        const d = payload.data;
        lastMessage = {
          content: String(d.content ?? ''),
          author: String(d.author?.username ?? ''),
          channelId: String(d.channelId ?? ''),
          guildId: String(d.guildId ?? ''),
          bot: !!d.author?.bot
        };
        messageQueue.push(lastMessage);

        if (vmRuntime) {
          vmRuntime.startHats('discordBridge_whenMessageReceived');
        }
      }
      else if (payload?.type === 'guildChannels' && payload.data) {
        guildChannels = payload.data; // Expecting { guildId: { name, channels: [{id, name}...] } }
      }
    });
  }

  class DiscordBridge {
    getInfo() {
      return {
        id: 'discordBridge',
        name: 'Discord Bridge',
        color1: '#5865F2',
        color2: '#404EED',
        blocks: [
          {
            opcode: 'connect',
            blockType: BlockType.COMMAND,
            text: 'connect to bridge at [URL]',
            arguments: {
              URL: { type: ArgumentType.STRING, defaultValue: 'ws://localhost:3001' }
            }
          },
          {
            opcode: 'isConnected',
            blockType: BlockType.BOOLEAN,
            text: 'connected?'
          },
          {
            opcode: 'sendMessage',
            blockType: BlockType.COMMAND,
            text: 'send message [TEXT] to channel [CHANNEL]',
            arguments: {
              TEXT: { type: ArgumentType.STRING, defaultValue: 'Hello from Scratch!' },
              CHANNEL: { type: ArgumentType.STRING, defaultValue: '123456789012345678' }
            }
          },
          {
            opcode: 'refreshChannels',
            blockType: BlockType.COMMAND,
            text: 'refresh server + channel list'
          },
          {
            opcode: 'listGuilds',
            blockType: BlockType.REPORTER,
            text: 'all servers'
          },
          {
            opcode: 'listChannels',
            blockType: BlockType.REPORTER,
            text: 'channels in server [GUILD]',
            arguments: {
              GUILD: { type: ArgumentType.STRING, defaultValue: 'guild id here' }
            }
          },
          {
            opcode: 'whenMessageReceived',
            blockType: BlockType.HAT,
            text: 'when discord message received'
          },
          {
            opcode: 'lastContent',
            blockType: BlockType.REPORTER,
            text: 'last msg content'
          },
          {
            opcode: 'lastAuthor',
            blockType: BlockType.REPORTER,
            text: 'last msg author'
          },
          {
            opcode: 'lastChannel',
            blockType: BlockType.REPORTER,
            text: 'last msg channel id'
          },
          {
            opcode: 'lastGuild',
            blockType: BlockType.REPORTER,
            text: 'last msg guild id'
          }
        ]
      };
    }

    connect(args) {
      const url = String(args.URL || '').trim();
      connectWS(url);
    }

    isConnected() {
      return connected && ws && ws.readyState === WebSocket.OPEN;
    }

    sendMessage(args) {
      if (!this.isConnected()) return;
      const msg = {
        type: 'sendMessage',
        ref: Math.random().toString(36).slice(2),
        channelId: String(args.CHANNEL ?? ''),
        content: String(args.TEXT ?? '')
      };
      ws.send(safeJSON(msg));
    }

    refreshChannels() {
      if (!this.isConnected()) return;
      ws.send(safeJSON({ type: 'getGuildChannels' }));
    }

    listGuilds() {
      return Object.values(guildChannels).map(g => g.name).join(', ');
    }

    listChannels(args) {
      const g = guildChannels[args.GUILD];
      if (!g) return '';
      return g.channels.map(c => c.name).join(', ');
    }

    whenMessageReceived() {
      if (messageQueue.length > 0) {
        messageQueue.shift();
        return true;
      }
      return false;
    }

    lastContent() { return String(lastMessage.content ?? ''); }
    lastAuthor()  { return String(lastMessage.author ?? ''); }
    lastChannel() { return String(lastMessage.channelId ?? ''); }
    lastGuild()   { return String(lastMessage.guildId ?? ''); }
  }

  if (vmRuntime && !vmRuntime._hats) vmRuntime._hats = {};
  if (vmRuntime) {
    vmRuntime._hats['discordBridge_whenMessageReceived'] = {
      edgeActivated: false,
      restartExistingThreads: false
    };
  }

  Scratch.extensions.register(new DiscordBridge());
})(Scratch);
