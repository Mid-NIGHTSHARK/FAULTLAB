import { describe, expect, it } from 'vitest';
import { createSimulator, type NodeConfigPatch, type SimulatorOptions } from '../src/engine/simulator';
import type { FaultEvent, IncidentScenario, NodeConfig, NodeType, Topology } from '../src/engine/types';

function node(id: string, type: NodeType, patch: NodeConfigPatch = {}): NodeConfig {
  return {
    id, name: id, type, workerPoolCapacity: 1_000, maxQueueSize: 100, baseLatencyMs: 0,
    timeoutMs: 10_000, serviceTimeSigma: 0, saturationPenalty: 0, ...patch,
    retryPolicy: { strategy: 'none', retryBudget: 0, delayMs: 0, ...patch.retryPolicy },
    circuitBreaker: { failureThreshold: 100_000, resetTimeoutMs: 100, halfOpenMaxRequests: 1, ...patch.circuitBreaker },
    cache: { ttlMs: 500, ttlJitterPercent: 0, singleflight: false, ...patch.cache },
    rateLimiter: { rps: 100_000, burst: 100_000, ...patch.rateLimiter },
    sharding: { shardCount: 1, zipfSkew: 0, ...patch.sharding },
  };
}

function graph(nodes: NodeConfig[], pairs: [string, string][] = nodes.slice(1).map((target, index) =>
  [nodes[index].id, target.id])): Topology {
  return {
    id: 'test', name: 'Test graph', nodes,
    edges: pairs.map(([sourceNodeId, targetNodeId]) => ({
      id: `${sourceNodeId}->${targetNodeId}`, sourceNodeId, targetNodeId,
    })),
  };
}

function source(rps: number, patch: NodeConfigPatch = {}): NodeConfig {
  return node('in', 'traffic', { trafficRps: rps, ...patch });
}

function sim(nodes: NodeConfig[], options: Partial<SimulatorOptions> = {}) {
  return createSimulator(graph(nodes), { seed: 73, ...options });
}

function fault(kind: string, nodeId: string, parameters: FaultEvent['parameters'] = {},
  startMs = 0, durationMs = 10_000): FaultEvent {
  return { id: kind, kind, nodeId, startMs, durationMs, parameters };
}

