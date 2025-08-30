require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');

const client = new Client();

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('Token works!'))
  .catch(err => console.error('Token invalid:', err.message));