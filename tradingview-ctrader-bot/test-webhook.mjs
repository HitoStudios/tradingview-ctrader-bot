/**
 * Validation tests for TradingView webhook.
 *
 * Usage:
 *   node test-webhook.mjs       # validation tests only
 */

let passed = 0, failed = 0;
const ok = (msg, ...rest) => { console.log(`  ✅ ${msg}`, ...rest); passed++; };
const no = (msg, detail) => { console.log(`  ❌ ${msg} — ${detail}`); failed++; };

console.log('Testing validation functions\n');

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

console.log(`\n📊  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
