import { linear, node, sla, type Sev1Scenario } from './model';

const name = 'Diwali Flash-Sale Pool Exhaustion';

export const diwaliPoolExhaustion: Sev1Scenario = {
  id: 'diwali-pool-exhaustion',
  name,
  brief: 'SEV-1 · 20:00 IST. The Diwali sale is live. Checkout is returning 503s while inventory reads hold primary connections. Restore checkout without accepting more queued work than the system can drain.',
  symptomSummary: 'Slow inventory reads tie up the primary pool. Loose deadlines keep checkout workers waiting, and both the DB and checkout queues start dropping work.',
  canonicalFixHints: [
    'Follow checkout spans to the primary DB and compare active workers with each queue depth.',
    'Shorten checkout deadlines, cap queues, resize the DB pool and turn on caching for inventory reads.',
  ],
  topology: linear('diwali-pool-exhaustion', name, [
    node('traffic', 'Flash-Sale Traffic', 'traffic', 70, 280, { trafficRps: 700, baseLatencyMs: 0 }),
    node('gateway', 'API Gateway', 'gateway', 280, 280),
    node('checkout', 'Checkout Service', 'service', 490, 280, {
      workerPoolCapacity: 120, maxQueueSize: 180, timeoutMs: 1_200, baseLatencyMs: 3,
    }),
    node('inventory-cache', 'Inventory Read Cache', 'cache', 700, 280, {
      cache: { enabled: false, keyCount: 32, ttlMs: 1_200 }, sharding: { zipfSkew: 1.1 },
    }),
    node('primary-db', 'Primary DB', 'database', 910, 280, {
      workerPoolCapacity: 36, maxQueueSize: 350, baseLatencyMs: 10, timeoutMs: 1_000,
    }),
  ]),
  slaTargets: sla(150, 1.5),
  errorBudget: 0.15,
  initialFaults: [
    { id: 'flash-sale', kind: 'traffic_spike', nodeId: 'traffic', startMs: 0, durationMs: 24_000, parameters: { multiplier: 2 } },
    { id: 'slow-inventory', kind: 'latency_error', nodeId: 'primary-db', startMs: 0, durationMs: 24_000,
      parameters: { latencyMs: 65 } },
  ],
  canonicalFix: {
    gateway: { timeoutMs: 205, maxQueueSize: 64 },
    checkout: { timeoutMs: 175, maxQueueSize: 48 },
    'inventory-cache': { cache: { enabled: true, singleflight: true, ttlJitterPercent: 20 } },
    'primary-db': { workerPoolCapacity: 90, maxQueueSize: 80, timeoutMs: 130 },
  },
};
