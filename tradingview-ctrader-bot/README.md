# TradingView → Relay → cTrader cBot (WebSocket)

Receives TradingView webhook alerts via **Vercel**, forwards them to a **relay server**, which broadcasts to a **cBot in cTrader Automate** via WebSocket. The cBot executes trades using cTrader's native trading API.

## Architecture

```
TradingView Alert (JSON POST)
        │
        ▼
  ┌─────────────────┐       HTTP POST       ┌─────────────────┐
  │  Vercel (free)   │ ──────────────────→  │  Relay Server    │
  │  /api/webhook    │    /webhook           │  Railway/Render  │
  └─────────────────┘                       │  (free tier)     │
                                            └────────┬─────────┘
                                                     │  WebSocket (wss://)
                                                     ▼
                                            ┌─────────────────┐
                                            │  cBot in cTrader │
                                            │  Automate Cloud  │
                                            │                   │
                                            │  1. Receive signal│
                                            │  2. Check symbol  │
                                            │  3. Market order  │
                                            │  4. SL + TP set  │
                                            └─────────────────┘
```

**Why this works:**
- **Vercel** receives TradingView alerts (serverless, free tier)
- **Relay server** stays online 24/7 (Railway free tier, ~$0/month)
- **cBot** connects via WebSocket (no `FullAccess` HTTP rights needed in cloud)
- cBot uses cTrader's **native C# trading API** (Symbol, Position, ExecuteMarketOrder)

## Prerequisites

- A cTrader account (Pipfarm or any broker running cTrader)
- A [Vercel](https://vercel.com) account (free tier)
- A [Railway](https://railway.app) or [Render](https://render.com) account (free tier)
- [Node.js](https://nodejs.org/) 18+ for local testing

## Setup

### Step 1: Deploy the Relay Server to Railway

```bash
# In your project directory
cd tradingview-ctrader-bot

# Install Railway CLI
npm install -g @railway/cli
railway login

# Deploy
railway init
railway up
```

Railway will detect `package.json` and run `node relay-server.mjs` automatically.
Note your Railway URL: `https://your-relay.up.railway.app`

> **Or deploy to Render:** Create a new Web Service, set build command to `npm install` and start command to `node relay-server.mjs`.

### Step 2: Deploy the Webhook to Vercel

```bash
# Install Vercel CLI
npm install -g vercel
vercel login

# Deploy
cd tradingview-ctrader-bot
vercel

# Set the relay URL so Vercel knows where to forward signals
vercel env add RELAY_URL
# Paste: https://your-relay.up.railway.app

vercel --prod
```

Your webhook URL: `https://your-project.vercel.app/api/webhook`

### Step 3: Deploy the cBot in cTrader Automate

1. Open **cTrader** → **Automate** → **cBot** tab
2. Click **New cBot** → paste code from `cbot/SignalBot.cs` → **Save** (name: `SignalBot`)
3. In **cTrader Automate Cloud** → **Deploy Bot** → select **SignalBot**
4. Set the **Relay Server URL** parameter to your Railway URL:
   ```
   wss://your-relay.up.railway.app
   ```

### Step 4: Configure TradingView Alert

Create an alert with the **Webhook URL** set to your Vercel endpoint:

```
https://your-project.vercel.app/api/webhook
```

Alert message (JSON):

```pinescript
alert('{"Action":"DiMea Long","entry":' + str.tostring(entryPrice) + ',"tp1":' + str.tostring(tp1Price) + ',"sl":' + str.tostring(hardSL) + ',"symbol":"' + syminfo.tickerid + '","notional":150}', freq=alert.freq_once_per_bar_close)
```

**Expected JSON format:**

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `Action` | string | `"DiMea Long"` | Must end with `" Long"` or `" Short"` |
| `entry` | number | `142.50` | Entry price |
| `tp1` | number | `143.20` | Take profit price |
| `sl` | number | `141.80` | Stop loss price |
| `symbol` | string | `"NASDAQ:US100"` | TradingView ticker ID |
| `notional` | number | `150` | Trade value in USD |

> **Symbol:** Auto-normalised — `NASDAQ:US100` → `US100`, `FX:EURUSD` → `EURUSD`, etc.

## Local Testing

Test the validation logic locally (no relay needed):

```bash
node test-webhook.mjs
```

Test the webhook against your deployed Vercel endpoint:

```bash
curl -X POST https://your-project.vercel.app/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"Action":"DiMea Long","symbol":"NASDAQ:US100","entry":142.5,"tp1":143.2,"sl":141.8,"notional":150}'
```

Test the relay server locally:

```bash
# Terminal 1: start the relay
npm run relay

# Terminal 2: send a test signal
curl -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/json" \
  -d '{"Action":"DiMea Long","symbol":"US100","entry":142.5,"tp1":143.2,"sl":141.8,"notional":150}'
```

## How It Works

### Flow

1. **TradingView** sends a JSON POST to Vercel `/api/webhook`
2. **Vercel** validates the signal and forwards it to the relay server via HTTP
3. **Relay server** broadcasts the signal to all connected cBots via WebSocket
4. **cBot** receives the signal, resolves the symbol, checks for existing positions
5. **cBot** places a market order with SL and TP1 using cTrader's native API
6. Trade is executed!

### cBot Details

- Connects to the relay server on startup via `ClientWebSocket`
- Auto-reconnects on disconnect (configurable delay)
- Processes one signal per tick (deduplicated by checking existing positions)
- Symbol resolution: strips TradingView prefix (e.g. `NASDAQ:US100` → `US100`)

## File Structure

```
tradingview-ctrader-bot/
├── api/
│   ├── webhook.js           # POST /api/webhook — validates & forwards to relay
│   └── ctrader-client.js    # cTrader Open API reference (not used in main flow)
├── cbot/
│   └── SignalBot.cs         # cBot for cTrader Automate (WebSocket client)
├── relay-server.mjs         # HTTP + WebSocket relay server (deploy on Railway)
├── .env.example             # Environment variables template
├── vercel.json              # Vercel deployment config
├── package.json             # Dependencies & scripts
├── local-server.mjs         # Local validation server
├── test-webhook.mjs         # Module tests
└── README.md                # This file
```

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|------|
| Webhook returns 502 | Relay server down | Check Railway dashboard, restart relay |
| cBot not connecting | Wrong WebSocket URL | Ensure Relay URL starts with `wss://` in cBot params |
| "Symbol not found" | Wrong cTrader symbol name | Check the symbol name in cTrader, adjust if needed |
| Trade not opening | Volume below minimum | Increase `notional` value in alert |
| cBot reconnecting loop | Relay unreachable from cloud | Check firewall settings, try `wss://` |
| Webhook returns 400 | Invalid JSON | Check TradingView alert message format |

## Security Notes

- The webhook is publicly accessible — consider adding an API key header check
- The relay server has no authentication — deploy with Railway's private networking if needed
- cTrader credentials are never stored in code
