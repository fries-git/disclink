class DiscordLink {
  constructor(runtime) {
    this.runtime = runtime;
    this.ws = null;
    this.connected = false;
    this.discordReady = false;
    this.guilds = [];
    this.serversMenu = [];  // dropdown menu
    this.channelsMenu = {};  // dropdown menu per server
  }

  getInfo() {
    return {
      id: 'disclink',
      name: 'Discord Link',
      color1: '#7289DA',
      blocks: [
        {
          opcode: 'connect',
          blockType: 'command',
          text: 'connect to bridge [URL]',
          arguments: { URL: { type: 'string', defaultValue: 'ws://localhost:3001' } }
        },
        {
          opcode: 'isConnected',
          blockType: 'Boolean',
          text: 'bridge connected?'
        },
        {
          opcode: 'isDiscordReady',
          blockType: 'Boolean',
          text: 'discord ready?'
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
          arguments: { GUILD: { type: 'string', menu: 'servers' } }
        },
        {
          opcode: 'sendMessage',
          blockType: 'command',
          text: 'send [TEXT] in channel [CHANNEL] of server [SERVER]',
          arguments: {
            TEXT: { type: 'string', defaultValue: 'Hello world!' },
            CHANNEL: { type: 'string', menu: 'channels', defaultValue: '' },
            SERVER: { type: 'string', menu: 'servers', defaultValue: '' }
          }
        },
        {
          opcode: 'mentionUser',
          blockType: 'reporter',
          text: 'mention user [ID]',
          arguments: { ID: { type: 'string', defaultValue: '1234567890' } }
        }
      ],
      menus: {
        servers: () => this.serversMenu,
        channels: args => this.channelsMenu[args.SERVER] || []
      }
    };
  }

  connect({ URL }) {
    this.ws = new WebSocket(URL);
    this.ws.onopen = () => {
      this.connected = true;
      this.ws.send(JSON.stringify({ type: 'getGuildChannels' }));
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.discordReady = false;
      this.guilds = [];
      this.serversMenu = [];
      this.channelsMenu = {};
    };
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'bridgeStatus') {
        this.connected = true;
        this.discordReady = msg.discordReady;
      }
      if (msg.type === 'discordReady') {
        this.discordReady = true;
        this.ws.send(JSON.stringify({ type: 'getGuildChannels' }));
      }
      if (msg.type === 'guildChannels') {
        this.guilds = msg.data || [];
        // populate menus
        this.serversMenu = this.guilds.map(g => g.guildName);
        this.channelsMenu = {};
        this.guilds.forEach(g => {
          this.channelsMenu[g.guildName] = g.channels.map(c => c.name);
        });
      }
    };
  }

  isConnected() { return !!this.connected; }
  isDiscordReady() { return !!this.discordReady; }

  getGuilds() {
    return this.guilds.map(g => g.guildName).join(', ');
  }

  getChannels({ GUILD }) {
    const guild = this.guilds.find(g => g.guildName === GUILD);
    if (!guild) return '';
    return guild.channels.map(c => c.name).join(', ');
  }

  sendMessage({ TEXT, CHANNEL, SERVER }) {
    if (!this.ws) return;
    const fixed = TEXT.replace(/@(\d{5,})/g, '<@$1>');
    this.ws.send(JSON.stringify({
      type: 'sendMessage',
      guildName: SERVER,
      channelName: CHANNEL,
      content: fixed
    }));
  }

  mentionUser({ ID }) { return `<@${ID}>`; }
}

Scratch.extensions.register(new DiscordLink());
