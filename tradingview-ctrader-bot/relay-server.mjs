/**
 * Relay server for TradingView → cTrader cBot.
 *
 * Provides:
 *   POST /webhook   — receive TradingView signals (from Vercel)
 *   WebSocket /     — cBots connect here to receive signals
 *
 * Deploy on Railway (free tier) for 24/7 uptime.
 *
 * Usage:
 *   export RELAY_PORT=8080
 *   node relay-server.mjs
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.RELAY_PORT || '8080', 10);

// ─── Signal model ───
let latestSignal = null;
let signalId = 0;

// ─── HTTP Server ───
const httpServer = createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /health — health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      clients: wss.clients.size,
      hasSignal: !!latestSignal,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    }));
  }

  // POST /webhook — receive signal from Vercel
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const signal = JSON.parse(body);
        if (!signal.Action || !signal.symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing Action or symbol' }));
        }

        signal._id = `${++signalId}_${Date.now()}`;
        signal._receivedAt = new Date().toISOString();
        latestSignal = signal;

        // Broadcast to all connected cBots
        const msg = JSON.stringify({ type: 'signal', data: signal });
        let count = 0;
        wss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(msg);
            count++;
          }
        });

        console.log(`[${signal._receivedAt}] Signal broadcast to ${count} bots: ${signal.Action} ${signal.symbol}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id: signal._id, clients: count }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', detail: e.message }));
      }
    });
    return;
  }

  // Fallback
  res.writeHead(404);
  res.end('Not Found');
});

// ─── WebSocket Server ───
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[ws] Client connected: ${clientIp} (total: ${wss.clients.size})`);

  // Send latest signal immediately if one exists
  if (latestSignal) {
    ws.send(JSON.stringify({ type: 'signal', data: latestSignal }));
  }

  // Send welcome
  ws.send(JSON.stringify({ type: 'welcome', data: { clientIp, serverTime: new Date().toISOString() } }));

  ws.on('close', () => {
    console.log(`[ws] Client disconnected: ${clientIp} (total: ${wss.clients.size})`);
  });

  ws.on('error', err => {
    console.error(`[ws] Error: ${clientIp} — ${err.message}`);
  });
});

// ─── Start ───
const startTime = Date.now();
httpServer.listen(PORT, () => {
  console.log(`\n📡  Relay Server running on port ${PORT}`);
  console.log(`   POST /webhook     ← Vercel forwards TradingView signals here`);
  console.log(`   WS   /            ← cBots connect here`);
  console.log(`   GET  /health      ← Health check\n`);
});
