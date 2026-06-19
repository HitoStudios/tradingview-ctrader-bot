/**
 * Local development server for testing TradingView webhook endpoints.
 *
 * Usage:
 *   node local-server.mjs                # starts on http://localhost:3000
 *   PORT=8080 node local-server.mjs      # custom port
 *
 * Then test it:
 *   node test-webhook.mjs http://localhost:3000
 *   # or use curl/postman
 */

import http from 'http';

// Helper to parse JSON body
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

// Helper to create mock req/res objects for Vercel handlers
function createMocks(req, body) {
  return {
    req: {
      method: req.method,
      headers: req.headers,
      body: body,
    },
    res: {
      _status: 200,
      _headers: {},
      _body: null,
      _sent: false,
      status(code) { this._status = code; return this; },
      json(data) { this._body = data; this._sent = true; },
      end(data) {
        if (data) this._body = data;
        this._sent = true;
      },
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
    }
  };
}

async function handleRequest(handler, req, res) {
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseBody(req) : {};
    const { req: mockReq, res: mockRes } = createMocks(req, body);

    await handler(mockReq, mockRes);

    // Copy mockRes response to real res
    res.writeHead(mockRes._status || 200, mockRes._headers || {});
    if (mockRes._body) {
      res.end(JSON.stringify(mockRes._body));
    } else {
      res.end();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const PORT = parseInt(process.env.PORT || '3000', 10);

console.log('Starting local dev server...\n');

// Dynamically import the Vercel handlers
const [webhookHandler, signalHandler] = await Promise.all([
  import('./api/webhook.js').then(m => m.default),
  import('./api/latest-signal.js').then(m => m.default),
]);

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

  // Route requests to the appropriate handler
  if (url.pathname === '/api/webhook') {
    await handleRequest(webhookHandler, req, res);
  } else if (url.pathname === '/api/latest-signal') {
    await handleRequest(signalHandler, req, res);
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>TradingView → cTrader Signal Bot</h1>
      <p>Server is running. Available endpoints:</p>
      <ul>
        <li><code>POST /api/webhook</code> — Receive TradingView alerts</li>
        <li><code>GET /api/latest-signal</code> — Read latest signal</li>
        <li><code>DELETE /api/latest-signal</code> — Consume (delete) latest signal</li>
      </ul>
      <p>Test it: <code>curl -X POST http://localhost:${PORT}/api/webhook -H "Content-Type: application/json" -d '{"Action":"DiMea Long","entry":142.5,"tp1":143.2,"tp2":143.8,"tp3":144.5,"sl":141.8,"symbol":"NASDAQ:US100","notional":150}'</code></p>
      <hr>
      <p><strong>Note:</strong> Using in-memory storage (no Redis needed). Signals are lost on restart.</p>
    `);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try POST /api/webhook or GET /api/latest-signal' }));
  }
});

server.listen(PORT, () => {
  console.log(`  🌐  Server running at http://localhost:${PORT}`);
  console.log(`  📥  POST /api/webhook         — Receive TradingView alerts`);
  console.log(`  📤  GET  /api/latest-signal    — Read latest signal`);
  console.log(`  🗑️   DELETE /api/latest-signal  — Consume (delete) signal`);
  console.log(`\n  🧪  Run tests: node test-webhook.mjs http://localhost:${PORT}`);
  console.log(`  📋  Or:      curl -X POST http://localhost:${PORT}/api/webhook \\`);
  console.log(`                   -H "Content-Type: application/json" \\`);
  console.log(`                   -d '{"Action":"DiMea Long","entry":142.5,"tp1":143.2,"tp2":143.8,"tp3":144.5,"sl":141.8,"symbol":"NASDAQ:US100","notional":150}'`);
  console.log(`\n  ⚡  No Redis needed — runs with in-memory storage`);
});
