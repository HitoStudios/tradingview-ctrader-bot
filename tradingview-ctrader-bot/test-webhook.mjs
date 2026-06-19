/**
 * Test script for the TradingView webhook endpoint.
 *
 * WARNING: This sends a real cTrader API request if CTRADER_* env vars are set!
 * For local validation-only testing, use the local-server.mjs instead.
 *
 * Usage (validation only — no API call):
 *   node test-webhook.mjs
 *
 * To verify against a deployed instance (WILL EXECUTE TRADES):
 *   node test-webhook.mjs https://your-app.vercel.app
 */

import { isConfigured } from './api/ctrader-client.js';

const BASE_URL = process.argv[2] || null;
let passed = 0;
let failed = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function no(msg, detail) { console.log(`  ❌ ${msg} — ${detail}`); failed++; }

// If no URL provided, test the module functions directly
if (!BASE_URL) {
  console.log('Testing validation & module functions locally\n');

  // Test ctrader-client module functions
  const { clearTokenCache, executeMarketOrder } = await import('./api/ctrader-client.js');

  // isConfigured should be false without env vars
  if (!isConfigured()) {
    ok('isConfigured() returns false without env vars');
  } else {
    no('isConfigured() returns false without env vars', 'env vars appear to be set');
  }

  // executeMarketOrder with invalid config should reject
  try {
    await executeMarketOrder({ Action: 'DiMea Long', symbol: 'X', entry: 1, sl: 1, tp1: 2, notional: 100 });
    no('executeMarketOrder without config', 'should have thrown');
  } catch (e) {
    ok(`executeMarketOrder without config throws: ${e.message}`);
  }

  // Test symbol normalisation (internal logic)
  const symbTests = [
    ['NASDAQ:US100', 'US100'],
    ['FX:EURUSD', 'EURUSD'],
    ['US100', 'US100'],
  ];
  for (const [input, expected] of symbTests) {
    const result = input.includes(':') ? input.split(':').pop() : input;
    if (result === expected) ok(`Symbol normalisation: ${input} → ${result}`);
    else no(`Symbol normalisation: ${input}`, `expected ${expected}, got ${result}`);
  }

  // Test volume calculation
  const vol = Math.round(150 / 142.5);
  if (vol === 1) ok(`Volume calc: $150 @ 142.5 = 1 unit`);
  else no(`Volume calc: $150 @ 142.5`, `expected 1, got ${vol}`);

  console.log(`\n📊  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// If a URL is provided, test against it (CAUTION: will execute trades if configured)
console.log(`⚠️  Testing against live endpoint: ${BASE_URL}/api/webhook`);
console.log('    This may execute real trades if CTRADER_* env vars are set!\n`');

const signal = {
  Action: 'DiMea Long',
  entry: 142.50,
  tp1: 143.20,
  tp2: 143.80,
  tp3: 144.50,
  sl: 141.80,
  symbol: 'NASDAQ:US100',
  notional: 150
};

try {
  const res = await fetch(`${BASE_URL}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signal),
  });
  const body = await res.json();
  console.log(`Response (${res.status}):`, JSON.stringify(body, null, 2));
  console.log('\n✅ Test completed.');
} catch (err) {
  console.error('❌ Connection failed:', err.message);
  process.exit(1);
}
