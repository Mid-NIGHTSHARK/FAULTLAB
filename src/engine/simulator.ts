import { CircuitBreaker } from './circuit-breaker';
import { EventQueue } from './event-queue';
import { RollingMetrics, SlaBudgetTracker, type SlaBudgetSnapshot } from './metrics';
import { createPrng, createZipfQuantile } from './prng';
import { TraceRecorder } from './tracer';
import type {
  CircuitBreakerConfig, CircuitState, Edge, FaultEvent, IncidentScenario, NodeConfig, RequestTrace,
  TickMetrics, Topology, TraceSpan, TraceStatus,
} from './types';

export interface SimulatorOptions {
  seed: number;
  scenario?: IncidentScenario;
  tickMs?: number;
  metricsWindowMs?: number;
  slaBudgetPeriodMs?: number;
}

export type NodeConfigPatch = Partial<Omit<NodeConfig,
  'id' | 'type' | 'retryPolicy' | 'circuitBreaker' | 'cache' | 'rateLimiter' | 'sharding' | 'edgeCircuitBreakers'>> & {
  [Key in 'retryPolicy' | 'circuitBreaker' | 'cache' | 'rateLimiter' | 'sharding']?: Partial<NodeConfig[Key]>;
} & Pick<NodeConfig, 'edgeCircuitBreakers'>;

export interface EdgeTraversal {
  edgeId: string;
  requestId: string;
  atMs: number;
  retryAttempt: number;
}

/** RPS counts offered arrivals. Latencies and error rates count completed responses. */
export interface TickSnapshot {
  nowMs: number;
  global: TickMetrics;
  nodes: Record<string, TickMetrics>;
  circuits: Record<string, CircuitState>;
  sla: SlaBudgetSnapshot | null;
  activeFaults: FaultEvent[];
  recentTraces: RequestTrace[];
  edgeTraversals: EdgeTraversal[];
}

const VISUAL_LIMIT = 128;
const OK = { code: 200, status: 'ok' } as const;
const ACCEPTED = { code: 202, status: 'ok' } as const;
const RATE_LIMITED = { code: 429, status: 'dropped', reason: 'RATE_LIMITED' } as const;
const CIRCUIT_OPEN = { code: 503, status: 'dropped', reason: 'CIRCUIT_OPEN' } as const;
const OVERFLOW = { code: 503, status: 'dropped', reason: 'QUEUE_OVERFLOW' } as const;
const CRASH = { code: 503, status: 'error', reason: 'NODE_UNAVAILABLE' } as const;
const TIMEOUT = { code: 504, status: 'timeout', reason: 'TIMEOUT' } as const;
const INJECTED = { code: 503, status: 'error', reason: 'INJECTED_ERROR' } as const;

interface Result { code: number; status: TraceStatus; reason?: string }
type Reply = (result: Result) => void;
interface Request {
  id: string;
  start: number;
  spans: TraceSpan[];
  pending: number;
  end?: { at: number; result: Result };
}

interface Pool {
  workers: number;
  waiting: Map<TraceSpan, () => void>;
}

interface Link {
  edge: Edge;
  target: Machine;
  breaker: CircuitBreaker;
}

/** Metrics count arrivals even while requests are queued or timed out. */
class Arrivals {
  private entries: { at: number; shard: number }[] = [];
  private head = 0;
  private shards: number[] = [];

  record(at: number, shard = -1): void {
    this.entries.push({ at, shard });
    if (shard >= 0) this.shards[shard] = (this.shards[shard] ?? 0) + 1;
  }

