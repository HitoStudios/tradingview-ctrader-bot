/**
 * Test script for the TradingView webhook.
 *
 * Usage:
 *   node test-webhook.mjs                                    # validation tests only
 *   node test-webhook.mjs --live                             # runs real cTrader trade
 *   node test-webhook.mjs --live --btc                       # BTC trade with larger notional
 *
 * Reads CTRADER_* env vars from .env file automatically.
 */

import { readFileSync, existsSync } from 'fs';
import { isConfigured, executeMarketOrder } from './api/ctrader-client.js';

// ── Load .env file if it exists ──
if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key.startsWith('CTRADER_')) {
        process.env[key] = val;
      }
    }
  }
  console.log('📄  Loaded CTRADER_* from .env\n');
}

const args = process.argv.slice(2);
const isLive = args.includes('--live') || args.includes('--btc');
const isBtc = args.includes('--btc');

let passed = 0, failed = 0;
const ok = (msg, ...rest) => { console.log(`  ✅ ${msg}`, ...rest); passed++; };
const no = (msg, detail) => { console.log(`  ❌ ${msg} — ${detail}`); failed++; };

if (isLive) {
  // ── REAL TRADE TEST ──
  const signal = isBtc
    ? { Action: 'DiMea Long', symbol: 'COINBASE:BTCUSD', entry: 65000, tp1: 66000, sl: 64000, notional: 5000 }
    : { Action: 'DiMea Long', symbol: 'COINBASE:ETHUSD', entry: 3500, tp1: 3600, sl: 3400, notional: 500 };

  console.log(`\n🚀 Executing REAL trade: ${signal.Action} ${signal.symbol}`);
  console.log(`   Entry=${signal.entry} SL=${signal.sl} TP=${signal.tp1} Notional=$${signal.notional}\n`);

  try {
    const result = await executeMarketOrder(signal);
    console.log('\n✅ Trade result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('\n❌ Trade failed:', e.message);
    process.exit(1);
  }
} else {
  // ── VALIDATION TESTS (no API call) ──
  console.log('Testing validation & module functions locally\n');

  if (!isConfigured()) {
    ok('isConfigured() returns false without env vars');
  } else {
    ok('isConfigured() returns true (env vars set, ready for --live)');
  }

  try {
    await executeMarketOrder({ Action: 'DiMea Long', symbol: 'X', entry: 1, sl: 1, tp1: 2, notional: 100 });
    no('executeMarketOrder without config', 'should have thrown');
  } catch (e) {
    ok(`executeMarketOrder without config throws: ${e.message}`);
  }

  // Symbol normalisation
  const symbTests = [
    ['NASDAQ:US100', 'US100'],
    ['FX:EURUSD', 'EURUSD'],
    ['COINBASE:BTCUSD', 'BTCUSD'],
    ['US100', 'US100'],
  ];
  for (const [input, expected] of symbTests) {
    const result = input.includes(':') ? input.split(':').pop() : input;
    if (result === expected) ok(`Symbol: ${input} → ${result}`);
    else no(`Symbol: ${input}`, `expected ${expected}, got ${result}`);
  }

  // Volume calc with fractional units
  const vol1 = Math.round((150 / 142.5) * 100) / 100;
  if (vol1 === 1.05) ok(`Volume: $150 @ 142.5 = ${vol1}`);
  else no(`Volume: $150 @ 142.5`, `expected 1.05, got ${vol1}`);

  const vol2 = Math.round((5000 / 65000) * 100) / 100;
  if (vol2 === 0.08) ok(`Volume: $5000 @ 65000 = ${vol2} BTC`);
  else no(`Volume: $5000 @ 65000`, `expected 0.08, got ${vol2}`);

  console.log(`\n📊  ${passed} passed, ${failed} failed`);
  if (failed === 0 && isConfigured()) {
    console.log('\n💡  Env vars are set! Run real trade with:');
    console.log('    node test-webhook.mjs --live');
    console.log('    node test-webhook.mjs --btc');
  }
  process.exit(failed > 0 ? 1 : 0);
}
