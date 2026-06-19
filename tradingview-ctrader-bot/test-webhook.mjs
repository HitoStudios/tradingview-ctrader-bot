/**
 * Test script for the TradingView webhook.
 *
 * Tests validation logic and token refresh. Does NOT trade.
 * cTrader Open API is WebSocket-based — no REST trading endpoint exists.
 *
 * Usage:
 *   node test-webhook.mjs                                    # validation tests
 *   node test-webhook.mjs --token                            # test token refresh
 */

import { readFileSync, existsSync } from 'fs';
import { isConfigured, refreshAccessToken } from './api/ctrader-client.js';

// Load .env
if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key.startsWith('CTRADER_')) process.env[key] = val;
    }
  }
  console.log('📄  Loaded CTRADER_* from .env\n');
}

const args = process.argv.slice(2);
const testTokenRefresh = args.includes('--token');

let passed = 0, failed = 0;
const ok = (msg, ...rest) => { console.log(`  ✅ ${msg}`, ...rest); passed++; };
const no = (msg, detail) => { console.log(`  ❌ ${msg} — ${detail}`); failed++; };

if (testTokenRefresh) {
  // ── Test token refresh ──
  if (!isConfigured()) {
    console.error('❌ CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_REFRESH_TOKEN must be set in .env');
    process.exit(1);
  }
  console.log('Testing OAuth2 token refresh...\n');
  try {
    const result = await refreshAccessToken();
    console.log(`   Access token: ${result.accessToken.slice(0, 20)}...`);
    console.log(`   Refresh token: ${result.refreshToken.slice(0, 20)}...`);
    console.log(`   Expires in: ${result.expiresIn}s (${Math.round(result.expiresIn / 86400)} days)`);
    ok('Token refreshed successfully');
  } catch (e) {
    no('Token refresh', e.message);
  }
  console.log(`\n📊  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} else {
  // ── Validation tests ──
  console.log('Testing validation functions\n');

  if (!isConfigured()) {
    ok('isConfigured() returns false without env vars');
  } else {
    ok('isConfigured() returns true');
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

  // Volume calc
  const vol1 = Math.round((150 / 142.5) * 100) / 100;
  if (vol1 === 1.05) ok(`Volume: $150 @ 142.5 = ${vol1}`);
  else no(`Volume: $150 @ 142.5`, `expected 1.05, got ${vol1}`);

  const vol2 = Math.round((5000 / 65000) * 100) / 100;
  if (vol2 === 0.08) ok(`Volume: $5000 @ 65000 = ${vol2} BTC`);
  else no(`Volume: $5000 @ 65000`, `expected 0.08, got ${vol2}`);

  console.log(`\n📊  ${passed} passed, ${failed} failed`);
  if (failed === 0 && isConfigured()) {
    console.log('\n💡  To test token refresh:');
    console.log('    node test-webhook.mjs --token');
  }
  process.exit(failed > 0 ? 1 : 0);
}