  read(now: number, period: number, shardCount: number) {
    while (this.entries[this.head]?.at <= now - period) {
      const { shard } = this.entries[this.head++];
      if (shard >= 0) this.shards[shard]--;
    }
    if (this.head > 0 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
    return {
      rps: ((this.entries.length - this.head) / period) * 1_000,
      perShardLoad: Array.from({ length: shardCount }, (_, index) => this.shards[index] ?? 0),
    };
  }
}

function cleanEffects() {
  return { traffic: 1, latency: 0, survival: 1, crashed: false, synchronized: false, skew: undefined as number | undefined };
}

interface ScheduledFault {
  fault: FaultEvent;
  cancelStart?: () => void;
  cancelEnd?: () => void;
}

interface Machine {
  config: NodeConfig;
  metrics: RollingMetrics;
  arrivals: Arrivals;
  pools: Pool[];
  links: Link[];
  cache: Map<number, number>;
  flights: Map<number, Reply[]>;
  quantile: (fraction: number) => number;
  effects: ReturnType<typeof cleanEffects>;
  crashEpoch: number;
  cacheEpoch: number;
  tokens: number;
  tokenTime: number;
  cancelIngress?: () => void;
  ingressProgress: number;
  ingressTime: number;
  ingressRate: number;
}

function validBreaker(policy: CircuitBreakerConfig): boolean {
  const durations = [policy.openDurationMs ?? policy.resetTimeoutMs, policy.windowMs ?? 1_000];
  const counts = [policy.minSamples ?? policy.failureThreshold, policy.halfOpenMaxRequests];
  const threshold = policy.errorThresholdPct ?? 50;
  return durations.every((value) => Number.isFinite(value) && value > 0) &&
    counts.every((value) => Number.isSafeInteger(value) && value > 0 && value < 2 ** 32) &&
    Number.isFinite(threshold) && threshold >= 0 && threshold <= 100;
}

function patchConfig(config: NodeConfig, patch: NodeConfigPatch): NodeConfig {
  const edgeCircuitBreakers: NonNullable<NodeConfig['edgeCircuitBreakers']> = Object.create(null);
  Object.assign(edgeCircuitBreakers, config.edgeCircuitBreakers);
  for (const [id, override] of Object.entries(patch.edgeCircuitBreakers ?? {})) {
    edgeCircuitBreakers[id] = { ...edgeCircuitBreakers[id], ...override };
  }
  const next = {
    ...config, ...patch, id: config.id, type: config.type,
    retryPolicy: { ...config.retryPolicy, ...patch.retryPolicy },
    circuitBreaker: { ...config.circuitBreaker, ...patch.circuitBreaker },
    edgeCircuitBreakers,
    cache: { ...config.cache, ...patch.cache },
    rateLimiter: { ...config.rateLimiter, ...patch.rateLimiter },
    sharding: { ...config.sharding, ...patch.sharding },
  };
  const { retryPolicy, circuitBreaker, cache, rateLimiter, sharding } = next;
  const nonnegative = [
    next.trafficRps ?? 0, next.baseLatencyMs, next.serviceTimeSigma ?? 0, next.saturationPenalty ?? 0,
    rateLimiter.rps, rateLimiter.burst, retryPolicy.delayMs, cache.ttlMs, sharding.zipfSkew,
  ];
  const counts = [next.workerPoolCapacity, next.maxQueueSize, retryPolicy.retryBudget];
  const positiveCounts = [cache.keyCount ?? 1_024, sharding.shardCount];
  if (nonnegative.some((value) => !Number.isFinite(value) || value < 0) ||
      !Number.isFinite(next.timeoutMs) || next.timeoutMs <= 0 ||
      counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      positiveCounts.some((value) => !Number.isInteger(value) || value < 1 || value >= 2 ** 32) ||
      !Number.isFinite(cache.ttlJitterPercent) || cache.ttlJitterPercent < 0 || cache.ttlJitterPercent > 100 ||
      !validBreaker(circuitBreaker)) {
    throw new RangeError(`Invalid configuration for node ${config.id}`);
  }
  for (const [id, override] of Object.entries(edgeCircuitBreakers)) {
    if (!validBreaker({ ...circuitBreaker, ...override })) {
      throw new RangeError(`Invalid circuit breaker configuration for edge ${id}`);
    }
  }
  return next;
}

/**
 * Simulate a directed acyclic request graph. Fan-out waits for all branches.
 * Only traffic nodes generate ingress. Database worker and queue limits apply per shard.
 */
export function createSimulator(topology: Topology, options: SimulatorOptions) {
  const tickMs = options.tickMs ?? 100;
  const period = options.metricsWindowMs ?? 1_000;
  if (!Number.isFinite(tickMs) || tickMs <= 0) throw new RangeError('Expected a positive tick duration');
  const definitions = topology.nodes.map((config) => patchConfig(config, { edgeCircuitBreakers: config.edgeCircuitBreakers }));
  const edges = topology.edges.map((edge) => ({ ...edge }));
  const scenario = options.scenario && {
    slaTargets: { ...options.scenario.slaTargets },
    errorBudget: options.scenario.errorBudget,
    initialFaults: options.scenario.initialFaults.map(copyFault),
  };

  let seed = options.seed;
  let rng: ReturnType<typeof createPrng>;
  let visualRng: ReturnType<typeof createPrng>;
  let queue: EventQueue;
  let machines: Map<string, Machine>;
  let faults: Map<string, ScheduledFault>;
  let active: Map<string, FaultEvent>;
  let global: RollingMetrics;
  let arrivals: Arrivals;
  let recorder: TraceRecorder;
  let budget: SlaBudgetTracker | null;
  let now: number;
  let tickIndex: number;
  let requestSequence: number;
  let visual: EdgeTraversal[];
  let visualSeen: number;
  let lastVisual: EdgeTraversal[];
  let lastVisualAt: number;

  function reset(nextSeed = seed): void {
    seed = nextSeed;
    rng = createPrng(seed);
    visualRng = createPrng(seed ^ 0x7f4a7c15);
    queue = new EventQueue();
    machines = new Map();
    faults = new Map();
    active = new Map();
    global = new RollingMetrics(period);
    arrivals = new Arrivals();
    recorder = new TraceRecorder();
    budget = scenario ? new SlaBudgetTracker(scenario, options.slaBudgetPeriodMs ?? 60_000) : null;
    now = requestSequence = visualSeen = 0;
    tickIndex = 1;
    visual = [];
    lastVisual = [];
    lastVisualAt = -1;
    for (const config of definitions) {
      if (machines.has(config.id)) throw new Error(`Duplicate node ID: ${config.id}`);
      const machine: Machine = {
        config, metrics: new RollingMetrics(period), arrivals: new Arrivals(), pools: [], links: [],
        cache: new Map(), flights: new Map(), quantile: () => 0, effects: cleanEffects(),
        crashEpoch: 0, cacheEpoch: 0, tokens: config.rateLimiter.burst, tokenTime: 0,
        ingressProgress: 0, ingressTime: 0, ingressRate: 0,
      };
      machines.set(config.id, machine);
      prepareRouting(machine);
    }
    const edgeIds = new Set<string>();
    for (const edge of edges) {
      if (edgeIds.has(edge.id)) throw new Error(`Duplicate edge ID: ${edge.id}`);
      edgeIds.add(edge.id);
      machineFor(edge.sourceNodeId).links.push({ edge, target: machineFor(edge.targetNodeId), breaker: new CircuitBreaker() });
    }
    for (const machine of machines.values()) validateBreakerEdges(machine, machine.config);
    const visiting = new Set<Machine>();
    const visited = new Set<Machine>();
    function visit(machine: Machine): void {
      if (visiting.has(machine)) throw new Error('Topology must be acyclic');
      if (visited.has(machine)) return;
      visiting.add(machine);
      for (const link of machine.links) visit(link.target);
      visiting.delete(machine);
      visited.add(machine);
    }
    for (const machine of machines.values()) visit(machine);
    for (const fault of scenario?.initialFaults ?? []) injectFault(fault);
    for (const machine of machines.values()) if (machine.config.type === 'traffic') retimeIngress(machine);
  }

  function machineFor(id: string): Machine {
    const machine = machines.get(id);
    if (!machine) throw new Error(`Unknown node: ${id}`);
    return machine;
  }

  function prepareRouting(machine: Machine): void {
    const { config } = machine;
    const count = config.type === 'database' ? config.sharding.shardCount : 1;
    while (machine.pools.length < count) machine.pools.push({ workers: 0, waiting: new Map() });
    if (config.type === 'database' || config.type === 'cache') {
      const ranks = config.type === 'cache' ? config.cache.keyCount ?? 1_024 : count;
      machine.quantile = createZipfQuantile(ranks, machine.effects.skew ?? config.sharding.zipfSkew);
    }
  }

  function retimeIngress(machine: Machine): void {
    const { config } = machine;
    if (config.type !== 'traffic') return;
    machine.ingressProgress = Math.min(1, machine.ingressProgress + (now - machine.ingressTime) * machine.ingressRate);
    machine.ingressTime = now;
    machine.ingressRate = (config.trafficRps ?? config.rateLimiter.rps) * machine.effects.traffic / 1_000;
    machine.cancelIngress?.();
    machine.cancelIngress = undefined;
    if (machine.ingressRate === 0) return;
    function scheduleNext(): void {
      const next = now + (1 - machine.ingressProgress) / machine.ingressRate;
      if (!Number.isFinite(next) || (next <= now && machine.ingressProgress < 1)) {
        throw new RangeError('Ingress interval cannot be represented at this simulation time');
      }
      machine.cancelIngress = queue.schedule(next, () => {
        machine.ingressProgress = 0;
        machine.ingressTime = now;
        scheduleNext();
        const request: Request = { id: String(++requestSequence), start: now, spans: [], pending: 0 };
        arrivals.record(now);
        invoke(machine, request, rng.nextFloat(), undefined, 0, (result) => {
          request.end = { at: now, result };
          global.record({ completedAtMs: now, latencyMs: now - request.start, failed: result.status !== 'ok' });
          publish(request);
        });
      });
    }
    scheduleNext();
  }

  function refill(machine: Machine): void {
    const { rps, burst } = machine.config.rateLimiter;
    machine.tokens = Math.min(burst, machine.tokens + (now - machine.tokenTime) * rps / 1_000);
    machine.tokenTime = now;
  }

  function validateBreakerEdges(machine: Machine, config: NodeConfig): void {
    for (const id of Object.keys(config.edgeCircuitBreakers ?? {})) {
      if (!machine.links.some(({ edge }) => edge.id === id)) {
        throw new Error(`Unknown outgoing edge ${id} on node ${config.id}`);
      }
    }
  }

  function updateNodeConfig(nodeId: string, patch: NodeConfigPatch): void {
    const machine = machineFor(nodeId);
    const old = machine.config;
    const next = patchConfig(old, patch);
    validateBreakerEdges(machine, next);
    refill(machine);
    machine.config = next;
    machine.tokens = Math.min(machine.tokens, next.rateLimiter.burst);
    if (next.cache.keyCount !== old.cache.keyCount || next.cache.enabled !== old.cache.enabled) {
      machine.cache.clear();
      machine.flights.clear();
      machine.cacheEpoch++;
    }
    if (next.sharding.shardCount !== old.sharding.shardCount ||
        next.sharding.zipfSkew !== old.sharding.zipfSkew || next.cache.keyCount !== old.cache.keyCount) {
      prepareRouting(machine);
    }
    if ((next.trafficRps ?? next.rateLimiter.rps) !== (old.trafficRps ?? old.rateLimiter.rps)) retimeIngress(machine);
    for (const pool of machine.pools) drain(machine, pool);
  }

  function copyFault(fault: FaultEvent): FaultEvent {
    return { ...fault, parameters: { ...fault.parameters } };
  }

  function parameter(fault: FaultEvent, name: string, fallback?: number): number {
    const value = fault.parameters[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`Invalid ${name} for fault ${fault.id}`);
    }
    return value;
  }

