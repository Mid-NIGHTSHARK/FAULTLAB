import { describe, expect, it } from 'vitest';
import { createSimulator, type TickSnapshot } from '../src/engine/simulator';
import { incidents, sandbox, type ScenarioTopology, type Sev1Scenario } from '../src/scenarios';

const RUN_MS = 18_000;
const FIX_AT_MS = 5_000;
const TICK_MS = 100;

function healthy(scenario: Sev1Scenario, snapshot: TickSnapshot): boolean {
  return snapshot.global.p99 <= scenario.slaTargets.p99LatencyMs &&
    snapshot.global.errorRate * 100 <= scenario.slaTargets.maxErrorRatePct;
}

function checkTopology(topology: ScenarioTopology) {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  expect(nodes.size).toBe(topology.nodes.length);
  expect(new Set(topology.edges.map((edge) => edge.id)).size).toBe(topology.edges.length);
  for (const { id, x, y } of topology.nodes) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1_000);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(560);
    for (const other of topology.nodes.filter((node) => node.id !== id)) {
      expect(Math.abs(other.x - x) >= 150 || Math.abs(other.y - y) >= 100).toBe(true);
    }
  }
  for (const edge of topology.edges) {
    const source = nodes.get(edge.sourceNodeId);
    const target = nodes.get(edge.targetNodeId);
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    // Strictly increasing x along every edge also proves the topology is acyclic.
    expect(source!.x).toBeLessThan(target!.x);
  }
  const reachable = new Set(topology.nodes.filter((node) => node.type === 'traffic').map((node) => node.id));
  for (const node of [...topology.nodes].sort((a, b) => a.x - b.x)) {
    expect(reachable.has(node.id)).toBe(true);
    for (const edge of topology.edges) if (edge.sourceNodeId === node.id) reachable.add(edge.targetNodeId);
  }
}

function run(scenario: Sev1Scenario, seed: number, fixAtMs?: number) {
  const simulator = createSimulator(scenario.topology, { seed, scenario, tickMs: TICK_MS });
  const applyFix = () => {
    for (const [nodeId, patch] of Object.entries(scenario.canonicalFix)) simulator.updateNodeConfig(nodeId, patch);
  };
  let beforeFix: TickSnapshot | undefined;
  let end = simulator.getSnapshot();
  let lateBreaches = 0;
  let peakQueueDepth = 0;
  const history: Pick<TickSnapshot, 'global' | 'nodes'>[] = [];
  if (fixAtMs === 0) applyFix();
  for (let now = TICK_MS; now <= RUN_MS; now += TICK_MS) {
    [end] = simulator.step();
    if (now >= 10_000) history.push({ global: end.global, nodes: end.nodes });
    if (now >= 10_000 && !healthy(scenario, end)) lateBreaches++;
    peakQueueDepth = Math.max(peakQueueDepth, end.global.queueDepth);
    if (now === fixAtMs) {
      beforeFix = end;
      applyFix();
    }
  }
  return { end, beforeFix, lateBreaches, peakQueueDepth, history };
}

function expectRecovered(scenario: Sev1Scenario, end: TickSnapshot): void {
  expect(end.nowMs).toBe(RUN_MS);
  expect(end.global.p99, JSON.stringify(end.global)).toBeLessThanOrEqual(scenario.slaTargets.p99LatencyMs);
  expect(end.global.errorRate * 100).toBeLessThanOrEqual(scenario.slaTargets.maxErrorRatePct);
  expect(end.sla?.healthyDurationMs).toBeGreaterThanOrEqual(scenario.slaTargets.holdDurationMs);
  expect(end.sla?.remainingPercent).toBeGreaterThan(0);
  expect(end.activeFaults.map((fault) => fault.id)).toEqual(
    scenario.initialFaults.filter((fault) => fault.startMs + fault.durationMs > RUN_MS).map((fault) => fault.id),
  );
}

