import { linear, node, sla, type Sev1Scenario } from './model';

const name = 'Viral Merchant Hot-Shard Meltdown';

export const hotShard: Sev1Scenario = {
  id: 'hot-shard',
  name,
  brief: 'SEV-1 · 13:17 IST. A viral deal is sending order lookups to one merchant. Support is seeing failures even though the shard cluster dashboard shows spare capacity.',
  symptomSummary: 'Shard 0 handles most requests and runs out of workers. The other three shards stay mostly idle, hiding the bottleneck in the cluster average.',
  canonicalFixHints: [
    'Break down incoming load by shard and compare shard 0 with the other three shards.',
    'Cache hot merchant lookups with singleflight and use the gateway token bucket to trim the top of the surge.',
  ],
  topology: linear('hot-shard', name, [
    node('traffic', 'Merchant Traffic', 'traffic', 70, 280, { trafficRps: 1_200, baseLatencyMs: 0 }),
    node('gateway', 'API Gateway', 'gateway', 280, 280),
    node('orders', 'Order Service', 'service', 490, 280, { baseLatencyMs: 3 }),
    node('merchant-cache', 'Merchant Lookup Cache', 'cache', 700, 280, {
      cache: { enabled: false, keyCount: 96, ttlMs: 2_400 },
      sharding: { zipfSkew: 2.4 },
    }),
    node('merchant-db', '4-Shard Order DB', 'database', 910, 280, {
      sharding: { shardCount: 4 }, workerPoolCapacity: 15, baseLatencyMs: 26, maxQueueSize: 36,
    }),
  ]),
  slaTargets: sla(80, 2),
  errorBudget: 0.13,
  initialFaults: [
    { id: 'viral-merchant', kind: 'hot_key_skew', nodeId: 'merchant-db', startMs: 0, durationMs: 24_000, parameters: { skew: 4 } },
  ],
  canonicalFix: {
    gateway: { rateLimiter: { rps: 1_188, burst: 24 } },
    'merchant-cache': { cache: { enabled: true, singleflight: true, ttlJitterPercent: 20 } },
  },
};
