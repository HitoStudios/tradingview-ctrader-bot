import { Redis } from '@upstash/redis';

// Use in-memory store as fallback when Redis is not configured (e.g., local testing)
let memoryStore = null;

async function getStore() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      type: 'redis',
      client: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      }),
    };
  }
  return { type: 'memory' };
}

export const config = {
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const signal = req.body;

    // Validate required fields
    if (!signal || !signal.Action || !signal.symbol) {
      return res.status(400).json({
        error: 'Missing required fields: Action, symbol',
        received: signal,
      });
    }

    // Validate Action format — must end with " Long" or " Short"
    if (!signal.Action.endsWith(' Long') && !signal.Action.endsWith(' Short')) {
      return res.status(400).json({
        error: 'Action must end with " Long" or " Short" (e.g., "DiMea Long")',
        received: signal.Action,
      });
    }

    // Validate numeric fields
    if (typeof signal.entry !== 'number' || signal.entry <= 0) {
      return res.status(400).json({ error: 'entry must be a positive number', received: signal.entry });
    }
    if (typeof signal.sl !== 'number' || signal.sl <= 0) {
      return res.status(400).json({ error: 'sl must be a positive number', received: signal.sl });
    }
    if (typeof signal.notional !== 'number' || signal.notional <= 0) {
      return res.status(400).json({ error: 'notional must be a positive number', received: signal.notional });
    }

    // Add timestamp and a unique ID
    signal._receivedAt = new Date().toISOString();
    signal._id = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Store the signal
    const store = await getStore();

    if (store.type === 'redis') {
      const redis = store.client;
      await redis.set('tradingview:latest_signal', signal);
      await redis.lpush('tradingview:signal_history', signal);
      await redis.ltrim('tradingview:signal_history', 0, 99);
    } else {
      memoryStore = signal;
    }

    console.log('Signal stored:', signal._id, signal.Action, signal.symbol);

    return res.status(200).json({
      success: true,
      id: signal._id,
      message: `Signal stored for ${signal.symbol} - ${signal.Action}`,
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
}

// Export memory store for testing
export function getMemoryStore() {
  return memoryStore;
}

export function clearMemoryStore() {
  memoryStore = null;
}
