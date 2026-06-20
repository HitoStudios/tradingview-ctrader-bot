/**
 * cTrader Trader — persistent server that connects to cTrader Open API
 * via WebSocket, receives TradingView signals from Vercel, and executes
 * trades directly. No cBot needed.
 *
 * Deploy on Railway (free tier) for 24/7 uptime.
 *
 * Environment variables:
 *   CTRADER_CLIENT_ID         — App client ID (from openapi.ctrader.com)
 *   CTRADER_CLIENT_SECRET     — App client secret
 *   CTRADER_REFRESH_TOKEN     — Permanent refresh token (from Playground)
 *   CTRADER_ACCOUNT_ID        — Your numeric cTrader account ID
 *   CTRADER_DEMO              — Set "true" for demo environment
 *   PORT                      — HTTP server port (default: 8080)
 *
 * Usage:
 *   node ctrader-trader.mjs
 */

import { createServer } from 'http';

// ─── Config ───

const PORT = parseInt(process.env.PORT || '8080', 10);
const IS_DEMO = process.env.CTRADER_DEMO === 'true';
const HOST = IS_DEMO ? 'demo.ctraderapi.com' : 'live.ctraderapi.com';
const WS_PORT = 5036;  // JSON WebSocket (5035 for Protobuf)
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

// ─── Payload type constants (from cTrader proto definitions) ───

const PT = {
  APPLICATION_AUTH_REQ: 52,
  APPLICATION_AUTH_RES: 53,
  GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_REQ: 40,
  GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_RES: 41,
  ACCOUNT_AUTH_REQ: 43,
  ACCOUNT_AUTH_RES: 44,
  CREATE_MARKET_ORDER_REQ: 56,
  CREATE_MARKET_ORDER_RES: 57,
  GET_SYMBOLS_REQ: 30,
  GET_SYMBOLS_RES: 31,
  ERROR_RES: 104,
  HEARTBEAT_EVENT: 100,
};

// ─── State ───

let _ws = null;
let _accessToken = null;
let _refreshToken = null;
let _accountId = null;
let _symbolMap = {};       // symbolName → { id, name, digits, volumeInUnitsStep, volumeInUnitsMin }
let _connected = false;
let _ready = false;
let _reconnectTimer = null;
let _heartbeatTimer = null;
let _pendingMsg = null;     // { resolve, reject, timer }
const startTime = Date.now();

// ─── Token ───

async function refreshToken() {
  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  const token = process.env.CTRADER_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !token) {
    throw new Error('CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, and CTRADER_REFRESH_TOKEN must be set');
  }

  const url = `${TOKEN_URL}?grant_type=refresh_token` +
    `&refresh_token=${encodeURIComponent(token)}` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&client_secret=${encodeURIComponent(clientSecret)}`;

  console.log('[token] Refreshing access token...');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  if (data.errorCode) {
    throw new Error(`Token error: ${data.errorCode} — ${data.description || ''}`);
  }

  _accessToken = data.accessToken;
  _refreshToken = data.refreshToken || token;
  console.log(`[token] Got fresh token, expires in ${Math.round(data.expiresIn / 86400)} days`);
  return _accessToken;
}

// ─── WebSocket ───

function send(obj) {
  if (_ws && _ws.readyState === 1) {
    _ws.send(JSON.stringify(obj));
  }
}

function waitForMsg(expectedTypes, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (_pendingMsg?.resolve === resolve) _pendingMsg = null;
      reject(new Error(`Timeout waiting for response type ${expectedTypes.join(',')}`));
    }, timeoutMs);
    _pendingMsg = { resolve, reject, timer, expectedTypes };
  });
}

function onMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  const pt = msg.payloadType;

  // Route to pending waiter first
  if (_pendingMsg && _pendingMsg.expectedTypes.includes(pt)) {
    clearTimeout(_pendingMsg.timer);
    const resolve = _pendingMsg.resolve;
    _pendingMsg = null;
    resolve(msg);
    return;
  }

  // Heartbeat
  if (pt === PT.HEARTBEAT_EVENT) {
    send({ payloadType: PT.HEARTBEAT_EVENT });
    return;
  }

  // Error
  if (pt === PT.ERROR_RES) {
    console.error('[ctrader] API error:', msg.description || msg.errorCode || JSON.stringify(msg));
    if (_pendingMsg) {
      clearTimeout(_pendingMsg.timer);
      _pendingMsg.reject(new Error(msg.description || `cTrader error ${msg.errorCode}`));
      _pendingMsg = null;
    }
    return;
  }
}

function onClose(code, reason) {
  console.log(`[ctrader] Disconnected (code=${code} reason=${reason})`);
  _connected = false;
  _ready = false;
  _ws = null;
  clearInterval(_heartbeatTimer);
  scheduleReconnect();
}

function onError(err) {
  console.error('[ctrader] WS error:', err.message);
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  const delay = 5000;
  console.log(`[ctrader] Reconnecting in ${delay / 1000}s...`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  if (_ws) return;

  const url = `wss://${HOST}:${WS_PORT}`;
  console.log(`[ctrader] Connecting to ${url}...`);

  // Dynamic import so Railway doesn't need it at build time
  const { default: WebSocket } = await import('ws');

  _ws = new WebSocket(url, {
    rejectUnauthorized: false,
    handshakeTimeout: 15000,
  });

  _ws.on('open', async () => {
    _connected = true;
    console.log('[ctrader] WebSocket opened');
    try {
      await runAuthFlow();
      await loadSymbols();
      _ready = true;
      console.log('[ctrader] ✅ Ready to trade!');
    } catch (err) {
      console.error('[ctrader] Auth failed:', err.message);
      _ws.close();
    }
  });

  _ws.on('message', onMessage);
  _ws.on('close', onClose);
  _ws.on('error', onError);
}

