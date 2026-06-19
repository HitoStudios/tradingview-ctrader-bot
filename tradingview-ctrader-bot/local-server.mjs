/**
 * Local validation server — tests TradingView signal parsing & validation only.
 *
 * Does NOT call the cTrader API. Use this to verify your alert format before
 * deploying to Vercel (where the real cTrader API calls happen).
 *
 * Zero dependencies:
 *   node local-server.mjs
 *   PORT=8080 node local-server.mjs
 */

import http from 'http';

// ─── Validation (mirrors webhook.js logic without cTrader API calls) ───

function normaliseSymbol(sym) {
  if (!sym) return null;
  const idx = sym.lastIndexOf(':');
  return idx >= 0 && idx < sym.length - 1 ? sym.substring(idx + 1).trim() : sym.trim();
}

function validate(signal) {
  if (!signal || !signal.Action || !signal.symbol) {
    return { error: 'Missing required fields: Action, symbol' };
  }
  if (!signal.Action.endsWith(' Long') && !signal.Action.endsWith(' Short')) {
    return { error: `Action must end with " Long" or " Short", got "${signal.Action}"` };
  }
  if (typeof signal.entry !== 'number' || signal.entry <= 0) {
    return { error: `entry must be > 0, got ${signal.entry}` };
  }
  if (typeof signal.sl !== 'number' || signal.sl <= 0) {
    return { error: `sl must be > 0, got ${signal.sl}` };
  }
  if (typeof signal.notional !== 'number' || signal.notional <= 0) {
    return { error: `notional must be > 0, got ${signal.notional}` };
  }
  return null;
}

// ─── Self-Test ───

async function handleSelfTest(req, res) {
  const results = [];
  let passed = 0, failed = 0;
  const add = (name, ok, detail) => { results.push({ name, ok, detail }); ok ? passed++ : failed++; };

  const good = {
    Action: 'DiMea Long', entry: 142.50, tp1: 143.20, tp2: 143.80, tp3: 144.50,
    sl: 141.80, symbol: 'NASDAQ:US100', notional: 150,
  };

  add('Valid Long signal', validate(good) === null, 'passes');
  add('Symbol normalisation — NASDAQ:US100', normaliseSymbol('NASDAQ:US100') === 'US100', '→ US100');
  add('Symbol normalisation — FX:EURUSD', normaliseSymbol('FX:EURUSD') === 'EURUSD', '→ EURUSD');
  add('Symbol normalisation — raw US100', normaliseSymbol('US100') === 'US100', '→ US100');
  add('Missing Action', validate({}).error?.includes('Missing'), 'detected');
  add('Bad Action format', validate({ Action: 'Hello World', symbol: 'X', entry: 1, sl: 1, notional: 1 }).error?.includes('Long/Short'), 'detected');
  add('Negative entry', validate({ ...good, entry: -1 }).error?.includes('entry'), 'detected');
  add('Zero notional', validate({ ...good, notional: 0 }).error?.includes('notional'), 'detected');
  add('Valid Short', validate({ ...good, Action: 'SMART Short' }) === null, 'passes');

  // Volume calculation test
  const notional = 150;
  const entry = 142.5;
  const volume = Math.round(notional / entry);
  add('Volume calc: $150 @ 142.5', volume === 1, `${volume} unit${volume !== 1 ? 's' : ''}`);

  const total = passed + failed;
  const pct = total > 0 ? Math.round(passed / total * 100) : 0;
  const color = failed === 0 ? '#4CAF50' : '#f44336';

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html><head><title>Self-Test — Validation Only</title>
    <style>
      body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
      h1 { margin-bottom: 0; } .note { color: #888; font-size: 0.9em; margin-top: 4px; }
      .summary { font-size: 1.2em; padding: 16px; border-radius: 8px; margin: 16px 0; background: ${color}15; border: 2px solid ${color}; }
      .summary strong { color: ${color}; }
      table { width: 100%; border-collapse: collapse; }
      td, th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
      th { background: #f5f5f5; } .pass { color: #4CAF50; } .fail { color: #f44336; }
      .detail { color: #666; font-size: 0.85em; }
    </style></head>
    <body>
    <h1>Validation Self-Test</h1>
    <p class="note">Tests signal parsing only — no cTrader API calls.</p>
    <div class="summary"><strong>${passed}/${total} passed (${pct}%)</strong></div>
    <table>
      <tr><th>#</th><th>Test</th><th>Result</th><th class="detail">Detail</th></tr>
      ${results.map((r, i) => `<tr><td>${i+1}</td><td>${r.name}</td><td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✅' : '❌'}</td><td class="detail">${r.detail || ''}</td></tr>`).join('')}
    </table>
    <p><a href="/">← Back</a></p>
    </body></html>
  `);
}

// ─── Server ───

const PORT = parseInt(process.env.PORT || '3000', 10);

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/test' || url.pathname === '/api/self-test') {
      await handleSelfTest(req, res);
    } else if (url.pathname === '/' || url.pathname === '/api') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html><head><title>TradingView → cTrader — Local Validator</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
          .ep { background: #f9f9f9; border-left: 4px solid #2196F3; padding: 12px 16px; margin: 10px 0; border-radius: 0 6px 6px 0; }
          a { display: inline-block; background: #2196F3; color: white; text-decoration: none; padding: 10px 20px; border-radius: 6px; }
        </style></head>
        <body>
        <h1>TradingView → cTrader (Open API)</h1>
        <p><strong>Local validation server</strong> — tests your alert format.</p>
        <div class="ep"><code>POST /api/webhook</code> Validate alerts (parsing only, no trade)</div>
        <a href="/api/test">▶ Run Self-Test</a>
        <hr><p><em>cTrader trades are only executed when deployed to Vercel with credentials configured.</em></p>
        </body></html>
      `);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  🧪  http://localhost:${PORT}/api/test`);
  console.log(`\n  Validation only — no trades executed.`);
  console.log(`  Deploy to Vercel with CTRADER_* env vars to enable real trading.`);
});
