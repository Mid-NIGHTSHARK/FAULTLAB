import { linear, node, sla, type Sev1Scenario } from './model';

const name = 'IRCTC Tatkal 10:00 AM Thundering Herd';

export const tatkal: Sev1Scenario = {
  id: 'tatkal',
  name,
  brief: 'SEV-1 · 10:00 IST. Tatkal booking just opened. Agents report stalled train searches across multiple zones. Restore booking availability while the opening rush is still arriving.',
  symptomSummary: 'Redis hit rate drops in waves. The Train DB receives duplicate lookups for the same services, fills its queues and pushes booking p99 past the SLA.',
  canonicalFixHints: [
    'Compare Redis misses with DB ingress and queue depth at each expiry wave.',
    'Enable singleflight on Redis and spread key expiry with 20% TTL jitter.',
  ],
  topology: linear('tatkal', name, [
    node('traffic', 'Tatkal Traffic', 'traffic', 70, 280, { trafficRps: 900, baseLatencyMs: 0 }),
    node('gateway', 'API Gateway', 'gateway', 280, 280),
    node('booking', 'Booking Service', 'service', 490, 280, { workerPoolCapacity: 600, baseLatencyMs: 3 }),
    node('redis', 'Redis Cache', 'cache', 700, 280, {
      cache: { keyCount: 24, ttlMs: 1_500, ttlJitterPercent: 0, singleflight: false },
      sharding: { zipfSkew: 1.8 },
    }),
    node('train-db', 'Sharded Train DB', 'database', 910, 280, {
      sharding: { shardCount: 4 }, workerPoolCapacity: 6, maxQueueSize: 16, baseLatencyMs: 65,
    }),
  ]),
  slaTargets: sla(165, 1.5),
  errorBudget: 0.13,
  initialFaults: [
    { id: 'opening-rush', kind: 'traffic_spike', nodeId: 'traffic', startMs: 0, durationMs: 24_000, parameters: { multiplier: 2 } },
    { id: 'coordinated-expiry', kind: 'cache_flush', nodeId: 'redis', startMs: 0, durationMs: 750, parameters: {} },
  ],
  canonicalFix: { redis: { cache: { singleflight: true, ttlJitterPercent: 20 } } },
};
