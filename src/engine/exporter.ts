import type { TickMetrics, Topology } from './types';

export interface SharedState {
  topology: Topology;
  seed: number;
  scenarioId?: string;
}

export interface PostMortemParams {
  title: string;
  symptoms: string;
  before: Pick<TickMetrics, 'p50' | 'p95' | 'p99' | 'errorRate'> & { remainingBudget: number };
  after: Pick<TickMetrics, 'p50' | 'p95' | 'p99' | 'errorRate'> & { remainingBudget: number };
  baseline: Topology;
  current: Topology;
  takeaways: string[];
}

/** Produces paths for each changed leaf, retaining additions and removals. */
function diff(before: unknown, after: unknown, path: string, result: string[]): void {
  if (Object.is(before, after)) return;
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (object(before) && object(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      diff(before[key], after[key], path ? `${path}.${key}` : key, result);
    }
  } else {
    result.push(`| \`${path}\` | \`${JSON.stringify(before) ?? 'undefined'}\` | \`${JSON.stringify(after) ?? 'undefined'}\` |`);
  }
}

export function generatePostMortemMarkdown(p: PostMortemParams): string {
  const rows: string[] = [];
  const baseline = Object.fromEntries(p.baseline.nodes.map(({ id, ...config }) => [id, config]));
  const current = Object.fromEntries(p.current.nodes.map(({ id, ...config }) => [id, config]));
  diff(baseline, current, '', rows);
  const values = [
    ['p50', `${p.before.p50} ms`, `${p.after.p50} ms`],
    ['p95', `${p.before.p95} ms`, `${p.after.p95} ms`],
    ['p99', `${p.before.p99} ms`, `${p.after.p99} ms`],
    ['Error Rate', `${p.before.errorRate * 100}%`, `${p.after.errorRate * 100}%`],
    ['Remaining Error Budget', `${p.before.remainingBudget}%`, `${p.after.remainingBudget}%`],
  ];
  return `# Incident Post-Mortem: ${p.title}

## Trigger / Symptoms

${p.symptoms}

## Before vs. After Telemetry

| Metric | Before | After |
| --- | ---: | ---: |
${values.map(row => `| ${row.join(' | ')} |`).join('\n')}

## Node Config Diff

| Field | Baseline | Current |
| --- | --- | --- |
${rows.join('\n') || '| No changes | — | — |'}

## Engineering Takeaways

${p.takeaways.map(item => `- ${item}`).join('\n')}
`;
}

export function generateResiliencePack(topology: Topology): string {
  const gateways = topology.nodes.filter(n => n.type === 'gateway');
  const nginx = gateways.map((node, i) => `# ${node.name} — http context
limit_req_zone $binary_remote_addr zone=faultlab_${i}:10m rate=${node.rateLimiter.rps}r/s;
# server or location context (supply a real upstream)
location / {
    limit_req zone=faultlab_${i} burst=${node.rateLimiter.burst} nodelay;
    proxy_connect_timeout ${node.timeoutMs}ms;
    proxy_read_timeout ${node.timeoutMs}ms;
    proxy_pass http://UPSTREAM_NAME;
}`).join('\n\n');
  const envoy = topology.nodes.filter(n => topology.edges.some(e => e.sourceNodeId === n.id)).map(node => {
    const retries = node.retryPolicy;
    return `# ${node.name}: cluster threshold and route retry policy (merge into an existing Envoy configuration)
# Simulator breaker error threshold: ${node.circuitBreaker.errorThresholdPct ?? 50}% (Envoy outlier detection requires separate tuning).
circuit_breakers:
  thresholds:
    - priority: DEFAULT
      max_connections: ${node.workerPoolCapacity}
      max_pending_requests: ${node.maxQueueSize}
      max_retries: ${retries.retryBudget}
# route configuration
retry_policy:
  retry_on: "${retries.strategy === 'none' ? '' : '5xx,reset,connect-failure'}"
  num_retries: ${retries.strategy === 'none' ? 0 : retries.retryBudget}
  retry_back_off:
    base_interval: ${Math.max(1, retries.delayMs)}ms
    max_interval: ${Math.max(1, retries.delayMs * 2 ** Math.max(0, retries.retryBudget - 1))}ms
# Simulator strategy: ${retries.strategy}; Envoy retry backoff uses jitter.
${Object.entries(node.edgeCircuitBreakers ?? {}).map(([edge, c]) => `# Edge ${edge}: error threshold ${c.errorThresholdPct ?? node.circuitBreaker.errorThresholdPct ?? 50}%, minimum samples ${c.minSamples ?? node.circuitBreaker.minSamples ?? node.circuitBreaker.failureThreshold}, open duration ${c.openDurationMs ?? node.circuitBreaker.openDurationMs ?? node.circuitBreaker.resetTimeoutMs}ms.`).join('\n')}`;
  }).join('\n\n');
  const checklist = topology.nodes.map(n => `- ${n.name} (${n.type}): workers ${n.workerPoolCapacity}, queue ${n.maxQueueSize}, shards ${n.sharding.shardCount}${n.type === 'cache' ? `, cache ${n.cache.enabled === false ? 'disabled' : 'enabled'}, TTL ${n.cache.ttlMs} ms, jitter ${n.cache.ttlJitterPercent}%, singleflight ${n.cache.singleflight ? 'enabled' : 'disabled'}` : ''}.`).join('\n');
  return `# Resilience Pack

## Nginx

Nginx rate limits below are per client IP. Configure the upstream for your deployment.

\`\`\`nginx
${nginx || '# No gateway configured.'}
\`\`\`

## Envoy

\`\`yaml
${envoy}
\`\`\`

## Redis / App Checklist

${checklist}
`;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function encodeStateToHash(state: SharedState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    encoded += alphabet[n >>> 18] + alphabet[(n >>> 12) & 63];
    if (i + 1 < bytes.length) encoded += alphabet[(n >>> 6) & 63];
    if (i + 2 < bytes.length) encoded += alphabet[n & 63];
  }
  return '#state=' + encoded;
}

export function decodeStateFromHash(hash: string): SharedState | null {
  try {
    if (!/^#state=[A-Za-z0-9_-]+$/.test(hash)) return null;
    const input = hash.slice(7);
    if (input.length % 4 === 1 || input.length > 2_000_000) return null;
    const bytes: number[] = [];
    let buffer = 0, bits = 0;
    for (const char of input) {
      buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
    }
    if (bits && (buffer & ((1 << bits) - 1))) return null;
    const state: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)));
    if (!state || typeof state !== 'object') return null;
    const item = state as Partial<SharedState>;
    if (!Number.isSafeInteger(item.seed) || !item.topology || typeof item.topology.id !== 'string' ||
        typeof item.topology.name !== 'string' || !Array.isArray(item.topology.nodes) ||
        !Array.isArray(item.topology.edges) || (item.scenarioId !== undefined && typeof item.scenarioId !== 'string')) return null;
    if (item.topology.nodes.some(n => !n || typeof n.id !== 'string' || typeof n.type !== 'string' ||
      !n.retryPolicy || !n.circuitBreaker || !n.cache || !n.rateLimiter || !n.sharding) ||
      item.topology.edges.some(e => !e || typeof e.id !== 'string' || typeof e.sourceNodeId !== 'string' || typeof e.targetNodeId !== 'string')) return null;
    return item as SharedState;
  } catch { return null; }
}