// ─── Auth Flow ───

async function runAuthFlow() {
  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;

  // Step 1: Get access token
  const token = await refreshToken();

  // Step 2: Application auth
  console.log('[auth] Sending application auth...');
  send({ payloadType: PT.APPLICATION_AUTH_REQ, clientId, clientSecret });
  const appRes = await waitForMsg([PT.APPLICATION_AUTH_RES, PT.ERROR_RES]);
  console.log('[auth] Application authorized');

  // Step 3: Get account list by access token
  console.log('[auth] Getting account list...');
  send({ payloadType: PT.GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_REQ, accessToken: token });
  const listRes = await waitForMsg([PT.GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_RES, PT.ERROR_RES]);

  // Step 4: Account auth
  _accountId = parseInt(process.env.CTRADER_ACCOUNT_ID, 10);
  console.log(`[auth] Authenticating account ${_accountId}...`);
  send({ payloadType: PT.ACCOUNT_AUTH_REQ, ctidTraderAccountId: _accountId, accessToken: token });
  const accRes = await waitForMsg([PT.ACCOUNT_AUTH_RES, PT.ERROR_RES]);
  console.log('[auth] Account authorized');
}

async function loadSymbols() {
  console.log('[symbols] Loading symbols...');
  send({ payloadType: PT.GET_SYMBOLS_REQ, ctidTraderAccountId: _accountId });
  const res = await waitForMsg([PT.GET_SYMBOLS_RES, PT.ERROR_RES]);

  if (res.payloadType === PT.GET_SYMBOLS_RES && Array.isArray(res.symbol)) {
    _symbolMap = {};
    for (const sym of res.symbol) {
      if (sym.name) {
        _symbolMap[sym.name.toUpperCase()] = {
          id: sym.symbolId || sym.id,
          name: sym.name,
          digits: sym.digits || 0,
          step: sym.volumeInUnitsStep || 1,
          min: sym.volumeInUnitsMin || 1,
          max: sym.volumeInUnitsMax || 100000000,
        };
      }
    }
    console.log(`[symbols] Loaded ${Object.keys(_symbolMap).length} symbols`);
    // Log first 10 for debugging
    const names = Object.keys(_symbolMap).slice(0, 10).join(', ');
    console.log(`[symbols] First 10: ${names}...`);
  }
}

// ─── Trade Execution ───

function normaliseSymbol(tvSymbol) {
  if (!tvSymbol) return null;
  const idx = tvSymbol.lastIndexOf(':');
  return idx >= 0 && idx < tvSymbol.length - 1 ? tvSymbol.substring(idx + 1).trim() : tvSymbol.trim();
}

