import type { IncidentScenario, TickMetrics } from './types';

export interface RequestObservation {
  completedAtMs: number;
  latencyMs: number;
  failed: boolean;
  cacheOutcome?: 'hit' | 'miss';
  shardIndex?: number;
}

export type NodeGauges = Pick<TickMetrics, 'queueDepth' | 'activeWorkers' | 'circuitState'>;

const idleGauges: NodeGauges = { queueDepth: 0, activeWorkers: 0, circuitState: 'closed' };

function positiveDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0;
}

export class RollingMetrics {
  private observations: RequestObservation[] = [];
  private head = 0;
  private nowMs = 0;
  private lastCache = { hits: 0, lookups: 0 };

  constructor(readonly windowMs: number, readonly shardCount = 0) {
    if (!positiveDuration(windowMs)) throw new RangeError('Expected a positive finite window');
    if (!Number.isInteger(shardCount) || shardCount < 0 || shardCount >= 2 ** 32) {
      throw new RangeError('Expected a nonnegative shard count');
    }
  }

  /** Record a completed request using monotonically increasing simulation time. */
  record(observation: RequestObservation): void {
    const { completedAtMs, latencyMs, shardIndex } = observation;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new RangeError('Invalid latency');
    if (shardIndex !== undefined &&
        (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= this.shardCount)) {
      throw new RangeError('Shard index is outside the configured shard range');
    }
    this.advance(completedAtMs);
    this.observations.push({ ...observation });
  }

  /** Aggregate completions in (nowMs - windowMs, nowMs]. Gauges are the current values. */
  snapshot(nowMs: number, gauges: NodeGauges = idleGauges): TickMetrics {
    this.advance(nowMs);
    const latencies: number[] = [];
    const perShardLoad = new Array<number>(this.shardCount).fill(0);
    let errors = 0;
    let cacheHits = 0;
    let cacheLookups = 0;

    for (let index = this.head; index < this.observations.length; index++) {
      const observation = this.observations[index];
      latencies.push(observation.latencyMs);
      if (observation.failed) errors++;
      if (observation.cacheOutcome !== undefined) cacheLookups++;
      if (observation.cacheOutcome === 'hit') cacheHits++;
      if (observation.shardIndex !== undefined) perShardLoad[observation.shardIndex]++;
    }

    this.lastCache = { hits: cacheHits, lookups: cacheLookups };
    latencies.sort((a, b) => a - b);
    const count = latencies.length;
    // Nearest-rank percentiles report an observed latency, including failed requests.
    const percentile = (percent: number) => latencies[Math.ceil((percent * count) / 100) - 1] ?? 0;
    return {
      ...gauges,
      rps: count ? Math.min(Number.MAX_VALUE, (count / this.windowMs) * 1_000) : 0,
      errorRate: count ? errors / count : 0,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      cacheHitRate: cacheLookups ? cacheHits / cacheLookups : 0,
      perShardLoad,
    };
  }

  /** Cache outcomes counted by the latest snapshot. */
  cacheCounts(): Readonly<{ hits: number; lookups: number }> {
    return this.lastCache;
  }

  private advance(nowMs: number): void {
    if (!Number.isFinite(nowMs) || nowMs < this.nowMs) {
      throw new RangeError('Simulation time must be finite and cannot move backwards');
    }
    this.nowMs = nowMs;
    const cutoff = nowMs - this.windowMs;
    while (this.head < this.observations.length && this.observations[this.head].completedAtMs <= cutoff) {
      this.head++;
    }
    if (this.head > 0 && this.head * 2 >= this.observations.length) {
      this.observations = this.observations.slice(this.head);
      this.head = 0;
    }
  }
}

export interface SlaBudgetSnapshot {
  remainingPercent: number;
  healthyDurationMs: number;
}

