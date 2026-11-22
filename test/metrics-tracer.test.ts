import { describe, expect, it } from 'vitest';
import { RollingMetrics, SlaBudgetTracker } from '../src/engine/metrics';
import { TraceRecorder } from '../src/engine/tracer';
import type { RequestTrace } from '../src/engine/types';

describe('rolling metrics', () => {
  it('calculates exact nearest-rank percentiles and aggregates request outcomes', () => {
    const metrics = new RollingMetrics(1_000, 3);
    for (let index = 0; index < 100; index++) {
      metrics.record({
        completedAtMs: index * 10,
        latencyMs: 100 - index,
        failed: index % 10 === 0,
        cacheOutcome: index < 10 ? 'hit' : index < 25 ? 'miss' : undefined,
        shardIndex: index % 2,
      });
    }

    expect(metrics.snapshot(990, { queueDepth: 7, activeWorkers: 3, circuitState: 'half_open' })).toEqual({
      p50: 50, p95: 95, p99: 99, rps: 100, errorRate: 0.1, cacheHitRate: 0.4,
      queueDepth: 7, activeWorkers: 3, circuitState: 'half_open', perShardLoad: [50, 50, 0],
    });
  });

  it('expires samples at the left boundary and clears all derived values when idle', () => {
    const metrics = new RollingMetrics(100, 2);
    metrics.record({ completedAtMs: 10, latencyMs: 25, failed: true, cacheOutcome: 'hit', shardIndex: 1 });
    metrics.record({ completedAtMs: 20, latencyMs: 10, failed: false, cacheOutcome: 'miss', shardIndex: 0 });
    expect(metrics.snapshot(109)).toMatchObject({ rps: 20, p50: 10, p95: 25, errorRate: 0.5 });
    expect(metrics.snapshot(110)).toMatchObject({
      rps: 10, p50: 10, p95: 10, p99: 10, errorRate: 0, cacheHitRate: 0, perShardLoad: [1, 0],
    });
    expect(metrics.snapshot(120)).toEqual({
      rps: 0, p50: 0, p95: 0, p99: 0, errorRate: 0, cacheHitRate: 0,
      queueDepth: 0, activeWorkers: 0, circuitState: 'closed', perShardLoad: [0, 0],
    });
    expect(() => metrics.snapshot(119)).toThrow(RangeError);
  });
});

describe('metric edge cases', () => {
  it('keeps idle and fully failed windows finite, including tiny durations', () => {
    const metrics = new RollingMetrics(Number.MIN_VALUE);
    expect(Object.values(metrics.snapshot(0)).filter(value => typeof value === 'number').every(Number.isFinite)).toBe(true);
    metrics.record({completedAtMs: 0, latencyMs: 0, failed:true, cacheOutcome:'miss'});
    const result = metrics.snapshot(0);
    expect(result.errorRate).toBe(1);
    expect(result.cacheHitRate).toBe(0);
    expect(Number.isFinite(result.rps)).toBe(true);
  });
});