describe('event clock and configuration', () => {
  it('produces bit-identical snapshots including sampled traversal events for matching seeds', () => {
    const nodes = [
      source(3_000),
      node('db', 'database', { baseLatencyMs: 3, serviceTimeSigma: 0.35, sharding: { shardCount: 4, zipfSkew: 1 } }),
    ];
    const a = sim(nodes);
    const b = sim(nodes);
    expect(JSON.stringify(a.step(600))).toBe(JSON.stringify(b.step(600)));
    a.reset(73);
    expect(sim(nodes, { seed: 74 }).step(100)).not.toEqual(a.step(100));
  });

  it('preserves fixed tick boundaries across fragmented calls', () => {
    const nodes = [source(100), node('svc', 'service', { baseLatencyMs: 7.5 })];
    const a = sim(nodes);
    const b = sim(nodes);
    expect(a.step(42)).toEqual([]);
    expect(a.getSnapshot().nowMs).toBe(42);
    expect([...a.step(110), ...a.step(148)]).toEqual(b.step(300));
  });

  it('emits one snapshot per default step with a fractional tick size', () => {
    const s = sim([source(100)], { tickMs: 0.1 });
    for (let tick = 1; tick <= 20; tick++) {
      expect(s.step().map((snapshot) => snapshot.nowMs)).toEqual([tick * 0.1]);
    }
  });

  it('records fractional sub-tick work at its exact end time', () => {
    const s = sim([source(100), node('svc', 'service', { baseLatencyMs: 7.5 })]);
    s.step(17);
    expect(s.getSnapshot().recentTraces).toHaveLength(0);
    s.step(0.5);
    const [trace] = s.getSnapshot().recentTraces;
    expect(trace.durationMs).toBe(7.5);
    expect(trace.spans[1]).toMatchObject({ startMs: 10, serviceMs: 7.5, queueWaitMs: 0 });
  });

  it('hot-updates configuration while preserving requests already in service', () => {
    const s = sim([source(100), node('svc', 'service', { baseLatencyMs: 40 })]);
    s.step(11);
    s.updateNodeConfig('svc', { baseLatencyMs: 2, rateLimiter: { burst: 8 } });
    s.step(39);
    const byId = Object.fromEntries(s.getSnapshot().recentTraces.map((trace) => [trace.requestId, trace]));
    expect(byId['1'].durationMs).toBe(40);
    expect(byId['2'].durationMs).toBe(2);
  });

  it('resets time, seed, config, metrics, traces, and injected faults', () => {
    const nodes = [source(100), node('svc', 'service', { baseLatencyMs: 3, serviceTimeSigma: 0.2 })];
    const s = sim(nodes);
    s.step(200);
    s.updateNodeConfig('svc', { baseLatencyMs: 80 });
    s.injectFault(fault('node_crash', 'svc', {}, 200));
    s.reset(9);
    expect(s.getSnapshot()).toEqual(sim(nodes, { seed: 9 }).getSnapshot());
    expect(s.step(200)).toEqual(sim(nodes, { seed: 9 }).step(200));
  });

  it('rejects cycles and leaves configuration intact on an invalid update', () => {
    const nodes = [source(100), node('svc', 'service')];
    expect(() => createSimulator(graph(nodes, [['in', 'svc'], ['svc', 'in']]), { seed: 1 })).toThrow(/acyclic/);
    const s = sim(nodes);
    expect(() => s.updateNodeConfig('svc', { workerPoolCapacity: -1 })).toThrow(RangeError);
    expect(s.step(100)).toEqual(sim(nodes).step(100));
  });

  it('handles parallel fan-out and records each child with the caller as parent', () => {
    const s = createSimulator(graph([
      source(100), node('a', 'service', { baseLatencyMs: 5 }), node('b', 'external', { baseLatencyMs: 7 }),
    ], [['in', 'a'], ['in', 'b']]), { seed: 5 });
    s.step(17);
    const [trace] = s.getSnapshot().recentTraces;
    expect(trace.durationMs).toBe(7);
    expect(trace.spans.slice(1).map((span) => span.parentSpanId)).toEqual([trace.spans[0].id, trace.spans[0].id]);
  });

  it('applies scenario faults and advances the error budget once per tick', () => {
    const nodes = [source(100), node('svc', 'service')];
    const scenario: IncidentScenario = {
      id: 'incident', name: 'Incident', brief: '', topology: graph(nodes),
      slaTargets: { availability: 0.99, p95LatencyMs: 100 }, errorBudget: 0.2,
      initialFaults: [fault('node_crash', 'svc', {}, 0, 100)], canonicalFixHints: [],
    };
    const s = sim(nodes, { scenario, metricsWindowMs: 100, slaBudgetPeriodMs: 500 });
    expect(s.getSnapshot().activeFaults).toHaveLength(1);
    const [first, second] = s.step(200);
    expect(first.sla).toEqual({ remainingPercent: 0, healthyDurationMs: 0 });
    expect(second.sla).toEqual({ remainingPercent: 0, healthyDurationMs: 100 });
    expect(s.step(400).at(-1)?.sla?.remainingPercent).toBe(100);
  });
});

