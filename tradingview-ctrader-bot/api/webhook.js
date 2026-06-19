/**
 * TradingView webhook → cTrader Trader Server
 *
 * Validates TradingView alerts and forwards them to the persistent
 * ctrader-trader server, which maintains a WebSocket connection to
 * cTrader Open API and executes trades directly.
 *
 * Environment variable:
 *   TRADER_URL  — URL of the ctrader-trader server (e.g. https://trader.up.railway.app)
 *
 * TradingView alert JSON format:
 *   { "Action": "DiMea Long", "entry": 142.5, "tp1": 143.2,
 *     "sl": 141.8, "symbol": "NASDAQ:US100", "notional": 150 }
 */

const TRADER_URL = process.env.TRADER_URL;

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

    console.log(`[${reqTime}] Signal OK: ${signal.Action} ${signal.symbol} entry=${signal.entry} sl=${signal.sl} tp=${signal.tp1}`);

    // ── Forward to cTrader trader server ──
    if (TRADER_URL) {
      try {
        const traderRes = await fetch(`${TRADER_URL}/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signal),
        });
        const traderBody = await traderRes.json();
        console.log(`[${reqTime}] Trader responded ${traderRes.status}:`, JSON.stringify(traderBody));

        if (!traderRes.ok) {
          return res.status(traderRes.status).json({
            error: traderBody.error || 'Trader server error',
            detail: traderBody.detail || traderBody,
            timestamp: reqTime,
          });
        }

        return res.status(200).json({
          success: true,
          trade: {
            symbol: traderBody.symbol,
            side: traderBody.side,
            orderId: traderBody.orderId,
          },
          timestamp: reqTime,
        });
      } catch (err) {
        console.error(`[${reqTime}] Trader forward failed:`, err.message);
        return res.status(502).json({
          error: 'Trader server unreachable',
          detail: err.message,
          hint: `Ensure TRADER_URL is set correctly (${TRADER_URL}) and the trader server is running.`,
        });
      }
    } else {
      return res.status(200).json({
        success: true,
        message: 'Signal validated. TRADER_URL not set — no trade executed.',
        signal,
        timestamp: reqTime,
      });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Webhook error:`, error);
    return res.status(500).json({ error: error.message });
  }
}