  /**
   * Fault kinds and parameters: traffic_spike { multiplier }, cache_flush {},
   * latency_error { latencyMs?, errorRate? }, node_crash {}, hot_key_skew { skew }.
   * Fault intervals are half-open and transitions precede work at the same time.
   */
  function injectFault(input: FaultEvent): void {
    const fault = copyFault(input);
    const machine = machineFor(fault.nodeId);
    const end = fault.startMs + fault.durationMs;
    if (!Number.isFinite(fault.startMs) || fault.startMs < 0 || !Number.isFinite(end) ||
        fault.durationMs <= 0 || end <= now || end <= fault.startMs) throw new RangeError('Invalid fault interval');
    switch (fault.kind) {
      case 'traffic_spike':
        if (machine.config.type !== 'traffic') throw new Error('Traffic spike requires a traffic node');
        parameter(fault, 'multiplier');
        break;
      case 'cache_flush':
        if (machine.config.type !== 'cache') throw new Error('Cache flush requires a cache node');
        break;
      case 'latency_error':
        parameter(fault, 'latencyMs', 0);
        if (parameter(fault, 'errorRate', 0) > 1) throw new RangeError('Error rate must be a fraction');
        break;
      case 'node_crash':
        break;
      case 'hot_key_skew':
        if (machine.config.type !== 'database' && machine.config.type !== 'cache') {
          throw new Error('Hot-key skew requires a cache or database node');
        }
        parameter(fault, 'skew');
        break;
      default:
        throw new Error(`Unsupported fault kind: ${fault.kind}`);
    }
    clearFault(fault.id);
    const scheduled: ScheduledFault = { fault };
    faults.set(fault.id, scheduled);
    const enable = () => {
      active.set(fault.id, fault);
      if (fault.kind === 'cache_flush') {
        machine.cache.clear();
        machine.flights.clear();
        machine.cacheEpoch++;
      }
      refreshEffects(machine);
    };
    if (fault.startMs <= now) enable();
    else scheduled.cancelStart = queue.schedule(fault.startMs, enable, -1);
    scheduled.cancelEnd = queue.schedule(end, () => clearFault(fault.id), -1);
  }