describe('pools, queues and deadlines', () => {
  it('raises steady p95, p99 and average queue depth as load approaches one-worker capacity', () => {
    function steady(rps: number) {
      const s = sim([source(rps), node('svc', 'service', {
        workerPoolCapacity: 1, baseLatencyMs: 10, serviceTimeSigma: 0.5,
      })]);
      const ticks = s.step(12_000).slice(30);
      return ['p95', 'p99', 'queueDepth'].map((key) => ticks.reduce((sum, tick) =>
        sum + tick.nodes.svc[key as 'p95' | 'p99' | 'queueDepth'], 0) / ticks.length);
    }
    const low = steady(30);
    const medium = steady(60);
    const high = steady(85);
    for (let i = 0; i < low.length; i++) {
      expect(medium[i]).toBeGreaterThan(low[i]);
      expect(high[i]).toBeGreaterThan(medium[i]);
    }
  });

  it('keeps FIFO order, caps the queue and reports 503 overflow', () => {
    const s = sim([source(100), node('svc', 'service', {
      workerPoolCapacity: 1, maxQueueSize: 1, baseLatencyMs: 45,
    })]);
    s.step(35);
    const snapshot = s.getSnapshot();
    expect(snapshot.nodes.svc).toMatchObject({ activeWorkers: 1, queueDepth: 1 });
    expect(snapshot.recentTraces[0]).toMatchObject({ requestId: '3', statusCode: 503, dropReason: 'QUEUE_OVERFLOW' });
    s.step(65);
    const second = s.getSnapshot().recentTraces.find((trace) => trace.requestId === '2');
    expect(second?.spans[1]).toMatchObject({ queueWaitMs: 35, serviceMs: 45, statusCode: 200 });
  });

  it('times out callers at 504 while running work keeps the pool slot', () => {
    const s = sim([source(100), node('svc', 'service', {
      workerPoolCapacity: 1, maxQueueSize: 0, baseLatencyMs: 40, timeoutMs: 6,
    })]);
    s.step(21);
    expect(s.getSnapshot().nodes.svc.activeWorkers).toBe(1);
    const [overflow, first] = s.getSnapshot().recentTraces;
    expect(first).toMatchObject({ durationMs: 6, statusCode: 504, dropReason: 'TIMEOUT' });
    expect(first.spans[1].serviceMs).toBe(6);
    expect(overflow.dropReason).toBe('QUEUE_OVERFLOW');
    s.updateNodeConfig('in', { trafficRps: 0 });
    s.step(29);
    expect(s.getSnapshot().nodes.svc.activeWorkers).toBe(0);
  });

  it('preserves downstream work and its full span after an upstream timeout', () => {
    const s = sim([source(100, { timeoutMs: 5 }), node('db', 'database', { baseLatencyMs: 30 })]);
    s.step(11);
    s.updateNodeConfig('in', { trafficRps: 0 });
    s.step(4);
    expect(s.getSnapshot().global.errorRate).toBe(1);
    expect(s.getSnapshot().nodes.db.activeWorkers).toBe(1);
    expect(s.getSnapshot().recentTraces).toHaveLength(0);
    s.step(25);
    const [trace] = s.getSnapshot().recentTraces;
    expect(trace).toMatchObject({ statusCode: 504, durationMs: 5 });
    expect(trace.spans[1]).toMatchObject({ statusCode: 200, serviceMs: 30 });
  });

  it('removes a timed-out queued request before it takes a worker', () => {
    const s = sim([source(100), node('svc', 'service', {
      workerPoolCapacity: 1, maxQueueSize: 2, baseLatencyMs: 40, timeoutMs: 5,
    })]);
    s.step(26);
    expect(s.getSnapshot().nodes.svc).toMatchObject({ activeWorkers: 1, queueDepth: 0 });
    expect(s.getSnapshot().recentTraces[0].spans[1]).toMatchObject({ queueWaitMs: 5, serviceMs: 0, statusCode: 504 });
  });

  it('acknowledges async jobs before draining them and rejects overflow while stalled', () => {
    const s = sim([source(100), node('jobs', 'queue', { workerPoolCapacity: 0, maxQueueSize: 2, baseLatencyMs: 4 })]);
    s.step(35);
    expect(s.getSnapshot().nodes.jobs.queueDepth).toBe(2);
    expect(s.getSnapshot().global.errorRate).toBe(1 / 3);
    expect(s.getSnapshot().recentTraces[0].dropReason).toBe('QUEUE_OVERFLOW');
    s.updateNodeConfig('in', { trafficRps: 0 });
    s.updateNodeConfig('jobs', { workerPoolCapacity: 1 });
    s.step(10);
    const finished = s.getSnapshot();
    expect(finished.nodes.jobs).toMatchObject({ activeWorkers: 0, queueDepth: 0 });
    expect(finished.recentTraces.find((trace) => trace.requestId === '1')).toMatchObject({
      durationMs: 0, statusCode: 202, spans: [expect.anything(), expect.objectContaining({ queueWaitMs: 25, serviceMs: 4 })],
    });
  });

  it('scales seeded service time with the saturation of each pool', () => {
    const load = (rps: number) => sim([
      source(rps), node('svc', 'service', { workerPoolCapacity: 2, baseLatencyMs: 8, saturationPenalty: 1 }),
    ]).step(300).at(-1)!.nodes.svc;
    expect(load(150).p95).toBeGreaterThan(load(30).p95);
  });
});

