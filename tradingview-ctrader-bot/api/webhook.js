import { executeMarketOrder, isConfigured } from './ctrader-client.js';

export const config = {
  runtime: 'nodejs',
};

/**
 * Normalise a TradingView symbol to cTrader format.
 * e.g. "NASDAQ:US100" → "US100", "FX:GBPUSD" → "GBPUSD"
 */
function normaliseSymbol(sym) {
  if (!sym) return null;
  const idx = sym.lastIndexOf(':');
  return idx >= 0 && idx < sym.length - 1 ? sym.substring(idx + 1).trim() : sym.trim();
}

export default async function handler(req, res) {
  // ── Logging: always log request info ──
  const reqTime = new Date().toISOString();
  console.log(`[${reqTime}] ${req.method} ${req.url}`);

  if (req.method !== 'POST') {
    console.log(`[${reqTime}] Rejected: method ${req.method} not allowed`);
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const signal = req.body;
    console.log(`[${reqTime}] Body received:`, JSON.stringify(signal));

    // ── Validation ──

    if (!signal || !signal.Action || !signal.symbol) {
      console.log(`[${reqTime}] Validation failed: missing Action/symbol`);
      return res.status(400).json({
        error: 'Missing required fields: Action, symbol',
        received: signal,
      });
    }

    if (!signal.Action.endsWith(' Long') && !signal.Action.endsWith(' Short')) {
      console.log(`[${reqTime}] Validation failed: bad Action format "${signal.Action}"`);
      return res.status(400).json({
        error: 'Action must end with " Long" or " Short"',
        received: signal.Action,
      });
    }

    if (typeof signal.entry !== 'number' || signal.entry <= 0) {
      console.log(`[${reqTime}] Validation failed: bad entry ${signal.entry}`);
      return res.status(400).json({ error: 'entry must be a positive number', received: signal.entry });
    }
    if (typeof signal.sl !== 'number' || signal.sl <= 0) {
      console.log(`[${reqTime}] Validation failed: bad sl ${signal.sl}`);
      return res.status(400).json({ error: 'sl must be a positive number', received: signal.sl });
    }
    if (typeof signal.notional !== 'number' || signal.notional <= 0) {
      console.log(`[${reqTime}] Validation failed: bad notional ${signal.notional}`);
      return res.status(400).json({ error: 'notional must be a positive number', received: signal.notional });
    }

    // ── Check config ──
    console.log(`[${reqTime}] cTrader configured: ${isConfigured()}`);
    console.log(`[${reqTime}] CTRADER_CLIENT_ID: ${process.env.CTRADER_CLIENT_ID ? '✅ set' : '❌ missing'}`);
    console.log(`[${reqTime}] CTRADER_CLIENT_SECRET: ${process.env.CTRADER_CLIENT_SECRET ? '✅ set' : '❌ missing'}`);
    console.log(`[${reqTime}] CTRADER_EMAIL: ${process.env.CTRADER_EMAIL ? '✅ set' : '❌ missing'}`);
    console.log(`[${reqTime}] CTRADER_PASSWORD: ${process.env.CTRADER_PASSWORD ? '✅ set' : '❌ missing'}`);
    console.log(`[${reqTime}] CTRADER_ACCOUNT_ID: ${process.env.CTRADER_ACCOUNT_ID ? '✅ set' : '❌ missing'}`);

    if (!isConfigured()) {
      return res.status(500).json({
        error: 'cTrader API not configured',
        hint: 'Set CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_EMAIL, CTRADER_PASSWORD, and CTRADER_ACCOUNT_ID environment variables',
      });
    }

    // ── Execute trade ──

    const ctSymbol = normaliseSymbol(signal.symbol);
    console.log(`[${reqTime}] Normalised symbol: "${signal.symbol}" → "${ctSymbol}"`);

    console.log(`[${reqTime}] Executing trade: ${signal.Action} ${ctSymbol} entry=${signal.entry} sl=${signal.sl} tp=${signal.tp1} notional=${signal.notional}`);

    const result = await executeMarketOrder(signal);

    console.log(`[${reqTime}] Trade executed successfully:`, JSON.stringify(result));

    return res.status(200).json({
      success: true,
      trade: {
        symbol: result.symbol,
        side: result.tradeSide,
        volume: result.volume,
      },
      requestId: result.requestId,
      message: `${result.tradeSide} ${result.symbol} placed`,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Webhook error:`, error);
    return res.status(500).json({ error: error.message });
  }
}
