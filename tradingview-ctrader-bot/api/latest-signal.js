import { Redis } from '@upstash/redis';

// Share memory store with webhook module via dynamic import
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

// Sync memory store from webhook module
async function syncMemoryStore() {
  try {
    const webhook = await import('./webhook.js');
    memoryStore = webhook.getMemoryStore();
  } catch {
    // If import fails (e.g., running standalone), keep local memoryStore
  }
}

export const config = {
  runtime: 'nodejs18.x',
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const store = await getStore();

  if (req.method === 'GET') {
    try {
      let signal;

      if (store.type === 'redis') {
        signal = await store.client.get('tradingview:latest_signal');
      } else {
        await syncMemoryStore();
        signal = memoryStore;
      }

      if (!signal) {
        return res.status(204).end();
      }

      return res.status(200).json(signal);
    } catch (error) {
      console.error('Error reading signal:', error);
      return res.status(500).json({ error: 'Failed to read signal' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      let signal;

      if (store.type === 'redis') {
        signal = await store.client.getdel('tradingview:latest_signal');
      } else {
        await syncMemoryStore();
        signal = memoryStore;
        memoryStore = null;
        // Also clear in webhook module
        try {
          const webhook = await import('./webhook.js');
          webhook.clearMemoryStore();
        } catch {}
      }

      if (!signal) {
        return res.status(204).end();
      }

      return res.status(200).json(signal);
    } catch (error) {
      console.error('Error consuming signal:', error);
      return res.status(500).json({ error: 'Failed to consume signal' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed. Use GET or DELETE.' });
}