describe('rate limiting, retries and breakers', () => {
  it('caps a burst and sustains the configured refill rate with fast 429 drops', () => {
    const s = sim([source(200, { rateLimiter: { rps: 20, burst: 3 } }), node('svc', 'service', { baseLatencyMs: 2 })]);
    s.step(20);
    const initial = s.getSnapshot().recentTraces;
    expect(initial.filter((trace) => trace.status === 'ok')).toHaveLength(3);
    expect(initial[0]).toMatchObject({ statusCode: 429, dropReason: 'RATE_LIMITED', durationMs: 0 });
    const stable = s.step(2_080).at(-1)!;
    expect(stable.nodes.svc.rps).toBe(20);
    expect(stable.global.errorRate).toBeCloseTo(0.9, 2);
    expect(stable.recentTraces.filter((trace) => trace.status === 'ok').every((trace) => trace.durationMs === 2)).toBe(true);
  });

  it('amplifies partial downstream errors by over 2× with immediate fixed retries', () => {
    function run(retryPolicy: NodeConfigPatch['retryPolicy']) {
      const s = sim([source(500, { retryPolicy }), node('svc', 'service', { baseLatencyMs: 1 })]);
      s.injectFault(fault('latency_error', 'svc', { errorRate: 0.8 }));
      return s.step(2_000).at(-1)!;
    }
    const plain = run({ strategy: 'none' });
    const fixed = run({ strategy: 'fixed', retryBudget: 3 });
    expect(fixed.nodes.svc.rps).toBeGreaterThan(2 * plain.nodes.svc.rps);
    const retried = fixed.recentTraces.find((trace) => trace.spans.length >= 4)!;
    expect(retried.spans[2]).toMatchObject({ retryAttempt: 1, parentSpanId: retried.spans[1].id });
    expect(retried.spans[3]).toMatchObject({ retryAttempt: 2, parentSpanId: retried.spans[2].id });
  });

  it('waits the configured constant delay between fixed retry attempts', () => {
    const s = sim([source(10, { retryPolicy: { strategy: 'fixed', retryBudget: 2, delayMs: 7 } }),
      node('svc', 'service', { baseLatencyMs: 2 })]);
    s.injectFault(fault('latency_error', 'svc', { errorRate: 1 }));
    s.step(120);
    const attempts = s.getSnapshot().recentTraces[0].spans.slice(1);
    expect(attempts.map((span) => span.startMs)).toEqual([100, 109, 118]);
  });

  it('uses exponential full-jitter bounds and never exceeds the retry budget', () => {
    const s = sim([source(10, { retryPolicy: { strategy: 'exponential_jitter', delayMs: 8, retryBudget: 3 } }),
      node('svc', 'service', { baseLatencyMs: 1 })]);
    s.injectFault(fault('latency_error', 'svc', { errorRate: 1 }));
    s.step(180);
    const attempts = s.getSnapshot().recentTraces[0].spans.slice(1);
    expect(attempts).toHaveLength(4);
    for (let i = 1; i < attempts.length; i++) {
      const delay = attempts[i].startMs - attempts[i - 1].startMs - 1;
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThan(8 * 2 ** (i - 1));
    }
  });

  it('bounds downstream load and improves availability under retry-driven pool overload', () => {
    function run(protectedEdge: boolean) {
      const s = sim([source(160, {
        retryPolicy: { strategy: protectedEdge ? 'exponential_jitter' : 'fixed', retryBudget: 5, delayMs: protectedEdge ? 9 : 0 },
        circuitBreaker: protectedEdge ? { minSamples: 12, errorThresholdPct: 55, openDurationMs: 35, windowMs: 150 } : {},
      }), node('svc', 'service', { workerPoolCapacity: 1, maxQueueSize: 8, baseLatencyMs: 4, timeoutMs: 18 })]);
      for (let start = 100; start < 4_000; start += 500) {
        s.injectFault({ ...fault('latency_error', 'svc', { latencyMs: 16, errorRate: 0.6 }, start, 110), id: `slow-${start}` });
      }
      const ticks = s.step(4_000).slice(10);
      return {
        rps: ticks.reduce((total, tick) => total + tick.nodes.svc.rps, 0) / ticks.length,
        errorRate: ticks.reduce((total, tick) => total + tick.global.errorRate, 0) / ticks.length,
      };
    }
    const fixed = run(false);
    const bounded = run(true);
    expect(bounded.rps).toBeLessThan(fixed.rps * 0.75);
    expect(bounded.errorRate).toBeLessThan(fixed.errorRate);
  });

  it('opens on its error threshold, skips downstream, and closes on healthy probes', () => {
    const s = sim([source(100, { circuitBreaker: {
      minSamples: 2, errorThresholdPct: 100, openDurationMs: 35, halfOpenMaxRequests: 2,
    } }), node('svc', 'service', { baseLatencyMs: 2 })]);
    s.injectFault(fault('latency_error', 'svc', { errorRate: 1 }));
    const edge = 'in->svc';
    s.step(21);
    expect(s.getSnapshot().circuits[edge]).toBe('closed');
    s.step(1);
    expect(s.getSnapshot().circuits[edge]).toBe('open');
    s.step(33);
    expect(s.getSnapshot().nodes.svc.rps).toBe(2);
    expect(s.getSnapshot().recentTraces[0]).toMatchObject({ durationMs: 0, statusCode: 503, dropReason: 'CIRCUIT_OPEN' });
    s.clearFault('latency_error');
    s.step(2);
    expect(s.getSnapshot().circuits[edge]).toBe('half_open');
    s.step(15);
    expect(s.getSnapshot().circuits[edge]).toBe('closed');
  });

  it('reopens on failed half-open probes', () => {
    const s = sim([source(100, { circuitBreaker: { minSamples: 1, openDurationMs: 25 } }),
      node('svc', 'service', { baseLatencyMs: 2 })]);
    s.injectFault(fault('node_crash', 'svc'));
    s.step(35);
    expect(s.getSnapshot().circuits['in->svc']).toBe('half_open');
    s.step(5);
    expect(s.getSnapshot().circuits['in->svc']).toBe('open');
  });

  it('isolates breaker state and admission by downstream edge', () => {
    const s = createSimulator(graph([
      source(100, { circuitBreaker: { minSamples: 1 } }),
      node('bad', 'service'), node('healthy', 'service'),
    ], [['in', 'bad'], ['in', 'healthy']]), { seed: 73 });
    s.injectFault(fault('node_crash', 'bad'));
    s.step(50);
    const snapshot = s.getSnapshot();
    expect(snapshot.circuits).toEqual({ 'in->bad': 'open', 'in->healthy': 'closed' });
    expect(snapshot.nodes.bad.rps).toBe(1);
    expect(snapshot.nodes.healthy.rps).toBe(5);
  });

  it('ages out failures before applying the sliding error threshold', () => {
    const s = sim([source(50, { circuitBreaker: { minSamples: 2, errorThresholdPct: 50, windowMs: 25 } }),
      node('svc', 'service')]);
    s.injectFault(fault('node_crash', 'svc'));
    s.step(20);
    s.clearFault('node_crash');
    s.updateNodeConfig('in', { trafficRps: 20 });
    s.step(50);
    expect(s.getSnapshot().circuits['in->svc']).toBe('closed');
    expect(s.getSnapshot().nodes.svc.errorRate).toBe(0.5);
  });
});

