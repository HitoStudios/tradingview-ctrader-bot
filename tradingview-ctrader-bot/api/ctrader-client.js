/**
 * cTrader Open API client.
 *
 * The cTrader Open API uses OAuth2 (authorization_code grant) + WebSocket
 * with Protobuf messages. There is no REST endpoint for placing trades.
 *
 * As a result, a Vercel serverless function CANNOT trade directly with
 * cTrader — it requires a persistent WebSocket connection.
 *
 * This module is kept for reference; to actually trade, use either:
 *
 *   Option A (recommended): cBot in cTrader Automate
 *     - Deploy a cBot that polls a Vercel webhook for signals
 *     - cBot has full trading capabilities via cTrader's internal API
 *
 *   Option B: Dedicated Node.js server with WebSocket
 *     - Deploy on Railway/Render (free tier) — maintains persistent
 *       WebSocket connection to cTrader
 *     - Vercel webhook forwards alerts to this server via HTTP
 *     - Trade is executed over the WebSocket connection
 *
 * Environment variables (for reference):
 *   CTRADER_CLIENT_ID      — App client ID (from openapi.ctrader.com)
 *   CTRADER_CLIENT_SECRET  — App client secret
 *   CTRADER_REFRESH_TOKEN  — Permanent refresh token (get from Playground)
 *   CTRADER_ACCOUNT_ID     — The numeric cTrader account ID to trade on
 */

/**
 * cTrader API endpoints (from official docs):
 *   REST token endpoint: GET https://openapi.ctrader.com/apps/token
 *   WebSocket:           wss://openapi.ctrader.com/  (Protobuf)
 *   WebSocket (JSON):    wss://openapi.ctrader.com/  (JSON)
 *   Demo WebSocket:      wss://openapi.ctrader.com/  (demo)
 */

export function isConfigured() {
  return !!(
    process.env.CTRADER_CLIENT_ID &&
    process.env.CTRADER_CLIENT_SECRET &&
    process.env.CTRADER_REFRESH_TOKEN &&
    process.env.CTRADER_ACCOUNT_ID
  );
}

/**
 * Refresh the access token via the REST API.
 */
export async function refreshAccessToken() {
  if (!process.env.CTRADER_CLIENT_ID || !process.env.CTRADER_CLIENT_SECRET || !process.env.CTRADER_REFRESH_TOKEN) {
    throw new Error('CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, and CTRADER_REFRESH_TOKEN must be set');
  }

  const url = `https://openapi.ctrader.com/apps/token?grant_type=refresh_token` +
    `&refresh_token=${encodeURIComponent(process.env.CTRADER_REFRESH_TOKEN)}` +
    `&client_id=${encodeURIComponent(process.env.CTRADER_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(process.env.CTRADER_CLIENT_SECRET)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cTrader token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (data.errorCode) {
    throw new Error(`cTrader token refresh error: ${data.errorCode} — ${data.description || 'no description'}`);
  }

  // Save the new refresh token for next time
  if (data.refreshToken) {
    process.env.CTRADER_REFRESH_TOKEN = data.refreshToken;
  }

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || process.env.CTRADER_REFRESH_TOKEN,
    expiresIn: data.expiresIn,
  };
}
