import { edge, node, sla, type Sev1Scenario } from './model';

const name = 'UPI Payment Switch Silent Retry Storm';
const bankB = edge('switch', 'bank-b', false);

export const upiRetryStorm: Sev1Scenario = {
  id: 'upi-retry-storm',
  name,
  brief: 'SEV-1 · 18:42 IST. Merchant checkouts are timing out during the evening peak. Bank A authorizations are healthy, but the switch is waiting on a degraded redundant route check against Bank B.',
  symptomSummary: 'The Bank B route check is slow and intermittently fails. Immediate retries hold switch workers, and Bank A can no longer absorb the growing wait at the switch.',
  canonicalFixHints: [
    'Compare Bank B ingress with incoming payment RPS and check how long switch workers remain busy.',
    'Open the breaker on the Bank B link, use bounded exponential retries with full jitter, and tighten the Bank B and switch deadlines.',
  ],
  topology: {
    id: 'upi-retry-storm',
    name,
    nodes: [
      node('traffic', 'Payment Traffic', 'traffic', 70, 280, { trafficRps: 1_300, baseLatencyMs: 0 }),
      node('gateway', 'Payments Gateway', 'gateway', 310, 280),
      node('switch', 'UPI Switch', 'service', 560, 280, {
        baseLatencyMs: 2, workerPoolCapacity: 110, maxQueueSize: 100,
        retryPolicy: { strategy: 'fixed', retryBudget: 3, delayMs: 0 },
      }),
      node('bank-a', 'Bank A', 'external', 870, 155, { baseLatencyMs: 8 }),
      node('bank-b', 'Bank B', 'external', 870, 405, { baseLatencyMs: 10, workerPoolCapacity: 180 }),
    ],
    edges: [edge('traffic', 'gateway'), edge('gateway', 'switch'), edge('switch', 'bank-a'), bankB],
  },
  slaTargets: sla(95, 1),
  errorBudget: 0.13,
  initialFaults: [
    { id: 'bank-b-degraded', kind: 'latency_error', nodeId: 'bank-b', startMs: 0, durationMs: 24_000,
      parameters: { latencyMs: 68, errorRate: 0.65 } },
  ],
  canonicalFix: {
    switch: {
      retryPolicy: { strategy: 'exponential_jitter', retryBudget: 3, delayMs: 12 },
      timeoutMs: 90,
      edgeCircuitBreakers: { [bankB.id]: { minSamples: 12, errorThresholdPct: 50, openDurationMs: 550 } },
    },
    'bank-b': { timeoutMs: 25 },
  },
};