describe('cache, shards and live faults', () => {
  it('collapses concurrent same-key misses after synchronized expiry to one backend arrival', () => {
    function run(singleflight: boolean) {
      const s = sim([source(20), node('cache', 'cache', {
        workerPoolCapacity: 1, cache: { keyCount: 1, ttlMs: 150, singleflight },
      }), node('db', 'database', { baseLatencyMs: 30 })], { metricsWindowMs: 100 });
      s.step(130);
      expect(s.getSnapshot().nodes.cache.cacheHitRate).toBe(0.5);
      s.updateNodeConfig('in', { trafficRps: 1_000 });
      s.step(100);
      expect(s.getSnapshot().nodes.db.rps).toBe(0);
      s.step(30);
      return s.getSnapshot();
    }
    const herd = run(false);
    const coalesced = run(true);
    expect(herd.nodes.db.rps).toBe(300);
    expect(coalesced.nodes.db.rps).toBe(10);
    expect(coalesced.nodes.cache.activeWorkers).toBe(0);
  });

  it('cache flush forces a live burst of misses, and clearing allows the cache to warm again', () => {
    const s = sim([source(1_000), node('cache', 'cache', {
      cache: { keyCount: 1, ttlMs: 2_000, ttlJitterPercent: 15 },
    }), node('db', 'database', { baseLatencyMs: 20 })], { metricsWindowMs: 100 });
    s.step(200);
    expect(s.getSnapshot().global.cacheHitRate).toBe(1);
    s.injectFault(fault('cache_flush', 'cache', {}, 200));
    s.step(19);
    expect(s.getSnapshot().nodes.db.rps).toBe(190);
    s.clearFault('cache_flush');
    expect(s.getSnapshot().activeFaults).toEqual([]);
    s.step(181);
    expect(s.getSnapshot().global.cacheHitRate).toBe(1);
  });

  it('suppresses TTL jitter while a synchronized-expiry fault is active', () => {
    function secondFetch(synchronized: boolean) {
      const s = sim([source(1_000), node('cache', 'cache', {
        cache: { keyCount: 1, ttlMs: 100, ttlJitterPercent: 50 },
      }), node('db', 'database')]);
      if (synchronized) s.injectFault(fault('cache_flush', 'cache'));
      return s.step(160).concat(s.step(40)).flatMap((tick) =>
        tick.edgeTraversals.filter((event) => event.edgeId === 'cache->db').map((event) => event.atMs));
    }
    expect(secondFetch(true)).toEqual([1, 101]);
    expect(secondFetch(false)[1]).not.toBe(101);
  });

  it('saturates a hot shard and raises tail latency while mean cluster utilization stays low', () => {
    const s = sim([source(95), node('db', 'database', {
      sharding: { shardCount: 16 }, workerPoolCapacity: 1, baseLatencyMs: 10, serviceTimeSigma: 0.45,
    })]);
    const baseline = s.step(5_000).at(-1)!.nodes.db;
    s.injectFault(fault('hot_key_skew', 'db', { skew: 4 }, 5_000));
    const skewed = s.step(5_000).at(-1)!.nodes.db;
    expect(skewed.perShardLoad[0]).toBeGreaterThan(80);
    expect(skewed.perShardLoad[0]).toBeGreaterThan(baseline.perShardLoad[0] * 5);
    expect(skewed.activeWorkers / 16).toBeLessThan(0.25);
    expect(skewed.p99).toBeGreaterThan(baseline.p99 * 2);
    s.clearFault('hot_key_skew');
    expect(s.step(3_000).at(-1)!.nodes.db.perShardLoad[0]).toBeLessThan(16);
  });

  it('changes shard count without killing work already assigned to a removed shard', () => {
    const s = sim([source(100), node('db', 'database', {
      sharding: { shardCount: 8 }, baseLatencyMs: 50,
    })]);
    s.step(41);
    const active = s.getSnapshot().nodes.db.activeWorkers;
    s.updateNodeConfig('db', { sharding: { shardCount: 1 } });
    expect(s.getSnapshot().nodes.db.activeWorkers).toBe(active);
    s.step(100);
    expect(s.getSnapshot().nodes.db.perShardLoad).toHaveLength(1);
    expect(s.getSnapshot().recentTraces.find((trace) => trace.requestId === '1')?.durationMs).toBe(50);
  });

  it('schedules a traffic spike and restores ingress on clear and natural expiry', () => {
    const s = sim([source(100), node('svc', 'service')], { metricsWindowMs: 100 });
    s.injectFault(fault('traffic_spike', 'in', { multiplier: 3 }, 200, 500));
    expect(s.step(100).at(-1)!.global.rps).toBe(100);
    expect(s.step(200).at(-1)!.global.rps).toBeCloseTo(300, -1);
    s.clearFault('traffic_spike');
    expect(s.step(200).at(-1)!.global.rps).toBe(100);
    s.injectFault(fault('traffic_spike', 'in', { multiplier: 2 }, 500, 200));
    expect(s.step(100).at(-1)!.global.rps).toBe(200);
    expect(s.step(300).at(-1)!.global.rps).toBe(100);
    expect(s.getSnapshot().activeFaults).toEqual([]);
  });

  it('cancels scheduled faults and excludes arrivals at the exact expiry boundary', () => {
    const s = sim([source(100), node('svc', 'service')]);
    s.injectFault(fault('node_crash', 'svc', {}, 10, 10));
    s.step(20);
    expect(s.getSnapshot().recentTraces.map((trace) => trace.statusCode)).toEqual([200, 503]);
    s.injectFault(fault('node_crash', 'svc', {}, 30, 100));
    s.clearFault('node_crash');
    s.step(10);
    expect(s.getSnapshot().recentTraces[0].statusCode).toBe(200);
  });

  it('adds injected latency and errors until the fault is cleared', () => {
    const s = sim([source(100), node('svc', 'service', { baseLatencyMs: 2 })], { metricsWindowMs: 100 });
    s.step(200);
    expect(s.getSnapshot().global.p95).toBe(2);
    s.injectFault(fault('latency_error', 'svc', { latencyMs: 20, errorRate: 1 }, 200));
    s.step(200);
    expect(s.getSnapshot().global).toMatchObject({ p95: 22, errorRate: 1 });
    s.clearFault('latency_error');
    s.step(200);
    expect(s.getSnapshot().global).toMatchObject({ p95: 2, errorRate: 0 });
  });

  it('crashes live in-flight work, rejects arrivals and recovers after clearing', () => {
    const s = sim([source(100), node('svc', 'service', { baseLatencyMs: 20 })], { metricsWindowMs: 100 });
    s.step(15);
    s.injectFault(fault('node_crash', 'svc', {}, 15));
    s.step(18);
    const failed = s.getSnapshot().recentTraces;
    expect(failed.find((trace) => trace.requestId === '1')).toMatchObject({ durationMs: 20, dropReason: 'NODE_UNAVAILABLE' });
    expect(failed.find((trace) => trace.requestId === '2')).toMatchObject({ durationMs: 0, dropReason: 'NODE_UNAVAILABLE' });
    s.clearFault('node_crash');
    s.step(200);
    expect(s.getSnapshot().global).toMatchObject({ errorRate: 0, p95: 20 });
  });

  it('keeps traces and sampled edge traversals bounded across 50 high-load ticks', () => {
    const s = sim([source(10_000), node('svc', 'service', { baseLatencyMs: 1 }),
      node('db', 'database', { baseLatencyMs: 2, serviceTimeSigma: 0.2, sharding: { shardCount: 8 } })]);
    const start = performance.now();
    let snapshot = s.getSnapshot();
    let maxVisuals = 0;
    for (let tick = 0; tick < 50; tick++) {
      [snapshot] = s.step();
      maxVisuals = Math.max(maxVisuals, snapshot.edgeTraversals.length);
    }
    const averageTickMs = (performance.now() - start) / 50;
    expect(snapshot.global.rps).toBeCloseTo(10_000, -1);
    expect(snapshot.global.errorRate).toBe(0);
    expect(snapshot.recentTraces).toHaveLength(200);
    expect(maxVisuals).toBe(128);
    expect(averageTickMs).toBeLessThan(12);
  });
});
