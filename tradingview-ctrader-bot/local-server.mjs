/**
 * Local development server for testing TradingView webhook endpoints.
 *
 * Zero dependencies — just run directly:
 *   node local-server.mjs                # starts on http://localhost:3000
 *   PORT=8080 node local-server.mjs      # custom port
 *
 * Then test it:
 *   curl -X POST http://localhost:3000/api/webhook ...
 *   node test-webhook.mjs http://localhost:3000
 */

import http from 'http';

// ─── In-memory signal store (no Redis needed) ───

let signalStore = null;

// ─── Route handlers (self-contained, no external imports) ───

function handleWebhook(reqBody) {
  // Validate required fields
  if (!reqBody || !reqBody.Action || !reqBody.symbol) {
    return {
      status: 400,
      body: { error: 'Missing required fields: Action, symbol', received: reqBody },
    };
  }

  // Validate Action format — must end with " Long" or " Short"
  if (!reqBody.Action.endsWith(' Long') && !reqBody.Action.endsWith(' Short')) {
    return {
      status: 400,
      body: { error: 'Action must end with " Long" or " Short" (e.g., "DiMea Long")', received: reqBody.Action },
    };
  }

  // Validate numeric fields
  if (typeof reqBody.entry !== 'number' || reqBody.entry <= 0) {
    return { status: 400, body: { error: 'entry must be a positive number', received: reqBody.entry } };
  }
  if (typeof reqBody.sl !== 'number' || reqBody.sl <= 0) {
    return { status: 400, body: { error: 'sl must be a positive number', received: reqBody.sl } };
  }
  if (typeof reqBody.notional !== 'number' || reqBody.notional <= 0) {
    return { status: 400, body: { error: 'notional must be a positive number', received: reqBody.notional } };
  }

  // Add timestamp and unique ID
  reqBody._receivedAt = new Date().toISOString();
  reqBody._id = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Store
  signalStore = reqBody;

  console.log('Signal stored:', reqBody._id, reqBody.Action, reqBody.symbol);

  return {
    status: 200,
    body: { success: true, id: reqBody._id, message: `Signal stored for ${reqBody.symbol} - ${reqBody.Action}` },
  };
}

function handleGetSignal() {
  if (!signalStore) {
    return { status: 204, body: null };
  }
  return { status: 200, body: signalStore };
}

function handleDeleteSignal() {
  if (!signalStore) {
    return { status: 204, body: null };
  }
  const signal = signalStore;
  signalStore = null;
  return { status: 200, body: signal };
}

// ─── Server ───

const PORT = parseInt(process.env.PORT || '3000', 10);

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    let result;

    if (url.pathname === '/api/webhook' && req.method === 'POST') {
      const body = await parseBody(req);
      result = handleWebhook(body);
    } else if (url.pathname === '/api/latest-signal' && req.method === 'GET') {
      result = handleGetSignal();
    } else if (url.pathname === '/api/latest-signal' && req.method === 'DELETE') {
      result = handleDeleteSignal();
    } else if (url.pathname === '/api/webhook') {
      result = { status: 405, body: { error: 'Method not allowed. Use POST.' } };
    } else if (url.pathname === '/api/latest-signal') {
      result = { status: 405, body: { error: 'Method not allowed. Use GET or DELETE.' } };
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <h1>TradingView → cTrader Signal Bot</h1>
        <p>Server running. Available endpoints:</p>
        <ul>
          <li><code>POST /api/webhook</code> — Receive TradingView alerts</li>
          <li><code>GET /api/latest-signal</code> — Read latest signal</li>
          <li><code>DELETE /api/latest-signal</code> — Consume (delete) latest signal</li>
        </ul>
        <p>Test: <code>curl -X POST http://localhost:${PORT}/api/webhook -H "Content-Type: application/json" -d '{"Action":"DiMea Long","entry":142.5,"tp1":143.2,"tp2":143.8,"tp3":144.5,"sl":141.8,"symbol":"NASDAQ:US100","notional":150}'</code></p>
        <hr>
        <p><strong>Zero dependencies.</strong> No npm install needed. Uses in-memory storage.</p>
      `);
      return;
    } else {
      result = { status: 404, body: { error: 'Not found. Try POST /api/webhook or GET /api/latest-signal' } };
    }

    if (result.body !== null) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } else {
      res.writeHead(result.status);
      res.end();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`  🌐  Server running at http://localhost:${PORT}`);
  console.log(`  📥  POST /api/webhook         — Receive TradingView alerts`);
  console.log(`  📤  GET  /api/latest-signal    — Read latest signal`);
  console.log(`  🗑️   DELETE /api/latest-signal  — Consume (delete) signal`);
  console.log(`\n  🧪  Test: curl -X POST http://localhost:${PORT}/api/webhook \\`);
  console.log(`                   -H "Content-Type: application/json" \\`);
  console.log(`                   -d '{"Action":"DiMea Long","entry":142.5,"tp1":143.2,"tp2":143.8,"tp3":144.5,"sl":141.8,"symbol":"NASDAQ:US100","notional":150}'`);
  console.log(`\n  ⚡  Zero dependencies. No npm install needed.`);
});