  function clearFault(faultId: string): void {
    const scheduled = faults.get(faultId);
    if (!scheduled) return;
    faults.delete(faultId);
    scheduled.cancelStart?.();
    scheduled.cancelEnd?.();
    if (active.delete(faultId)) refreshEffects(machineFor(scheduled.fault.nodeId));
  }

  function refreshEffects(machine: Machine): void {
    const effects = cleanEffects();
    for (const fault of active.values()) {
      if (fault.nodeId !== machine.config.id) continue;
      switch (fault.kind) {
        case 'traffic_spike': effects.traffic *= parameter(fault, 'multiplier'); break;
        case 'cache_flush': effects.synchronized = true; break;
        case 'latency_error':
          effects.latency += parameter(fault, 'latencyMs', 0);
          effects.survival *= 1 - parameter(fault, 'errorRate', 0);
          break;
        case 'node_crash': effects.crashed = true; break;
        case 'hot_key_skew': effects.skew = parameter(fault, 'skew'); break;
      }
    }
    const previous = machine.effects;
    machine.effects = effects;
    if (effects.crashed && !previous.crashed) machine.crashEpoch++;
    if (effects.skew !== previous.skew) prepareRouting(machine);
    if (effects.traffic !== previous.traffic) retimeIngress(machine);
  }