describe.each(incidents)('$name', (scenario) => {
  it('defines a connected, forward-only topology laid out for the canvas', () => {
    checkTopology(scenario.topology);
    const nodeIds = new Set(scenario.topology.nodes.map((node) => node.id));
    expect(scenario.initialFaults.length).toBeGreaterThan(0);
    expect(Object.keys(scenario.canonicalFix).length).toBeGreaterThan(0);
    expect(scenario.initialFaults.every((fault) => nodeIds.has(fault.nodeId))).toBe(true);
    expect(Object.keys(scenario.canonicalFix).every((id) => nodeIds.has(id))).toBe(true);
    expect(scenario.canonicalFixHints).toHaveLength(2);
  });

  it.each([73, 2026])('continues breaching SLA unfixed after warm-up with seed %i', (seed) => {
    const unfixed = run(scenario, seed);
    const { end, history } = unfixed;
    switch (scenario.id) {
      case 'tatkal': {
        const db = history.map((tick) => tick.nodes['train-db']);
        expect(Math.max(...db.map((tick) => tick.rps))).toBeGreaterThan(2 * Math.min(...db.map((tick) => tick.rps)));
        expect(db.some((tick) => tick.queueDepth > 0)).toBe(true);
        expect(Math.max(...history.map((tick) => tick.global.p99))).toBeGreaterThan(scenario.slaTargets.p99LatencyMs);
        expect(Math.max(...history.map((tick) => tick.global.errorRate * 100))).toBeGreaterThan(scenario.slaTargets.maxErrorRatePct);
        break;
      }
      case 'upi-retry-storm':
        expect(end.nodes['bank-b'].rps).toBeGreaterThan(2 * end.nodes['bank-a'].rps);
        expect(end.nodes.switch.queueDepth).toBeGreaterThan(50);
        break;
      case 'diwali-pool-exhaustion':
        expect(end.nodes['primary-db'].activeWorkers).toBe(36);
        expect(end.nodes.checkout.queueDepth).toBeGreaterThan(100);
        expect(end.recentTraces.some((trace) => trace.dropReason === 'QUEUE_OVERFLOW')).toBe(true);
        break;
      case 'hot-shard': {
        const db = end.nodes['merchant-db'];
        expect(db.perShardLoad[0]).toBeGreaterThan(0.9 * db.rps);
        expect(db.activeWorkers).toBeLessThan(60 / 2);
        expect(db.queueDepth).toBeGreaterThan(0);
        break;
      }
      case 'queue-backpressure':
        expect(end.nodes.jobs.queueDepth).toBe(450);
        expect(end.nodes.fulfillment.rps).toBeLessThan(end.nodes.jobs.rps / 2);
        expect(end.recentTraces.some((trace) => trace.dropReason === 'QUEUE_OVERFLOW')).toBe(true);
        break;
    }
    expect(unfixed.lateBreaches).toBeGreaterThanOrEqual(5);
    expect(unfixed.end.sla?.remainingPercent).toBeLessThan(100);
    expect(unfixed.peakQueueDepth).toBeGreaterThan(0);
  }, 15_000);

  it('holds SLA with the canonical fix applied before traffic starts', () => {
    expectRecovered(scenario, run(scenario, 2026, 0).end);
  }, 15_000);

  it.each([73, 2026])('recovers from a live outage after 5s with seed %i', (seed) => {
    const { end, beforeFix } = run(scenario, seed, FIX_AT_MS);
    expect(beforeFix?.nowMs).toBe(FIX_AT_MS);
    expect(beforeFix?.sla?.remainingPercent).toBeLessThan(100);
    expectRecovered(scenario, end);
    switch (scenario.id) {
      case 'tatkal':
        expect(end.nodes['train-db'].rps).toBeLessThan(45);
        break;
      case 'upi-retry-storm':
        expect(end.nodes['bank-b'].rps).toBeLessThan(10);
        expect(end.circuits['switch->bank-a']).toBe('closed');
        expect(end.nodes['bank-a'].rps).toBeGreaterThan(1_280);
        break;
      case 'diwali-pool-exhaustion':
        expect(end.nodes['inventory-cache'].cacheHitRate).toBeGreaterThan(0.9);
        expect(end.nodes.checkout.queueDepth + end.nodes['primary-db'].queueDepth).toBe(0);
        break;
      case 'hot-shard':
        expect(end.nodes['merchant-db'].rps).toBeLessThan(60);
        expect(end.recentTraces.some((trace) => trace.dropReason === 'RATE_LIMITED')).toBe(true);
        break;
      case 'queue-backpressure':
        expect(end.nodes.jobs.queueDepth).toBe(0);
        expect(end.nodes.fulfillment.rps).toBeCloseTo(end.nodes.jobs.rps, -1);
        break;
    }
  }, 15_000);
});

describe('Free-Build Sandbox', () => {
  it('starts from a connected, forward-only topology laid out for the canvas', () => {
    checkTopology(sandbox);
  });

  it('warms the cache and serves stable traffic against two shards without incident faults', () => {
    const sim = createSimulator(sandbox, { seed: 73 });
    let end = sim.getSnapshot();
    for (let now = TICK_MS; now <= RUN_MS; now += TICK_MS) [end] = sim.step();

    expect(end.global.rps).toBeCloseTo(600, -1);
    expect(end.global.errorRate).toBe(0);
    expect(end.nodes.redis.cacheHitRate).toBeGreaterThan(0.85);
    expect(end.nodes.db.perShardLoad).toHaveLength(2);
    expect(end.nodes.db.perShardLoad.every((load) => load > 0)).toBe(true);
    expect(end.activeFaults).toHaveLength(0);
    expect(end.sla).toBeNull();
  });
});
