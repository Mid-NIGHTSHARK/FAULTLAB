import { linear, node } from './model';

export const sandbox = linear('sandbox', 'Free-Build Sandbox', [
  node('traffic', 'Traffic', 'traffic', 70, 280, { trafficRps: 600, baseLatencyMs: 0 }),
  node('gateway', 'Gateway', 'gateway', 280, 280),
  node('app', 'App Service', 'service', 490, 280, { baseLatencyMs: 4 }),
  node('redis', 'Redis Cache', 'cache', 700, 280, {
    cache: { keyCount: 64, ttlMs: 1_500, ttlJitterPercent: 20, singleflight: true },
    sharding: { zipfSkew: 1 },
  }),
  node('db', '2-Shard DB', 'database', 910, 280, {
    sharding: { shardCount: 2 }, workerPoolCapacity: 12, baseLatencyMs: 12,
  }),
]);