  function publish(request: Request): void {
    if (!request.end || request.pending !== 0) return;
    const { at, result } = request.end;
    for (const span of request.spans) Object.freeze(span);
    Object.freeze(request.spans);
    recorder.record(Object.freeze({
      requestId: request.id, startMs: request.start, durationMs: at - request.start,
      status: result.status, statusCode: result.code, dropReason: result.reason, spans: request.spans,
    }));
  }

  function newSpan(request: Request, machine: Machine, parent: TraceSpan | undefined, attempt: number): TraceSpan {
    const span: TraceSpan = {
      id: `${request.id}:${request.spans.length}`, parentSpanId: parent?.id, nodeId: machine.config.id,
      startMs: now, durationMs: 0, queueWaitMs: 0, serviceMs: 0, retryAttempt: attempt, status: 'ok',
    };
    request.spans.push(span);
    request.pending++;
    return span;
  }

  function finishSpan(request: Request, span: TraceSpan, result: Result): void {
    span.durationMs = now - span.startMs;
    span.status = result.status;
    span.statusCode = result.code;
    span.dropReason = result.reason;
    request.pending--;
    publish(request);
  }

  function sampleTraversal(link: Link, request: Request, retryAttempt: number): void {
    const seen = ++visualSeen;
    const index = seen <= VISUAL_LIMIT ? seen - 1 : visualRng.nextInt(0, seen - 1);
    if (index < VISUAL_LIMIT) visual[index] = { edgeId: link.edge.id, requestId: request.id, atMs: now, retryAttempt };
  }