describe('SLA error budget', () => {
  const scenario = { slaTargets: { availability: 0.95, p95LatencyMs: 100 }, errorBudget: 0.2 };
  const healthy = { errorRate: 0.05, p95: 100 };
  const highErrors = { errorRate: 0.06, p95: 100 };
  const slow = { errorRate: 0.01, p95: 101 };

  it('burns on either breach and recovers as each breach ages out', () => {
    const tracker = new SlaBudgetTracker(scenario, 1_000);
    expect(tracker.advance(50, healthy)).toEqual({ remainingPercent: 100, healthyDurationMs: 50 });
    expect(tracker.advance(50, highErrors)).toEqual({ remainingPercent: 75, healthyDurationMs: 0 });
    expect(tracker.advance(50, slow)).toEqual({ remainingPercent: 50, healthyDurationMs: 0 });
    expect(tracker.advance(925, healthy)).toEqual({ remainingPercent: 62.5, healthyDurationMs: 925 });
    expect(tracker.advance(75, healthy)).toEqual({ remainingPercent: 100, healthyDurationMs: 1_000 });
  });

  it('clamps an exhausted budget and resets the healthy streak on a new breach', () => {
    const tracker = new SlaBudgetTracker(scenario, 1_000);
    expect(tracker.advance(2_000, slow).remainingPercent).toBe(0);
    expect(tracker.advance(1_000, healthy)).toEqual({ remainingPercent: 100, healthyDurationMs: 1_000 });
    expect(tracker.advance(100, { errorRate: 1, p95: 200 })).toEqual({
      remainingPercent: 50, healthyDurationMs: 0,
    });
  });

  it('burns budget on a p99 breach or an explicit error-rate breach independently', () => {
    const tracker = new SlaBudgetTracker({
      errorBudget: 0.2, slaTargets: { availability: 0.9, p99LatencyMs: 80, maxErrorRatePct: 2 },
    }, 1_000);
    expect(() => tracker.advance(50, { errorRate: 0, p95: 10 })).toThrow(RangeError);
    expect(tracker.advance(50, { errorRate: 0, p95: 10, p99: 81 })).toEqual({
      remainingPercent: 75, healthyDurationMs: 0,
    });
    expect(tracker.advance(50, { errorRate: 0.03, p95: 10, p99: 80 })).toEqual({
      remainingPercent: 50, healthyDurationMs: 0,
    });
    expect(tracker.advance(50, { errorRate: 0.02, p95: 10, p99: 80 })).toEqual({
      remainingPercent: 50, healthyDurationMs: 50,
    });
  });

  it('handles a zero tolerance budget and separated breaches', () => {
    const tracker = new SlaBudgetTracker({ ...scenario, errorBudget: 0 }, 100);
    expect(tracker.snapshot().remainingPercent).toBe(100);
    expect(tracker.advance(5, slow).remainingPercent).toBe(0);
    tracker.advance(25, healthy);
    tracker.advance(5, highErrors);
    expect(tracker.advance(75, healthy).remainingPercent).toBe(0);
    expect(tracker.advance(25, healthy).remainingPercent).toBe(100);
  });
});

describe('trace recorder', () => {
  function trace(id: number, status: RequestTrace['status'] = 'ok'): RequestTrace {
    return {
      requestId: String(id),
      startMs: 0,
      durationMs: id,
      status,
      spans: [
        { id: 'gateway', nodeId: 'gateway', startMs: 0, durationMs: id,
          queueWaitMs: 0, serviceMs: 1, retryAttempt: 0, status },
        { id: 'db', parentSpanId: 'gateway', nodeId: 'db', startMs: 1, durationMs: id - 1,
          queueWaitMs: 1, serviceMs: id - 2, retryAttempt: 1, status,
          dropReason: status === 'dropped' ? 'queue_full' : undefined },
      ],
    };
  }

  it('retains the newest 200 complete traces in newest-first order', () => {
    const recorder = new TraceRecorder();
    expect(recorder.recent()).toEqual([]);
    for (let id = 2; id <= 406; id++) recorder.record(trace(id));

    const recent = recorder.recent();
    expect(recent).toHaveLength(200);
    expect(recent[0]).toEqual(trace(406));
    expect(recent.at(-1)).toEqual(trace(207));
    expect(recorder.recent(2)).toEqual([trace(406), trace(405)]);
  });

  it('filters retained failures and traces at or above the slow threshold', () => {
    const recorder = new TraceRecorder(4);
    recorder.record(trace(2, 'error'));
    recorder.record(trace(40, 'timeout'));
    recorder.record(trace(20, 'error'));
    recorder.record(trace(50, 'dropped'));
    recorder.record(trace(10));

    expect(recorder.errors()).toEqual([trace(50, 'dropped'), trace(20, 'error'), trace(40, 'timeout')]);
    expect(recorder.errors(1)).toEqual([trace(50, 'dropped')]);
    expect(recorder.slow(40)).toEqual([trace(50, 'dropped'), trace(40, 'timeout')]);
    expect(recorder.slow(40, 0)).toEqual([]);
  });
});
