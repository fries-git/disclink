class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.channels = {}; // serverName -> array of channel names
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

  connect({ URL }) {
    if (this.ws) this.ws.close();
    this.ws = new WebSocket(URL);

    this.ws.onopen = () => {
      this.connected = true;
      this.refreshServers();
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.discordReady = false;
      this.guilds = [];
      this.channels = {};
    };

    this.ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);

        if (msg.type === 'bridgeStatus') {
          this.connected = !!msg.bridgeConnected;
          this.discordReady = !!msg.discordReady;
        }

        if (msg.type === 'guildChannels') {
          this.discordReady = true;
          this.guilds = msg.data.map(g => g.guildName || 'Unknown');
          this.channels = {};
          msg.data.forEach(g => {
            this.channels[g.guildName] = g.channels.map(c => c.name || '');
          });
        }

        if (msg.type === 'ack') {
          // optional: handle message send acknowledgment
        }

      } catch (e) {
        console.error('WS parse error', e);
      }
    };
  }

  // Booleans
  isConnected() { return !!this.connected; }
  isDiscordReady() { return !!this.discordReady; }

  // Reporters
  getGuilds() { return this.guilds.join(', ') || "No servers"; }
  getChannels({ SERVER }) { return this.channels[SERVER]?.join(', ') || "No channels"; }

  // Refresh
  refreshServers() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'getGuildChannels' }));
  }
  refreshChannels({ SERVER }) { this.refreshServers(); }

  // Send message
  sendMessage({ CONTENT, CHANNEL, SERVER }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'sendMessage', guildName: SERVER, channelName: CHANNEL, content: CONTENT }));
  }

  // Mention user
  mentionUser({ ID }) { return `<@${ID}>`; }
}

Scratch.extensions.register(new DiscordLink());