  function forward(
    machine: Machine, request: Request, key: number, parent: TraceSpan, alive: () => boolean, reply: Reply,
  ): void {
    let waiting = machine.links.length;
    if (waiting === 0) {
      reply(OK);
      return;
    }
    const outcomes: Result[] = [];
    for (const [index, link] of machine.links.entries()) {
      const finish: Reply = (result) => {
        outcomes[index] = result;
        if (--waiting === 0) {
          reply(outcomes.find((outcome, index) => machine.links[index].edge.required !== false && outcome.status !== 'ok') ??
            outcomes.find((outcome, index) => machine.links[index].edge.required !== false && outcome.code === 202) ?? OK);
        }
      };
      const breakerConfig = () => {
        const override = machine.config.edgeCircuitBreakers?.[link.edge.id];
        return override ? { ...machine.config.circuitBreaker, ...override } : machine.config.circuitBreaker;
      };
      function dispatch(attempt: number, previous: TraceSpan): void {
        const epoch = link.breaker.admit(now, breakerConfig());
        if (epoch === undefined) {
          const blocked = newSpan(request, link.target, previous, attempt);
          finishSpan(request, blocked, CIRCUIT_OPEN);
          finish(CIRCUIT_OPEN);
          return;
        }
        sampleTraversal(link, request, attempt);
        invoke(link.target, request, key, previous, attempt, (result, span) => {
          link.breaker.settle(epoch, now, result.status !== 'ok', breakerConfig());
          const policy = machine.config.retryPolicy;
          if (result.code < 500 || result === CIRCUIT_OPEN || policy.strategy === 'none' ||
              attempt >= policy.retryBudget || !alive()) {
            finish(result);
            return;
          }
          const delay = policy.strategy === 'fixed' || policy.delayMs === 0
            ? policy.delayMs
            : rng.nextFloat() * policy.delayMs * 2 ** Math.min(attempt, 52);
          queue.schedule(now + delay, () => {
            if (alive()) dispatch(attempt + 1, span);
            else finish(result);
          });
        });
      }
      dispatch(0, parent);
    }
  }

  function drain(machine: Machine, pool: Pool): void {
    while (pool.workers < machine.config.workerPoolCapacity && pool.waiting.size > 0) {
      const [span, start] = pool.waiting.entries().next().value!;
      pool.waiting.delete(span);
      start();
    }
  }

