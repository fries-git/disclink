(function (Scratch) {
  'use strict';

  const vmRuntime = Scratch.vm?.runtime;
  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;

  const messageQueue = [];
  let lastMessage = {
    content: '',
    author: '',
    channelId: '',
    channelName: '',
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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    wsUrl = url || wsUrl;

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => { connected = true; });
    ws.addEventListener('close', () => {
      connected = false;
      setTimeout(() => connectWS(wsUrl), 1500);
    });
    ws.addEventListener('error', () => {});

    ws.addEventListener('message', (evt) => {
      let payload;
      try { payload = JSON.parse(evt.data); } catch { return; }

      if (payload?.type === 'messageCreate' && payload.data) {
        const d = payload.data;
        lastMessage = {
          content: String(d.content ?? ''),
          author: String(d.author?.username ?? ''),
          channelId: String(d.channelId ?? ''),
          channelName: String(d.channelName ?? ''),
          guildId: String(d.guildId ?? ''),
          bot: !!d.author?.bot
        };
        messageQueue.push(lastMessage);

        if (vmRuntime) {
          vmRuntime.startHats('discordBridge_whenMessageReceived');
        }
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
            arguments: { URL: { type: ArgumentType.STRING, defaultValue: 'ws://localhost:3001' } }
          },
          { opcode: 'isConnected', blockType: BlockType.BOOLEAN, text: 'connected?' },
          {
            opcode: 'sendMessage',
            blockType: BlockType.COMMAND,
            text: 'send message [TEXT] to channel [CHANNEL] as [USERNAME] avatar [AVATAR]',
            arguments: {
              TEXT: { type: ArgumentType.STRING, defaultValue: 'Hello from Scratch!' },
              CHANNEL: { type: ArgumentType.STRING, defaultValue: '123456789012345678' },
              USERNAME: { type: ArgumentType.STRING, defaultValue: '' },
              AVATAR: { type: ArgumentType.STRING, defaultValue: '' }
            }
          },
          {
            opcode: 'setPresence',
            blockType: BlockType.COMMAND,
            text: 'set presence [KIND] [TEXT]',
            arguments: {
              KIND: { type: ArgumentType.STRING, menu: 'presenceKinds', defaultValue: 'Playing' },
              TEXT: { type: ArgumentType.STRING, defaultValue: 'with Scratch blocks' }
            }
          },
          { opcode: 'whenMessageReceived', blockType: BlockType.HAT, text: 'when discord message received' },
          { opcode: 'lastContent', blockType: BlockType.REPORTER, text: 'last msg content' },
          { opcode: 'lastAuthor', blockType: BlockType.REPORTER, text: 'last msg author' },
          { opcode: 'lastChannel', blockType: BlockType.REPORTER, text: 'last msg channel id' },
          { opcode: 'lastChannelName', blockType: BlockType.REPORTER, text: 'last msg channel name' },
          { opcode: 'lastGuild', blockType: BlockType.REPORTER, text: 'last msg guild id' }
        ],
        menus: { presenceKinds: { acceptReporters: true, items: ['Playing', 'Listening', 'Watching', 'Competing'] } }
      };
    }

    connect(args) { connectWS(String(args.URL || '').trim()); }
    isConnected() { return connected && ws && ws.readyState === WebSocket.OPEN; }

    sendMessage(args) {
      if (!this.isConnected()) return;
      ws.send(safeJSON({
        type: 'sendMessage',
        ref: Math.random().toString(36).slice(2),
        channelId: String(args.CHANNEL ?? ''),
        content: String(args.TEXT ?? ''),
        username: String(args.USERNAME ?? '') || undefined,
        avatarURL: String(args.AVATAR ?? '') || undefined
      }));
    }

    setPresence(args) {
      if (!this.isConnected()) return;
      ws.send(safeJSON({
        type: 'setPresence',
        ref: Math.random().toString(36).slice(2),
        kind: String(args.KIND ?? 'Playing'),
        text: String(args.TEXT ?? '')
      }));
    }

    whenMessageReceived() {
      if (messageQueue.length > 0) {
        messageQueue.shift();
        return true;
      }
      return false;
    }

    lastContent() { return String(lastMessage.content ?? ''); }
    lastAuthor() { return String(lastMessage.author ?? ''); }
    lastChannel() { return String(lastMessage.channelId ?? ''); }
    lastChannelName() { return String(lastMessage.channelName ?? ''); }
    lastGuild() { return String(lastMessage.guildId ?? ''); }
  }

  if (vmRuntime && !vmRuntime._hats) vmRuntime._hats = {};
  if (vmRuntime) {
    vmRuntime._hats['discordBridge_whenMessageReceived'] = { edgeActivated: false, restartExistingThreads: false };
  }

  Scratch.extensions.register(new DiscordBridge());
})(Scratch);