async function executeMarketOrder(signal) {
  if (!_ready) {
    throw new Error('Server not ready (connecting to cTrader)');
  }

  const ctSymbol = normaliseSymbol(signal.symbol);
  if (!ctSymbol) {
    throw new Error(`Cannot parse symbol from "${signal.symbol}"`);
  }

  const symInfo = _symbolMap[ctSymbol.toUpperCase()];
  if (!symInfo) {
    const available = Object.keys(_symbolMap).slice(0, 20).join(', ');
    throw new Error(`Symbol "${ctSymbol}" not found. Available: ${available}...`);
  }

  const isLong = signal.Action.endsWith(' Long');

  // Calculate volume in base currency: notional / entry price
  // e.g. $5000 / $65000 = 0.0769 BTC for BTCUSD
  let rawVolume = signal.notional / signal.entry;

  // Round to symbol's step (cTrader volume is int64 — the symbol defines
  // the unit. For forex: step=1000 means 1000 units of base currency (0.01 lots).
  // For crypto: step varies by broker.
  const step = symInfo.step;
  let volumeUnits = Math.round(rawVolume / step) * step;

  // Clamp to min (if our notional is too small, fall back to a floor check)
  if (volumeUnits < symInfo.min) {
    if (volumeUnits <= 0 && rawVolume > 0) {
      // Notional is too small — try with a minimum reasonable step
      // The user should increase their notional value
      console.log(`[trade] ⚠️  Volume ${volumeUnits} too small. Try increasing notional above $${Math.ceil(symInfo.min * signal.entry)}`);
    }
    console.log(`[trade] Volume ${volumeUnits} below min ${symInfo.min}, using min`);
    volumeUnits = symInfo.min;
  }
  if (volumeUnits > symInfo.max) {
    console.log(`[trade] Volume ${volumeUnits} above max ${symInfo.max}, using max`);
    volumeUnits = symInfo.max;
  }

  volumeUnits = Math.round(volumeUnits); // Ensure integer (cTrader int64)
  if (volumeUnits <= 0) {
    throw new Error(
      `Invalid volume ${volumeUnits}. Try increasing notional above $${Math.ceil(symInfo.min * signal.entry)} ` +
      `(symbol ${ctSymbol} min=${symInfo.min}, step=${step})`
    );
  }

  const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const stopLoss = Math.round(signal.sl * 100000) / 100000;
  const takeProfit = signal.tp1 ? Math.round(signal.tp1 * 100000) / 100000 : undefined;

  const payload = {
    payloadType: PT.CREATE_MARKET_ORDER_REQ,
    ctidTraderAccountId: _accountId,
    symbolId: symInfo.id,
    orderType: 'MARKET',
    tradeSide: isLong ? 'BUY' : 'SELL',
    volume: volumeUnits,
    label: 'TradingView',
    requestId,
  };

  if (stopLoss > 0) payload.stopLossPrice = stopLoss;
  if (takeProfit > 0) payload.takeProfitPrice = takeProfit;

  console.log(`[trade] Placing ${payload.tradeSide} ${ctSymbol} vol=${volumeUnits} (step=${step}, min=${symInfo.min})...`);

  send(payload);
  const res = await waitForMsg([PT.CREATE_MARKET_ORDER_RES, PT.ERROR_RES], 20000);

  console.log('[trade] Result:', JSON.stringify(res));

  return {
    success: true,
    orderId: res.positionId || res.orderId,
    symbol: ctSymbol,
    side: payload.tradeSide,
    volume: volumeUnits,
    requestId,
    response: res,
  };
}

// ─── HTTP Server ───

const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: _ready,
      connected: _connected,
      ready: _ready,
      symbols: Object.keys(_symbolMap).length,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    }));
  }

  // POST /webhook — receive TradingView signal
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const signal = JSON.parse(body);

        // Validate
        if (!signal || !signal.Action || !signal.symbol) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Missing Action or symbol' }));
        }
        if (!signal.Action.endsWith(' Long') && !signal.Action.endsWith(' Short')) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Action must end with " Long" or " Short"' }));
        }
        if (!signal.entry || !signal.sl || !signal.notional) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Missing entry, sl, or notional' }));
        }

        if (!_ready) {
          res.writeHead(503);
          return res.end(JSON.stringify({
            error: 'Server not ready',
            detail: 'Connecting to cTrader...',
            connected: _connected,
          }));
        }

        console.log(`[webhook] Signal: ${signal.Action} ${signal.symbol} @ ${signal.entry}`);

        const result = await executeMarketOrder(signal);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          orderId: result.orderId,
          symbol: result.symbol,
          side: result.side,
          volume: result.volume,
          requestId: result.requestId,
        }));
      } catch (e) {
        console.error('[webhook] Error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ─── Start ───

httpServer.listen(PORT, () => {
  console.log(`\n🤖  cTrader Trader server`);
  console.log(`    Environment: ${IS_DEMO ? 'DEMO' : 'LIVE'}`);
  console.log(`    WebSocket:   ws://${HOST}:${WS_PORT} (JSON)`);
  console.log(`    HTTP:        :${PORT}`);
  console.log(`    POST /webhook   ← TradingView signals`);
  console.log(`    GET  /health    ← Health check\n`);

  // Connect to cTrader
  connect();
});