  function invoke(
    machine: Machine, request: Request, key: number, parent: TraceSpan | undefined,
    attempt: number, reply: (result: Result, span: TraceSpan) => void,
  ): void {
    const shard = machine.config.type === 'database' ? machine.quantile(key) : -1;
    const pool = machine.pools[Math.max(0, shard)];
    const span = newSpan(request, machine, parent, attempt);
    machine.arrivals.record(now, shard);
    const isAsync = machine.config.type === 'queue';
    let queued = false;
    let responded = false;
    let settled = false;
    let serviceStart: number | undefined;
    let localDuration = 0;
    let cacheOutcome: 'hit' | 'miss' | undefined;
    let cancelDeadline: (() => void) | undefined;

    function respond(result: Result): void {
      if (responded) return;
      responded = true;
      reply(result, span);
    }

    function complete(result: Result): void {
      if (settled) return;
      settled = true;
      cancelDeadline?.();
      if (queued) {
        pool.waiting.delete(span);
        span.queueWaitMs = now - span.startMs;
      }
      if (serviceStart !== undefined) span.serviceMs = Math.min(localDuration, now - serviceStart);
      machine.metrics.record({
        completedAtMs: now, latencyMs: now - span.startMs, failed: result.status !== 'ok', cacheOutcome,
      });
      finishSpan(request, span, result);
      respond(result);
    }

    function start(): void {
      queued = false;
      span.queueWaitMs = now - span.startMs;
      serviceStart = now;
      const { config, effects, crashEpoch } = machine;
      pool.workers++;
      const utilization = pool.workers / Math.max(1, config.workerPoolCapacity);
      const median = config.baseLatencyMs * (1 + (config.saturationPenalty ?? 0.25) * utilization ** 2);
      localDuration = (median ? rng.nextLogNormal(median, config.serviceTimeSigma ?? 0.25) : 0) + effects.latency;
      const fails = effects.survival < 1 && rng.nextFloat() >= effects.survival;
      queue.schedule(now + localDuration, () => {
        const release = () => {
          pool.workers--;
          drain(machine, pool);
        };
        if (settled) {
          release();
        } else if (effects.crashed || machine.crashEpoch !== crashEpoch || fails) {
          release();
          complete(effects.crashed || machine.crashEpoch !== crashEpoch ? CRASH : INJECTED);
        } else if (config.type === 'cache' && machine.config.cache.enabled !== false) {
          release();
          lookup(machine, request, key, span, () => !settled, (outcome) => { cacheOutcome = outcome; },
            (result) => complete(machine.crashEpoch === crashEpoch ? result : CRASH));
        } else {
          forward(machine, request, key, span, () => !settled, (result) => {
            release();
            complete(machine.crashEpoch === crashEpoch ? result : CRASH);
          });
        }
      });
    }

    if (machine.effects.crashed) {
      complete(CRASH);
      return;
    }
    refill(machine);
    if (machine.tokens < 1 - 1e-9) {
      complete(RATE_LIMITED);
      return;
    }
    machine.tokens = Math.max(0, machine.tokens - 1);
    if (pool.workers >= machine.config.workerPoolCapacity && pool.waiting.size >= machine.config.maxQueueSize) {
      complete(OVERFLOW);
      return;
    }
    if (!isAsync) cancelDeadline = queue.schedule(now + machine.config.timeoutMs, () => complete(TIMEOUT));
    if (pool.workers < machine.config.workerPoolCapacity) start();
    else {
      queued = true;
      pool.waiting.set(span, start);
    }
    if (isAsync) respond(ACCEPTED);
  }

  function lookup(
    machine: Machine, request: Request, key: number, span: TraceSpan, alive: () => boolean,
    report: (outcome: 'hit' | 'miss') => void, reply: Reply,
  ): void {
    const config = machine.config.cache;
    const rank = machine.quantile(key);
    if ((machine.cache.get(rank) ?? -1) > now) {
      report('hit');
      reply(OK);
      return;
    }
    report('miss');
    const existing = config.singleflight ? machine.flights.get(rank) : undefined;
    if (existing) {
      existing.push(reply);
      return;
    }
    const waiters = [reply];
    if (config.singleflight) machine.flights.set(rank, waiters);
    const epoch = machine.cacheEpoch;
    const crashEpoch = machine.crashEpoch;
    forward(machine, request, (rank + 0.5) / (config.keyCount ?? 1_024), span,
      config.singleflight ? () => true : alive, (result) => {
        if (machine.flights.get(rank) === waiters) machine.flights.delete(rank);
        if (result.status === 'ok' && epoch === machine.cacheEpoch && crashEpoch === machine.crashEpoch) {
          const current = machine.config.cache;
          const jitter = machine.effects.synchronized ? 0 : current.ttlJitterPercent / 100;
          const factor = jitter ? 1 + (2 * rng.nextFloat() - 1) * jitter : 1;
          machine.cache.set(rank, now + current.ttlMs * factor);
        }
        for (const waiter of waiters) waiter(result);
      });
  }

