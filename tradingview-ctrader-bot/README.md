# TradingView → cTrader (Open API)

Receives TradingView webhook alerts via **Vercel** and executes trades directly via the **cTrader Open API (REST)**.

No cBot, no polling, no Redis — a single serverless function trades for you.

## Architecture

```
TradingView Alert (JSON POST)
        │
        ▼
  ┌─────────────────────────┐
  │  Vercel Function         │  POST /api/webhook
  │  (serverless, Node.js)   │  Validates → calls cTrader REST API
  └────────┬────────────────┘
           │
           ▼
  ┌─────────────────────────┐
  │  cTrader Open API        │  POST /v1/positions/market
  │  (OAuth2 password grant) │  Market order with SL + TP
  └────────┬────────────────┘
           │
           ▼
     Trade Executed!
     ┌── SL (stop-loss)
     └── TP1 (take-profit on the order)
```

## Prerequisites

- A cTrader account (Pipfarm or any broker using cTrader)
- [Node.js](https://nodejs.org/) 18+ for local testing
- A [Vercel](https://vercel.com) account (free tier) for deployment

## Setup

### 1. Register a cTrader API Application

1. Go to [https://idp.ctrader.com/](https://idp.ctrader.com/)
2. Click **Register** → create an app (use any name, e.g. `TradingView Bot`)
3. Note your **Client ID** and **Client Secret**

### 2. Find Your Account ID

1. Open cTrader desktop/mobile app
2. Go to your account details
3. Note the numeric **Account ID** (e.g. `11223344`)

### 3. Deploy to Vercel

```bash
# Install Vercel CLI & log in
npm install -g vercel
vercel login

# Deploy
cd tradingview-ctrader-bot
vercel
```

When prompted, link the project (follow the prompts — Vercel will auto-detect the config).

### 4. Set Environment Variables

```bash
vercel env add CTRADER_CLIENT_ID
vercel env add CTRADER_CLIENT_SECRET
vercel env add CTRADER_EMAIL
vercel env add CTRADER_PASSWORD
vercel env add CTRADER_ACCOUNT_ID

vercel --prod  # Redeploy with secrets
```

Or set them in the Vercel Dashboard → Project → Settings → Environment Variables.

Your webhook URL will be: `https://your-project.vercel.app/api/webhook`

### 5. Configure TradingView Alert

Create an alert with the **Webhook URL** set to your Vercel endpoint and the JSON message:

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

> **Note:** Symbol is auto-normalised — `NASDAQ:US100` → `US100`, `FX:EURUSD` → `EURUSD`, etc. Part after the last colon is used as the cTrader symbol name.

## Local Testing (Validation Only)

The local server tests **parsing and validation only** — it never calls the cTrader API:

```bash
node local-server.mjs
# Open http://localhost:3000/api/test
```

Or run the module tests:

```bash
node test-webhook.mjs
```

## How It Works

1. **TradingView** sends a JSON `POST` to `/api/webhook`
2. **Vercel function** validates all required fields
3. Gets an **OAuth2 access token** from `idp.ctrader.com` (password grant)
4. Sends a **market order** via `POST /v1/positions/market` with SL + TP
5. Returns trade result as JSON

### Volume Calculation

Volume is calculated as `round(notional / entry)` — e.g. $150 notional / $142.50 entry = 1 unit.

### Symbol Normalisation

TradingView uses tickers like `NASDAQ:US100`, `FX:EURUSD`. The webhook strips the prefix (part before `:`) and uses the suffix as the cTrader symbol name.

## File Structure

```
tradingview-ctrader-bot/
├── api/
│   ├── webhook.js           # POST /api/webhook — receives TradingView alerts → calls cTrader API
│   └── ctrader-client.js    # OAuth2 token management + market order execution
├── .env.example             # Environment variables template
├── vercel.json              # Vercel deployment config
├── package.json             # Dependencies & scripts
├── local-server.mjs         # Local validation server (no API calls)
├── test-webhook.mjs         # Module tests
└── README.md                # This file
```

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|-----|
| Webhook returns 400 | Invalid JSON format | Check TradingView alert payload |
| Webhook returns 500 with auth error | Wrong credentials | Check env vars in Vercel Dashboard |
| "cTrader API not configured" | Missing env vars | Run `vercel env add CTRADER_*` then redeploy |
| Trade fails — symbol not found | Wrong symbol name | Check cTrader symbol names, adjust normalisation if needed |
| Volume too small | Notional too low for symbol | Increase `notional` value in alert |

## Security Notes

- The webhook is publicly accessible — anyone who knows your URL can send signals
- For production, consider adding an API key validation to the webhook
- cTrader credentials are stored as Vercel environment variables (never in code)