export class SlaBudgetTracker {
  private readonly allowedBreachMs: number;
  private readonly targets: IncidentScenario['slaTargets'];
  private breaches: { startMs: number; endMs: number }[] = [];
  private head = 0;
  private elapsedMs = 0;
  private breachMs = 0;
  private healthyDurationMs = 0;

  constructor(scenario: Pick<IncidentScenario, 'slaTargets' | 'errorBudget'>, readonly periodMs: number) {
    const { availability, p95LatencyMs, p99LatencyMs, maxErrorRatePct, holdDurationMs } = scenario.slaTargets;
    if (!positiveDuration(periodMs) || !Number.isFinite(scenario.errorBudget) ||
        scenario.errorBudget < 0 || scenario.errorBudget > 1 ||
        !Number.isFinite(availability) || availability < 0 || availability > 1 ||
        [p95LatencyMs, p99LatencyMs, maxErrorRatePct, holdDurationMs].some(
          (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
        ) || (maxErrorRatePct ?? 0) > 100) {
      throw new RangeError('Invalid SLA targets, error budget, or budget period');
    }
    this.targets = { ...scenario.slaTargets };
    this.allowedBreachMs = periodMs * scenario.errorBudget;
  }

  /** Apply measured metrics for the next simulation interval. Breaches expire after periodMs. */
  advance(durationMs: number, metrics: Pick<TickMetrics, 'errorRate' | 'p95'> & Partial<Pick<TickMetrics, 'p99'>>): SlaBudgetSnapshot {
    const endMs = this.elapsedMs + durationMs;
    if (!positiveDuration(durationMs) || !Number.isFinite(endMs) || endMs <= this.elapsedMs) {
      throw new RangeError('Expected a positive interval that advances simulation time');
    }
    const { p95LatencyMs, p99LatencyMs, availability, maxErrorRatePct } = this.targets;
    const { errorRate, p95, p99 } = metrics;
    if (!Number.isFinite(errorRate) || errorRate < 0 || errorRate > 1 ||
        !Number.isFinite(p95) || p95 < 0 ||
        (p99LatencyMs !== undefined && (p99 === undefined || !Number.isFinite(p99) || p99 < 0))) {
      throw new RangeError('Invalid SLA measurements');
    }
    const healthy = 1 - errorRate >= availability &&
      (maxErrorRatePct === undefined || errorRate * 100 <= maxErrorRatePct) &&
      (p95LatencyMs === undefined || p95 <= p95LatencyMs) &&
      (p99LatencyMs === undefined || (p99 !== undefined && p99 <= p99LatencyMs));

    if (healthy) {
      this.healthyDurationMs += durationMs;
    } else {
      const last = this.breaches.at(-1);
      if (last?.endMs === this.elapsedMs) last.endMs = endMs;
      else this.breaches.push({ startMs: this.elapsedMs, endMs });
      this.breachMs += endMs - this.elapsedMs;
      this.healthyDurationMs = 0;
    }

    this.elapsedMs = endMs;
    const cutoff = endMs - this.periodMs;
    while (this.head < this.breaches.length) {
      const breach = this.breaches[this.head];
      if (breach.startMs >= cutoff) break;
      if (breach.endMs > cutoff) {
        this.breachMs -= cutoff - breach.startMs;
        breach.startMs = cutoff;
        break;
      }
      this.breachMs -= breach.endMs - breach.startMs;
      this.head++;
    }
    if (this.head > 0 && this.head * 2 >= this.breaches.length) {
      this.breaches = this.breaches.slice(this.head);
      this.head = 0;
    }
    if (this.breaches.length === 0) this.breachMs = 0;
    return this.snapshot();
  }

  snapshot(): SlaBudgetSnapshot {
    const remainingPercent = this.allowedBreachMs === 0
      ? (this.breaches.length > 0 ? 0 : 100)
      : Math.max(0, Math.min(100, (1 - this.breachMs / this.allowedBreachMs) * 100));
    return { remainingPercent, healthyDurationMs: this.healthyDurationMs };
  }
}
