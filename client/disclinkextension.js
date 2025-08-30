class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.ws = null;
    this.guilds = [];
    this.messages = [];
  }

  getInfo() {
    return {
      id: 'disclink',
      name: 'Discord Link',
      blocks: [
        {
          opcode: 'connect',
          blockType: 'command',
          text: 'connect to bridge [URL]',
          arguments: { URL: { type: 'string', defaultValue: 'ws://localhost:3001' } }
        },
        {
          opcode: 'getGuilds',
          blockType: 'reporter',
          text: 'server list'
        },
        {
          opcode: 'getChannels',
          blockType: 'reporter',
          text: 'channels in server [GUILD]',
          arguments: { GUILD: { type: 'string', defaultValue: '' } }
        },
        {
          opcode: 'getMessages',
          blockType: 'reporter',
          text: 'messages in channel [CHANNEL]',
          arguments: { CHANNEL: { type: 'string', defaultValue: '' } }
        },
        {
          opcode: 'sendMessage',
          blockType: 'command',
          text: 'send [TEXT] to channel [CHANNEL]',
          arguments: {
            TEXT: { type: 'string', defaultValue: 'Hello world!' },
            CHANNEL: { type: 'string', defaultValue: '' }
          }
        }
      ]
    };
  }

  connect({ URL }) {
    this.ws = new WebSocket(URL);
    this.ws.onopen = () => console.log('[DiscordLink] Connected');
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'guildChannels' && msg.data) {
        this.guilds = msg.data;
      }
      if (msg.type === 'messages' && msg.data) {
        this.messages = msg.data;
      }
    };
  }

  getGuilds() {
    return this.guilds.map(g => g.guildName).join(', ');
  }

  getChannels({ GUILD }) {
    const guild = this.guilds.find(g => g.guildName === GUILD || g.guildId === GUILD);
    if (!guild) return '';
    return guild.channels.map(c => c.name).join(', ');
  }

  getMessages({ CHANNEL }) {
    if (!this.ws) return '';
    this.ws.send(JSON.stringify({ type: 'getMessages', channelId: CHANNEL, limit: 10, ref: 'scratch' }));
    return this.messages.map(m => `${m.author}: ${m.content}`).join('\n');
  }

  sendMessage({ TEXT, CHANNEL }) {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ type: 'sendMessage', channelId: CHANNEL, content: TEXT }));
  }
}

Scratch.extensions.register(new DiscordLink());
