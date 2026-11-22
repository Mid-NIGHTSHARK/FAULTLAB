import { linear, node, sla, type Sev1Scenario } from './model';

const name = 'Quick-Commerce Queue Backpressure Cascade';

export const queueBackpressure: Sev1Scenario = {
  id: 'queue-backpressure',
  name,
  brief: 'SEV-1 · 19:25 IST. Dinner-hour orders in multiple metros are returning 503s. Fulfillment is falling behind and order intake has started rejecting jobs.',
  symptomSummary: 'Slow fulfillment occupies queue consumers. The async backlog reaches its cap, and enqueue failures propagate through the Order API to the gateway.',
  canonicalFixHints: [
    'Compare queue depth and worker occupancy. A 202 only confirms that an order entered the queue.',
    'Shed bursts at the gateway, bound the backlog and increase consumer and fulfillment concurrency until admitted traffic drains.',
  ],
  topology: linear('queue-backpressure', name, [
    node('traffic', 'Quick-Commerce Traffic', 'traffic', 70, 280, { trafficRps: 1_350, baseLatencyMs: 0 }),
    node('gateway', 'API Gateway', 'gateway', 280, 280),
    node('order-api', 'Order API', 'service', 490, 280, { baseLatencyMs: 3 }),
    node('jobs', 'Async Queue', 'queue', 700, 280, {
      workerPoolCapacity: 42, maxQueueSize: 450, baseLatencyMs: 1,
    }),
    node('fulfillment', 'Fulfillment Worker', 'service', 910, 280, {
      workerPoolCapacity: 65, maxQueueSize: 180, baseLatencyMs: 8,
    }),
  ]),
  slaTargets: sla(25, 2.5),
  errorBudget: 0.14,
  initialFaults: [
    { id: 'fulfillment-stall', kind: 'latency_error', nodeId: 'fulfillment', startMs: 0, durationMs: 24_000,
      parameters: { latencyMs: 75 } },
  ],
  canonicalFix: {
    gateway: { rateLimiter: { rps: 1_325, burst: 32 } },
    jobs: { maxQueueSize: 150, workerPoolCapacity: 165 },
    fulfillment: { workerPoolCapacity: 165, maxQueueSize: 48 },
  },
};
