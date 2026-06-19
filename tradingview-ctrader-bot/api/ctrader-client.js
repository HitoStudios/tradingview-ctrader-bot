/**
 * cTrader Open API client.
 *
 * Handles OAuth2 authentication and trade execution via the cTrader REST API.
 *
 * Environment variables:
 *   CTRADER_CLIENT_ID      — App client ID (from idp.ctrader.com)
 *   CTRADER_CLIENT_SECRET  — App client secret
 *   CTRADER_EMAIL          — cTrader account email
 *   CTRADER_PASSWORD       — cTrader account password
 *   CTRADER_ACCOUNT_ID     — The numeric cTrader account ID to trade on
 *
 * Token endpoint (password grant):
 *   POST https://idp.ctrader.com/connect/token
 *
 * Market order endpoint:
 *   POST https://openapi.ctrader.com/v1/positions/market
 */

const IDP_URL = 'https://openapi.ctrader.com';
const API_URL = 'https://openapi.ctrader.com';

// ─── In-memory token cache ───
let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * Check if required env vars are present.
 */
export function isConfigured() {
  return !!(
    process.env.CTRADER_CLIENT_ID &&
    process.env.CTRADER_CLIENT_SECRET &&
    process.env.CTRADER_EMAIL &&
    process.env.CTRADER_PASSWORD &&
    process.env.CTRADER_ACCOUNT_ID
  );
}

/**
 * Obtain (or return cached) access token via OAuth2 password grant.
 */
async function getAccessToken() {
  const ts = () => new Date().toISOString();

  // Return cached token if still valid (with 5 min buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 300_000) {
    console.log(`[${ts()}] Using cached token (expires in ${Math.round((_tokenExpiry - Date.now()) / 1000)}s)`);
    return _cachedToken;
  }

  const idpUrl = `${IDP_URL}/connect/token`;
  console.log(`[${ts()}] Requesting new token from ${idpUrl}`);
  console.log(`[${ts()}] client_id=${process.env.CTRADER_CLIENT_ID?.slice(0, 8)}... email=${process.env.CTRADER_EMAIL}`);

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.CTRADER_CLIENT_ID,
    client_secret: process.env.CTRADER_CLIENT_SECRET,
    username: process.env.CTRADER_EMAIL,
    password: process.env.CTRADER_PASSWORD,
    scope: 'openapi',
  });

  const res = await fetch(idpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[${ts()}] cTrader auth failed (${res.status}): ${text}`);
    throw new Error(`cTrader auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  console.log(`[${ts()}] Token obtained, expires in ${data.expires_in}s`);

  return _cachedToken;
}

/**
 * Normalise a TradingView symbol (e.g. "NASDAQ:US100") to a cTrader symbol name.
 *
 * Tries, in order:
 *   1. Use the part after the last colon (e.g. "US100")
 *   2. Fall back to the raw symbol
 */
function normaliseSymbol(tvSymbol) {
  if (!tvSymbol) return null;
  const idx = tvSymbol.lastIndexOf(':');
  if (idx >= 0 && idx < tvSymbol.length - 1) {
    return tvSymbol.substring(idx + 1).trim();
  }
  return tvSymbol.trim();
}

/**
 * Place a market order via the cTrader Open API.
 *
 * @param {object} signal - Normalised TradingView signal
 * @param {string} signal.Action  - e.g. "DiMea Long"
 * @param {number} signal.entry   - Entry price
 * @param {number} signal.sl      - Stop-loss price
 * @param {number} signal.tp1     - Take-profit 1 price
 * @param {number} signal.notional - Dollar notional
 * @param {string} signal.symbol  - TradingView symbol (e.g. "NASDAQ:US100")
 * @returns {Promise<object>} Result from cTrader API
 */
export async function executeMarketOrder(signal) {
  const ts = () => new Date().toISOString();

  console.log(`[${ts()}] executeMarketOrder: checking config...`);
  if (!isConfigured()) {
    throw new Error(
      'cTrader API not configured. Set CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, ' +
      'CTRADER_EMAIL, CTRADER_PASSWORD, and CTRADER_ACCOUNT_ID environment variables.'
    );
  }

  console.log(`[${ts()}] executeMarketOrder: getting access token...`);
  const token = await getAccessToken();
  console.log(`[${ts()}] executeMarketOrder: token obtained (${token.slice(0, 10)}...)`);

  const isLong = signal.Action.endsWith(' Long');
  const symbolName = normaliseSymbol(signal.symbol);
  console.log(`[${ts()}] executeMarketOrder: symbol="${symbolName}" isLong=${isLong}`);

  if (!symbolName) {
    throw new Error(`Cannot parse symbol from "${signal.symbol}"`);
  }

  // Volume: notional / entry price → units
  // Use 2 decimal places for fractional units (e.g. 0.08 BTC)
  const volume = Math.round((signal.notional / signal.entry) * 100) / 100;
  if (volume <= 0) {
    throw new Error(`Invalid volume ${volume} for notional ${signal.notional} / entry ${signal.entry}`);
  }

  // Round SL/TP to sane precision
  const stopLoss = Math.round(signal.sl * 1000) / 1000;
  const takeProfit = Math.round(signal.tp1 * 1000) / 1000;

  const accountId = parseInt(process.env.CTRADER_ACCOUNT_ID, 10);
  const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const payload = {
    AccountId: accountId,
    Symbol: symbolName,
    TradeSide: isLong ? 'Buy' : 'Sell',
    Volume: volume,
    StopLossPrice: stopLoss,
    TakeProfitPrice: takeProfit,
    Label: 'TradingView',
    RequestId: requestId,
  };

  console.log(`[${ts()}] cTrader payload:`, JSON.stringify(payload));

  const url = `${API_URL}/v1/positions/market`;
  console.log(`[${ts()}] Sending POST to ${url}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  console.log(`[${ts()}] cTrader response status=${res.status} body=${body.slice(0, 500)}`);

  if (!res.ok) {
    throw new Error(`cTrader API error (${res.status}): ${body}`);
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }

  console.log(`[${ts()}] Trade placed successfully`);

  return {
    success: true,
    accountId,
    symbol: symbolName,
    tradeSide: payload.TradeSide,
    volume,
    requestId,
    response: parsed,
  };
}

/**
 * Clear cached token (useful for testing).
 */
export function clearTokenCache() {
  _cachedToken = null;
  _tokenExpiry = 0;
}
