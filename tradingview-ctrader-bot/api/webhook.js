import { isConfigured } from './ctrader-client.js';

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
      return res.status(400).json({ error: 'Missing required fields: Action, symbol', received: signal });
    }
    if (!signal.Action.endsWith(' Long') && !signal.Action.endsWith(' Short')) {
      return res.status(400).json({ error: 'Action must end with " Long" or " Short"', received: signal.Action });
    }
    if (typeof signal.entry !== 'number' || signal.entry <= 0) {
      return res.status(400).json({ error: 'entry must be a positive number', received: signal.entry });
    }
    if (typeof signal.sl !== 'number' || signal.sl <= 0) {
      return res.status(400).json({ error: 'sl must be a positive number', received: signal.sl });
    }
    if (typeof signal.notional !== 'number' || signal.notional <= 0) {
      return res.status(400).json({ error: 'notional must be a positive number', received: signal.notional });
    }

    // ── Construct response ──
    const ctSymbol = normaliseSymbol(signal.symbol);
    const isLong = signal.Action.endsWith(' Long');
    const volume = Math.round((signal.notional / signal.entry) * 100) / 100;

    console.log(`[${reqTime}] Signal validated OK: ${signal.Action} ${ctSymbol} entry=${signal.entry} sl=${signal.sl} tp=${signal.tp1} vol=${volume}`);

    // ── cTrader DOES NOT have a REST trading API ──
    // The Open API uses WebSocket + Protobuf messages.
    // See README.md for the two working approaches:
    //   A) cBot in cTrader Automate (recommended)
    //   B) Persistent WebSocket relay server
    return res.status(200).json({
      success: true,
      message: 'Signal received and validated. cTrader Open API is WebSocket-based — ' +
        'to execute this trade, deploy a cBot (Option A) or a relay server (Option B). ' +
        'See README.md for details.',
      signal: {
        action: signal.Action,
        symbol: ctSymbol,
        side: isLong ? 'Buy' : 'Sell',
        volume,
        entry: signal.entry,
        stopLoss: signal.sl,
        takeProfit: signal.tp1,
        notional: signal.notional,
      },
      configOk: isConfigured(),
      timestamp: reqTime,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Webhook error:`, error);
    return res.status(500).json({ error: error.message });
  }
}