  function capture(slaDuration = 0): TickSnapshot {
    let queueDepth = 0;
    let activeWorkers = 0;
    let circuitState: CircuitState = 'closed';
    const nodes: [string, TickMetrics][] = [];
    const circuits: [string, CircuitState][] = [];
    const worse = (a: CircuitState, b: CircuitState): CircuitState =>
      a === 'open' || b === 'open' ? 'open' : a === 'half_open' || b === 'half_open' ? 'half_open' : 'closed';
    let lookups = 0;
    let hits = 0;
    const perShardLoad: number[] = [];
    for (const [id, machine] of machines) {
      let nodeCircuit: CircuitState = 'closed';
      for (const link of machine.links) {
        const state = link.breaker.state(now);
        circuits.push([link.edge.id, state]);
        nodeCircuit = worse(nodeCircuit, state);
      }
      const gauges = { queueDepth: 0, activeWorkers: 0, circuitState: nodeCircuit };
      for (const pool of machine.pools) {
        gauges.queueDepth += pool.waiting.size;
        gauges.activeWorkers += pool.workers;
      }
      const traffic = machine.arrivals.read(now, period,
        machine.config.type === 'database' ? machine.config.sharding.shardCount : 0);
      const nodeMetrics = { ...machine.metrics.snapshot(now, gauges), ...traffic };
      const cache = machine.metrics.cacheCounts();
      lookups += cache.lookups;
      hits += cache.hits;
      nodes.push([id, nodeMetrics]);
      for (const load of traffic.perShardLoad) perShardLoad.push(load);
      queueDepth += gauges.queueDepth;
      activeWorkers += gauges.activeWorkers;
      circuitState = worse(circuitState, nodeCircuit);
    }
    const metrics = {
      ...global.snapshot(now, { queueDepth, activeWorkers, circuitState }),
      rps: arrivals.read(now, period, 0).rps, cacheHitRate: lookups ? hits / lookups : 0, perShardLoad,
    };
    return {
      nowMs: now, global: metrics, nodes: Object.fromEntries(nodes), circuits: Object.fromEntries(circuits),
      sla: budget ? (slaDuration ? budget.advance(slaDuration, metrics) : budget.snapshot()) : null,
      activeFaults: Array.from(active.values(), copyFault),
      recentTraces: recorder.recent(), edgeTraversals: visual.slice().sort((a, b) => a.atMs - b.atMs),
    };
  }

  /** Return snapshots for each fixed logical tick crossed, including its end boundary. */
  function step(deltaMs = tickMs): TickSnapshot[] {
    let target = now + deltaMs;
    if (!Number.isFinite(target) || deltaMs < 0) throw new RangeError('Invalid step duration');
    const nearestTick = Math.round(target / tickMs) * tickMs;
    // Snap only floating-point differences around a tick boundary.
    if (deltaMs > 0 && nearestTick > now &&
        Math.abs(nearestTick - target) <= Number.EPSILON * Math.max(nearestTick, target)) {
      target = nearestTick;
    }
    const snapshots: TickSnapshot[] = [];
    function runUntil(end: number): void {
      let event = queue.peek();
      while (event && event.at <= end) {
        now = event.at;
        queue.pop().run();
        event = queue.peek();
      }
      now = end;
    }
    while (tickIndex * tickMs <= target) {
      runUntil(tickIndex++ * tickMs);
      const snapshot = capture(tickMs);
      snapshots.push(snapshot);
      lastVisual = snapshot.edgeTraversals.map((event) => ({ ...event }));
      lastVisualAt = now;
      visual = [];
      visualSeen = 0;
    }
    if (now < target) runUntil(target);
    return snapshots;
  }

  /** Current metrics, with the last completed visual batch at an exact tick boundary. */
  function getSnapshot(): TickSnapshot {
    const current = capture();
    if (lastVisualAt === now) current.edgeTraversals = lastVisual.map((event) => ({ ...event }));
    return current;
  }

  reset();
  return { step, getSnapshot, updateNodeConfig, injectFault, clearFault, reset };
}
