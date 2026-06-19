/**
 * Test script for the TradingView webhook.
 *
 * Usage:
 *   node test-webhook.mjs                            # test against vercel dev (localhost:3000)
 *   node test-webhook.mjs https://your-app.vercel.app # test against production
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node test-webhook.mjs
 *     # With env vars, tests the function directly (simulates Vercel invocation)
 */

const BASE_URL = process.argv[2] || 'http://localhost:3000';

async function main() {
  console.log(`Testing webhook at: ${BASE_URL}/api/webhook\n`);

  // Simulate a TradingView alert (as TradingView would send it via webhook)
  // The alert format from the user's TradingView script:
  // alert('{"Action":"DiMea Long","entry":...}', freq=alert.freq_once_per_bar_close)
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

  console.log('1️⃣  Sending TradingView signal...');
  console.log(`   ${JSON.stringify(signal)}\n`);

  const webhookRes = await fetch(`${BASE_URL}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signal),
  });

  const webhookResult = await webhookRes.json();
  console.log(`   Response (${webhookRes.status}):`, webhookResult, '\n');

  if (!webhookResult.success) {
    console.error('❌ Webhook test FAILED');
    process.exit(1);
  }

  console.log('2️⃣  Reading back the signal via GET...');
  const getRes = await fetch(`${BASE_URL}/api/latest-signal`);
  const signalData = await getRes.json();
  console.log(`   Response (${getRes.status}):`, signalData, '\n');

  console.log('3️⃣  Consuming the signal via DELETE...');
  const delRes = await fetch(`${BASE_URL}/api/latest-signal`, { method: 'DELETE' });
  const delData = await delRes.json();
  console.log(`   Response (${delRes.status}):`, delData, '\n');

  console.log('4️⃣  Verifying signal is consumed (should return 204)...');
  const verifyRes = await fetch(`${BASE_URL}/api/latest-signal`);
  console.log(`   Response (${verifyRes.status}):`, verifyRes.status === 204 ? '✅ No Content (correct)' : '❌ Unexpected');

  // Test with a Short signal
  console.log('\n5️⃣  Testing Short signal...');
  const shortSignal = {
    Action: 'SMART Short',
    entry: 1850.00,
    tp1: 1840.00,
    tp2: 1835.00,
    tp3: 1825.00,
    sl: 1860.00,
    symbol: 'NASDAQ:US100',
    notional: 200
  };

  const shortRes = await fetch(`${BASE_URL}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shortSignal),
  });

  const shortResult = await shortRes.json();
  console.log(`   Response (${shortRes.status}):`, shortResult, '\n');

  // Clean up
  await fetch(`${BASE_URL}/api/latest-signal`, { method: 'DELETE' });

  console.log('✅ All tests passed!');
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
