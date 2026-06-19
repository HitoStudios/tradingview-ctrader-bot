# TradingView → cTrader Signal Bot

Receives TradingView webhook alerts via **Vercel**, queues them in **Upstash Redis**, and a **cBot running in cTrader Automate Cloud** polls for signals and executes trades with multi-level take profits.

## Architecture

```
TradingView Alert (JSON POST)
        │
        ▼
  ┌─────────────────┐
  │  Vercel Function │  POST /api/webhook
  │  (serverless)    │  Validates & stores signal
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  Upstash Redis   │  Latest signal stored as key/value
  │  (free tier)     │  + history (last 100 signals)
  └────────┬────────┘
           │
  ┌────────▼────────┐
  │  cBot polls      │  GET /api/latest-signal (every 5-60s)
  │  cTrader Cloud   │  DELETE /api/latest-signal after execution
  └────────┬────────┘
           │
           ▼
     Trade Executed!
     ┌── SL (hard stop)
     ├── TP1 (1/3 volume)
     ├── TP2 (1/3 volume)
     └── TP3 (1/3 volume)
```

## Prerequisites

- A [Vercel](https://vercel.com) account (free tier)
- An [Upstash](https://console.upstash.com) Redis database (free tier — 10MB is plenty)
- A cTrader account on **Pipfarm** with **cTrader Automate Cloud** access
- Your trading strategy configured in **TradingView** with webhook alerts

## Setup

### Step 1: Deploy the Vercel Webhook

```bash
# Install Vercel CLI
npm install -g vercel

# Clone/deploy
cd tradingview-ctrader-bot
vercel login
vercel --prod
```

Vercel will ask you to link the project. Follow the prompts.

### Step 2: Configure Upstash Redis

1. Go to [Upstash Console](https://console.upstash.com) → Create Database
2. Choose a region close to your Vercel deployment (e.g., `us-east-1`)
3. Copy the **REST URL** and **REST Token**

### Step 3: Set Environment Variables in Vercel

```bash
vercel env add UPSTASH_REDIS_REST_URL
# Paste your Upstash REST URL

vercel env add UPSTASH_REDIS_REST_TOKEN
# Paste your Upstash REST Token

vercel --prod  # Redeploy with env vars
```

Or set them in the Vercel Dashboard: Project → Settings → Environment Variables.

After deployment, note your Vercel URL: `https://your-project.vercel.app`

### Step 4: Configure TradingView Alert

In your TradingView chart, create an alert with this **Webhook URL**:

```
https://your-project.vercel.app/api/webhook
```

Your alert message should be JSON (you already have this):

```pinescript
alert('{"Action":"DiMea Long","entry":' + str.tostring(entryPrice) + ',"tp1":' + str.tostring(tp1Price) + ',"tp2":' + str.tostring(tp2Price) + ',"tp3":' + str.tostring(tp3Price) + ',"sl":' + str.tostring(hardSL) + ',"symbol":"' + syminfo.tickerid + '","notional":150}', freq=alert.freq_once_per_bar_close)
```

**Expected JSON format:**

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `Action` | string | `"DiMea Long"` | Must end with `" Long"` or `" Short"` |
| `entry` | number | `142.50` | Entry price |
| `tp1` | number | `143.20` | Take profit 1 |
| `tp2` | number | `143.80` | Take profit 2 |
| `tp3` | number | `144.50` | Take profit 3 |
| `sl` | number | `141.80` | Hard stop loss |
| `symbol` | string | `"NASDAQ:US100"` | TradingView ticker ID |
| `notional` | number | `150` | Trade value in USD |

### Step 5: Set Up the cBot in cTrader Automate Cloud

#### Symbol Mapping

TradingView uses ticker IDs like `NASDAQ:US100`, `FX:EURUSD`, etc., but cTrader uses different symbol names (e.g., `US100`, `EURUSD`).

The cBot has a **Symbol Mappings** parameter where you define mappings:

```
NASDAQ:US100:US100, FX:EURUSD:EURUSD, BINANCE:BTCUSDT:BTCUSD
```

Format: `TV_SYMBOL:CTRADER_SYMBOL` separated by commas.

#### Deployment

1. **Copy the cBot code** from `cbot/SignalBot.cs`
2. Open **cTrader** → **Automate** → **cBot** tab
3. Click **New cBot** → paste the code → **Save** (name it `SignalBot`)
4. In cTrader Automate Cloud:
   - Go to **cTrader Automate** → **Cloud** tab
   - Click **Deploy Bot** → select **SignalBot**
   - Configure the parameters (see below)

#### cBot Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| **Vercel Base URL** | Your deployed Vercel app URL | `https://your-project.vercel.app` |
| **Polling Interval (sec)** | How often to check for signals (5-60) | `10` |
| **Default Notional ($)** | Trade size in USD if signal omits it | `150` |
| **Symbol Mappings** | TV symbol → cTrader symbol mappings | `NASDAQ:US100:US100, FX:EURUSD:EURUSD` |

## Testing the Webhook

```bash
# Test locally (no Redis needed — uses in-memory fallback)
node test-integration.mjs

# Test against your deployed Vercel app
node test-webhook.mjs https://your-project.vercel.app
```

## How It Works

### Webhook Flow (Vercel)

1. TradingView sends a `POST` with JSON to `/api/webhook`
2. The function validates all required fields
3. Stores the signal in Upstash Redis (overwrites previous pending signal)
4. Also appends to a history list (keeps last 100 signals)
5. Returns `{ success: true, id: "..." }`

### cBot Flow (cTrader Cloud)

1. **OnTick**: Every N seconds, sends `GET /api/latest-signal`
2. If a signal exists:
   - Maps the TradingView symbol → cTrader symbol
   - Checks no position exists for this symbol (avoids duplicates)
   - Calculates volume from notional value
   - Places a **market order** with SL at `hardSL`
   - Places **3 take-profit limit orders** at TP1, TP2, TP3 (1/3 volume each)
   - Sends `DELETE /api/latest-signal` to consume the signal
3. If TP volumes are below the symbol's minimum, falls back to setting TP1 on the position

### Signal Acknowledgment

The cBot tracks processed signals by their `_id` field to avoid re-processing. After executing a trade, it deletes the signal from Redis so the next poll returns 204 (No Content) until a new alert arrives.

## File Structure

```
tradingview-ctrader-bot/
├── api/
│   ├── webhook.js          # POST /api/webhook — receives TradingView alerts
│   └── latest-signal.js    # GET/DELETE /api/latest-signal — cBot interface
├── cbot/
│   └── SignalBot.cs        # cBot for cTrader Automate Cloud
├── .env.example            # Environment variables template
├── vercel.json             # Vercel deployment config
├── package.json            # Dependencies & scripts
├── test-integration.mjs    # 25 integration tests
├── test-webhook.mjs        # End-to-end webhook test
└── README.md               # This file
```

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|-----|
| Webhook returns 400 | Invalid JSON format | Check TradingView alert payload |
| Signal stored but no trade | Symbol mapping missing | Add mapping in cBot parameters |
| cBot not polling | Wrong Vercel URL | Check Vercel Base URL parameter |
| "Failed to read signal" | Redis env vars not set | `vercel env add UPSTASH_REDIS_*` |
| Position not opening | Volume below minimum | Increase notional value |
| Duplicate trades | Signal not consumed | Check DELETE endpoint works |

## Security Notes

- The webhook is publicly accessible — anyone who knows your URL can send signals
- For production, consider adding a shared secret (API key) validation to the webhook
- Redis credentials are stored as Vercel environment variables (never in code)
- The cBot runs in cTrader Cloud's sandboxed environment
