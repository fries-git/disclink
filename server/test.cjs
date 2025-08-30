// ws-test.js
const WebSocket = require('ws');

const URL = process.argv[2] || 'ws://localhost:3001';
const ws = new WebSocket(URL);

ws.on('open', () => {
  console.log('[test] connected to', URL);
  // request guild channels
  ws.send(JSON.stringify({ type: 'getGuildChannels' }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log('[test] received:', msg.type, JSON.stringify(msg).slice(0, 200));
  } catch (e) {
    console.log('[test] raw:', data.toString());
  }
});

ws.on('error', e => console.error('[test] error', e));
ws.on('close', (c, r) => console.log('[test] closed', c, r));
