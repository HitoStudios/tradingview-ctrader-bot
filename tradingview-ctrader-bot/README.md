# TradingView → cTrader Open API (WebSocket)

A persistent **Node.js server** that connects to **cTrader Open API** via WebSocket and executes trades directly from TradingView webhook alerts. **No cBot, no Vercel needed.**

## Architecture

```
TradingView Alert (JSON POST)
        │
        ▼
  ┌─────────────────────────────────────┐
  │  cTrader Trader Server (Railway)    │
  │  POST /webhook ← TradingView alert  │
  │                                     │
  │  ┌───────────────────────────────┐  │
  │  │  WebSocket (wss://)           │  │
  │  │  → Token (OAuth2)            │  │
  │  │  → App Auth                  │  │
  │  │  → Account Auth              │  │
  │  │  → Market Order              │  │
  │  └───────────────────────────────┘  │
  └─────────────────────────────────────┘
```

**Why this works:**
- **Single server** — no middleman, no Vercel
- Deployed on **Railway** (free tier, 24/7 uptime)
- Uses **cTrader Open API** natively via WebSocket + JSON messages
- No cBot, no C#, no polling — pure Node.js

## Prerequisites

- A cTrader account (any broker using cTrader)
- A [Railway](https://railway.app) account (free tier)
- [Node.js](https://nodejs.org/) 18+ for local testing

## Setup

### Step 1: Get cTrader API Credentials

1. Go to [https://openapi.ctrader.com](https://openapi.ctrader.com) → **Applications** → **Create**
2. Enter any name (e.g. `TradingView Bot`) → **Save**
3. Note your **Client ID** and **Client Secret**
4. Add a **Redirect URI**: click Edit, scroll down, add `https://openapi.ctrader.com`
5. Get a production token:
   - Visit this URL in your browser (replace YOUR_CLIENT_ID):
     ```
     https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=YOUR_CLIENT_ID&redirect_uri=https://openapi.ctrader.com&scope=trading&product=web
     ```
   - Login → **Allow access**
   - Copy the `code` from the URL bar, then immediately run:
     ```bash
     curl -X GET 'https://openapi.ctrader.com/apps/token?grant_type=authorization_code&code=THE_CODE&redirect_uri=https://openapi.ctrader.com&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET' -H 'Accept: application/json'
     ```
   - Save the **refreshToken** from the response
6. In cTrader, go to your account → note the numeric **Account ID**

### Step 2: Deploy to Railway

```bash
cd tradingview-ctrader-bot

# Install Railway CLI & login
npm install -g @railway/cli
railway login

# Deploy
railway init
railway up

# Set environment variables
railway vars set CTRADER_CLIENT_ID=your_client_id
railway vars set CTRADER_CLIENT_SECRET=your_client_secret
railway vars set CTRADER_REFRESH_TOKEN=your_refresh_token
railway vars set CTRADER_ACCOUNT_ID=your_account_id
railway vars set CTRADER_DEMO=true
```

Railway detects `package.json` → runs `npm start` → starts `ctrader-trader.mjs`.
Note your Railway URL: `https://your-trader.up.railway.app`

### Step 3: Configure TradingView Alert

Create an alert with **Webhook URL** set to your Railway server:

```
https://your-trader.up.railway.app/webhook
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

> Symbol is auto-normalised: `NASDAQ:US100` → `US100`, `FX:EURUSD` → `EURUSD`, etc.

## Local Testing

Test validation logic:

```bash
node test-webhook.mjs
```

Start the trader server locally:

```bash
# Set env vars first (copy .env.example to .env)
cp .env.example .env
# Edit .env with real creds, then:
node ctrader-trader.mjs
```

Send a test signal:

```bash
curl -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/json" \
  -d '{"Action":"DiMea Long","symbol":"COINBASE:BTCUSD","entry":65000,"tp1":66000,"sl":64000,"notional":5000}'
```

Check health:

```bash
curl http://localhost:8080/health
```

## How It Works

### cTrader Open API Protocol

The cTrader Open API uses **OAuth2** + **WebSocket** with JSON messages.

1. **Token**: `GET https://openapi.ctrader.com/apps/token?grant_type=refresh_token...` — returns access token
2. **WebSocket**: Connect to `wss://demo.ctraderapi.com:5036` (demo) or `wss://live.ctraderapi.com:5036` (live)
3. **Messages**: JSON objects with a `payloadType` field identifying the message type

### Auth Flow (on startup)

1. Refresh access token via REST API
2. Send `ProtoOAApplicationAuthReq` (clientId + clientSecret)
3. Send `ProtoOAGetAccountListByAccessTokenReq` (accessToken)
4. Send `ProtoOAAccountAuthReq` (ctidTraderAccountId + accessToken)
5. Send `ProtoOAGetSymbolsReq` — builds symbol-ID map
6. ✅ Ready to trade!

### Trade Flow

1. TradingView sends JSON alert → trader server `/webhook`
2. Server validates signal, looks up symbol ID
3. Sends `ProtoOACreateMarketOrderReq` over WebSocket
4. Returns order result

### Volume Calculation

Volume = `notional / entry price`, rounded to the symbol's step and clamped to min/max. The cTrader symbol defines the volume unit (e.g. 1000 for 0.01 forex lots, 1 for whole BTC units).

## File Structure

```
tradingview-ctrader-bot/
├── ctrader-trader.mjs       # ⭐ Main server (WebSocket + HTTP, deploy on Railway)
├── .env.example             # Environment variables template
├── package.json             # Dependencies & scripts
├── test-webhook.mjs         # Validation tests
└── README.md                # This file
```

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|------|
| Webhook returns 502 | Trader server down | Check Railway logs: `railway logs` |
| "Symbol not found" | Symbol name mismatch | Check cTrader symbol names in logs |
| "Token refresh failed" | Expired or invalid token | Generate a new one via the OAuth2 flow (`grant_type=authorization_code`) |
| Volume too small | Notional too low | Increase `notional` value in alert |
| WebSocket disconnected | Network issue | Server auto-reconnects with 5s delay |
| Auth fails on reconnect | Token expired | Refresh token should auto-renew tokens |

## Security Notes

- The webhook is publicly accessible — add an API key check if needed
- cTrader credentials are stored as Railway environment variables (never in code)
- Use `CTRADER_DEMO=true` for testing with demo accounts
