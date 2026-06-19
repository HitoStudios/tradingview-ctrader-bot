/**
 * Integration test for Vercel webhook + latest-signal endpoints.
 *
 * Tests both the Node.js HTTP handler invocation locally and the
 * validation/signal flow. Uses in-memory fallback (no Redis needed).
 */

import http from 'http';
import { randomUUID } from 'crypto';

// Dynamically import the handlers (they use @upstash/redis, which is fine)
const webhookUrl = new URL('./api/webhook.js', `file://${process.cwd()}/`);
const signalUrl = new URL('./api/latest-signal.js', `file://${process.cwd()}/`);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

// Mock req/res for testing Vercel functions
function createMockReqRes(method, body, headers = {}) {
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body,
  };
  const chunks = [];
  const res = {
    _status: 0,
    _headers: {},
    _body: null,
    status(code) { this._status = code; return this; },
    json(data) { this._body = data; this._sent = true; },
    end(data) {
      if (data) this._body = data;
      this._sent = true;
    },
    setHeader(k, v) { this._headers[k] = v; },
    get statusCode() { return this._status; },
  };
  return { req, res };
}

async function runTests() {
  console.log('🧪 TradingView → Vercel Webhook Integration Tests\n');

  // --- Test 1: Valid Long signal ---
  console.log('--- Test 1: Valid Long signal ---');
  const { default: webhookHandler } = await import(webhookUrl.href);
  const { default: signalHandler } = await import(signalUrl.href);

  const longSignal = {
    Action: 'DiMea Long',
    entry: 142.50,
    tp1: 143.20,
    tp2: 143.80,
    tp3: 144.50,
    sl: 141.80,
    symbol: 'NASDAQ:US100',
    notional: 150,
  };

  const { req: whReq, res: whRes } = createMockReqRes('POST', longSignal);
  await webhookHandler(whReq, whRes);

  assert(whRes._body?.success === true, 'Webhook returns success=true');
  assert(whRes._body?.id, 'Webhook returns an ID');
  assert(whRes._body?.message?.includes('DiMea Long'), `Message mentions action: "${whRes._body?.message}"`);

  const signalId = whRes._body?.id;

  // Test GET latest-signal
  const { req: getReq, res: getRes } = createMockReqRes('GET');
  await signalHandler(getReq, getRes);

  assert(getRes._body?.Action === 'DiMea Long', 'GET returns correct Action');
  assert(getRes._body?.symbol === 'NASDAQ:US100', 'GET returns correct symbol');
  assert(getRes._body?.entry === 142.50, 'GET returns correct entry price');
  assert(getRes._body?._id === signalId, 'GET returns same signal ID');
  assert(getRes._body?._receivedAt, 'GET includes _receivedAt timestamp');

  // Test DELETE latest-signal (consume)
  const { req: delReq, res: delRes } = createMockReqRes('DELETE');
  await signalHandler(delReq, delRes);

  assert(delRes._body?.Action === 'DiMea Long', 'DELETE returns the signal');
  assert(delRes._body?._id === signalId, 'DELETE returns same signal ID');

  // Test GET after DELETE (should be 204 No Content)
  const { req: getReq2, res: getRes2 } = createMockReqRes('GET');
  await signalHandler(getReq2, getRes2);
  assert(getRes2._status === 204, 'GET after DELETE returns 204 (no content)');

  // --- Test 2: Valid Short signal ---
  console.log('\n--- Test 2: Valid Short signal ---');
  const shortSignal = {
    Action: 'SMART Short',
    entry: 1850.00,
    tp1: 1840.00,
    tp2: 1835.00,
    tp3: 1825.00,
    sl: 1860.00,
    symbol: 'NASDAQ:US100',
    notional: 200,
  };

  const { req: whReq2, res: whRes2 } = createMockReqRes('POST', shortSignal);
  await webhookHandler(whReq2, whRes2);
  assert(whRes2._body?.success === true, 'Short signal accepted');

  // Test GET for short signal
  const { req: getReq3, res: getRes3 } = createMockReqRes('GET');
  await signalHandler(getReq3, getRes3);
  assert(getRes3._body?.Action === 'SMART Short', 'Short signal retrieved correctly');
  assert(getRes3._body?.notional === 200, 'Notional preserved');

  // Clean up
  const { req: delReq2, res: delRes2 } = createMockReqRes('DELETE');
  await signalHandler(delReq2, delRes2);

  // --- Test 3: Rejection of invalid signals ---
  console.log('\n--- Test 3: Rejection of invalid signals ---');

  const badSignals = [
    { body: {}, desc: 'Missing all fields' },
    { body: { Action: 'BadAction' }, desc: 'Invalid Action format' },
    { body: { Action: 'DiMea Long' }, desc: 'Missing symbol' },
    { body: { Action: 'DiMea Long', symbol: 'X', entry: -1, sl: 1, notional: 1 }, desc: 'Negative entry price' },
    { body: { Action: 'Hello World', symbol: 'X', entry: 1, sl: 1, notional: 1 }, desc: 'Action not ending in Long/Short' },
  ];

  for (const { body, desc } of badSignals) {
    const { req: badReq, res: badRes } = createMockReqRes('POST', body);
    await webhookHandler(badReq, badRes);
    assert(badRes._status !== 200, `Rejected: ${desc} (status ${badRes._status})`);
  }

  // --- Test 4: Method validation ---
  console.log('\n--- Test 4: Method validation ---');
  const { req: getReq4, res: getRes4 } = createMockReqRes('POST', {});  // POST to latest-signal
  // We need to reload the module to test this... actually latest-signal handles POST as 405
  const { req: postToSignal, res: postToSignalRes } = createMockReqRes('POST', { test: true });
  await signalHandler(postToSignal, postToSignalRes);
  assert(postToSignalRes._status === 405, 'POST to /api/latest-signal returns 405');

  const { req: getToWebhook, res: getToWebhookRes } = createMockReqRes('GET');
  await webhookHandler(getToWebhook, getToWebhookRes);
  assert(getToWebhookRes._status === 405, 'GET to /api/webhook returns 405');

  // --- Test 5: Multiple signals (overwrite behavior) ---
  console.log('\n--- Test 5: Signal overwrite (keep latest only) ---');
  const sig1 = { Action: 'DiMea Long', entry: 100, tp1: 101, tp2: 102, tp3: 103, sl: 99, symbol: 'FX:EURUSD', notional: 150 };
  const sig2 = { Action: 'DiMea Short', entry: 200, tp1: 199, tp2: 198, tp3: 197, sl: 201, symbol: 'FX:GBPUSD', notional: 200 };

  const { req: whS1, res: whR1 } = createMockReqRes('POST', sig1);
  await webhookHandler(whS1, whR1);
  assert(whR1._body?.success === true, 'Signal 1 stored');

  const { req: whS2, res: whR2 } = createMockReqRes('POST', sig2);
  await webhookHandler(whS2, whR2);
  assert(whR2._body?.success === true, 'Signal 2 stored (overwrites signal 1)');

  const { req: getOver, res: getOverR } = createMockReqRes('GET');
  await signalHandler(getOver, getOverR);
  assert(getOverR._body?.symbol === 'FX:GBPUSD', 'Latest signal overwrote previous (symbol=FX:GBPUSD)');
  assert(getOverR._body?.Action === 'DiMea Short', 'Latest signal has correct action');

  // Clean up
  const { req: delOver, res: delOverR } = createMockReqRes('DELETE');
  await signalHandler(delOver, delOverR);

  // --- Summary ---
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
