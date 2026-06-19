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

const IDP_URL = 'https://idp.ctrader.com';
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
  // Return cached token if still valid (with 5 min buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 300_000) {
    return _cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.CTRADER_CLIENT_ID,
    client_secret: process.env.CTRADER_CLIENT_SECRET,
    username: process.env.CTRADER_EMAIL,
    password: process.env.CTRADER_PASSWORD,
    scope: 'openapi',
  });

  const res = await fetch(`${IDP_URL}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cTrader auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;

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
  if (!isConfigured()) {
    throw new Error(
      'cTrader API not configured. Set CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, ' +
      'CTRADER_EMAIL, CTRADER_PASSWORD, and CTRADER_ACCOUNT_ID environment variables.'
    );
  }

  const token = await getAccessToken();
  const isLong = signal.Action.endsWith(' Long');
  const symbolName = normaliseSymbol(signal.symbol);

  if (!symbolName) {
    throw new Error(`Cannot parse symbol from "${signal.symbol}"`);
  }

  // Volume: notional / entry price → units
  // cTrader expects volume in units (e.g. 150000 for US100)
  const volume = Math.round(signal.notional / signal.entry);
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

  console.log('cTrader market order payload:', JSON.stringify(payload));

  const res = await fetch(`${API_URL}/v1/positions/market`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`cTrader API error (${res.status}): ${body}`);
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }

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
