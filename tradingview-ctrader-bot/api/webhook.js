/**
 * TradingView webhook → Relay Server → cBot
 *
 * Validates TradingView alerts and forwards them to the relay server,
 * which broadcasts to connected cBots via WebSocket.
 *
 * Environment variable:
 *   RELAY_URL  — URL of the relay server (e.g. https://relay.up.railway.app)
 *
 * TradingView alert JSON format:
 *   { "Action": "DiMea Long", "entry": 142.5, "tp1": 143.2,
 *     "sl": 141.8, "symbol": "NASDAQ:US100", "notional": 150 }
 */

const RELAY_URL = process.env.RELAY_URL;

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

    const ctSymbol = normaliseSymbol(signal.symbol);
    const isLong = signal.Action.endsWith(' Long');
    const volume = Math.round((signal.notional / signal.entry) * 100) / 100;

    console.log(`[${reqTime}] Signal OK: ${signal.Action} ${ctSymbol} entry=${signal.entry} sl=${signal.sl} tp=${signal.tp1} vol=${volume}`);

    // ── Forward to relay server ──
    if (RELAY_URL) {
      try {
        const relayRes = await fetch(`${RELAY_URL}/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signal),
        });
        const relayBody = await relayRes.text();
        console.log(`[${reqTime}] Relay responded ${relayRes.status}: ${relayBody}`);
      } catch (err) {
        console.error(`[${reqTime}] Relay forward failed:`, err.message);
        return res.status(502).json({
          error: 'Relay unreachable',
          detail: err.message,
          hint: `Ensure RELAY_URL is set correctly (current: ${RELAY_URL}) and the relay server is running.`,
        });
      }
    } else {
      console.log(`[${reqTime}] RELAY_URL not set — signal validated but not forwarded`);
    }

    return res.status(200).json({
      success: true,
      message: 'Signal forwarded to cBot relay',
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
      relayUrl: RELAY_URL || null,
      timestamp: reqTime,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Webhook error:`, error);
    return res.status(500).json({ error: error.message });
  }
}
