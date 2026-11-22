/** Configuration and output contracts for the simulation core. Durations use milliseconds. */
export type NodeType = 'traffic' | 'gateway' | 'service' | 'cache' | 'database' | 'queue' | 'external';
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface RetryPolicy {
  strategy: 'none' | 'fixed' | 'exponential_jitter';
  /** Maximum retries per request. */
  retryBudget: number;
  delayMs: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxRequests: number;
  /** Percentage in [0, 100]. Defaults to 50. */
  errorThresholdPct?: number;
  minSamples?: number;
  openDurationMs?: number;
  windowMs?: number;
}

export interface CacheConfig {
  /** Disabled caches forward requests without reads, writes, or coalescing. */
  enabled?: boolean;
  ttlMs: number;
  ttlJitterPercent: number;
  singleflight: boolean;
  keyCount?: number;
}

export interface RateLimiterConfig {
  rps: number;
  burst: number;
}

export interface ShardingConfig {
  shardCount: number;
  zipfSkew: number;
}

export interface NodeConfig {
  id: string;
  name: string;
  type: NodeType;
  /** Offered load for traffic nodes. Defaults to rateLimiter.rps. */
  trafficRps?: number;
  serviceTimeSigma?: number;
  saturationPenalty?: number;
  workerPoolCapacity: number;
  maxQueueSize: number;
  baseLatencyMs: number;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  circuitBreaker: CircuitBreakerConfig;
  /** Overrides keyed by outgoing edge ID. Unspecified fields inherit the node policy. */
  edgeCircuitBreakers?: Record<string, Partial<CircuitBreakerConfig>>;
  cache: CacheConfig;
  rateLimiter: RateLimiterConfig;
  sharding: ShardingConfig;
}

export type TraversalOutcome = 'ok' | 'cache_hit' | 'retry' | 'rate_limited' | 'error';

export interface EdgeTraversal {
  edgeId: string;
  requestId: string;
  atMs: number;
  retryAttempt: number;
  outcome: TraversalOutcome;
}

export interface Edge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** Optional branches still consume time and capacity, but may fail without failing the request. */
  required?: boolean;
}

export interface Topology {
  id: string;
  name: string;
  nodes: NodeConfig[];
  edges: Edge[];
}

export interface FaultEvent {
  id: string;
  nodeId: string;
  kind: string;
  startMs: number;
  durationMs: number;
  /** Fault-specific parameters, interpreted by the fault implementation. */
  parameters: Record<string, string | number | boolean>;
}

export type TraceStatus = 'ok' | 'error' | 'timeout' | 'dropped';

export interface TraceSpan {
  id: string;
  parentSpanId?: string;
  nodeId: string;
  startMs: number;
  durationMs: number;
  queueWaitMs: number;
  serviceMs: number;
  /** Zero for the initial attempt. */
  retryAttempt: number;
  status: TraceStatus;
  dropReason?: string;
  statusCode?: number;
}

export interface RequestTrace {
  requestId: string;
  startMs: number;
  durationMs: number;
  status: TraceStatus;
  statusCode?: number;
  dropReason?: string;
  spans: TraceSpan[];
}

export interface TickMetrics {
  rps: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  queueDepth: number;
  activeWorkers: number;
  cacheHitRate: number;
  circuitState: CircuitState;
  perShardLoad: number[];
}

export interface IncidentScenario {
  id: string;
  name: string;
  brief: string;
  topology: Topology;
  slaTargets: {
    availability: number;
    p95LatencyMs?: number;
    p99LatencyMs?: number;
    /** Percentage in [0, 100]. Can be combined with an availability target. */
    maxErrorRatePct?: number;
    holdDurationMs?: number;
  };
  /** Fraction of the budget period allowed to breach either SLA target. */
  errorBudget: number;
  initialFaults: FaultEvent[];
  canonicalFixHints: string[];
}
