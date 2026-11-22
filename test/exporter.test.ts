import { describe, expect, it } from 'vitest';
import { decodeStateFromHash, encodeStateToHash, generatePostMortemMarkdown, generateResiliencePack } from '../src/engine/exporter';
import { sandbox } from '../src/scenarios';

describe('exporter', () => {
  it('round trips a Unicode topology, config, edges, and seed using URL-safe base64', () => {
    const state = { topology: { ...sandbox, name: 'भारत 🚆' }, seed: 123, scenarioId: 'sandbox' };
    const hash = encodeStateToHash(state);
    expect(hash).toMatch(/^#state=[A-Za-z0-9_-]+$/);
    expect(encodeStateToHash(state)).toBe(hash);
    expect(decodeStateFromHash(hash)).toEqual(state);
  });

  it.each(['', '#state=', '#state=!', '#state=a', '#state=YWJj', '#other=YWJj', '#state=_w'])(
    'rejects malformed state %s', hash => expect(decodeStateFromHash(hash)).toBeNull(),
  );

  it('rejects unknown node types, invalid configs, dangling edges and cycles', () => {
    const encode = (topology: typeof sandbox) => encodeStateToHash({topology, seed: 1});
    expect(decodeStateFromHash(encode({...sandbox, nodes: sandbox.nodes.map((node,i)=>i===0?{...node,type:'alien' as typeof node.type}:node)}))).toBeNull();
    expect(decodeStateFromHash(encode({...sandbox, edges:[...sandbox.edges,{id:'dangling',sourceNodeId:'db',targetNodeId:'missing'}]}))).toBeNull();
    expect(decodeStateFromHash(encode({...sandbox, edges:[...sandbox.edges,{id:'cycle',sourceNodeId:'db',targetNodeId:'traffic'}]}))).toBeNull();
    expect(decodeStateFromHash(encode({...sandbox, nodes:sandbox.nodes.map((node,i)=>i===0?{...node,workerPoolCapacity:-1}:node)}))).toBeNull();
    expect(decodeStateFromHash(encode({...sandbox, nodes:sandbox.nodes.map((node,i)=>i===0?{...node,sharding:{...node.sharding,shardCount:100_000_000}}:node)}))).toBeNull();
  });

  it('reports real before and after metrics and exact configuration changes', () => {
    const current = { ...sandbox, nodes: sandbox.nodes.map(node => node.id === 'redis'
      ? { ...node, cache: { ...node.cache, singleflight: false, ttlJitterPercent: 42 } } : node) };
    const result = generatePostMortemMarkdown({
      title: 'Test incident', symptoms: 'Expiry spike',
      before: { p50: 10, p95: 20, p99: 30, errorRate: 0.25, remainingBudget: 60 },
      after: { p50: 2, p95: 3, p99: 4, errorRate: 0, remainingBudget: 50 },
      baseline: sandbox, current, takeaways: ['Coalesce misses'],
    });
    expect(result).toContain('| p99 | 30 ms | 4 ms |');
    expect(result).toContain('| Error Rate | 25% | 0% |');
    expect(result).toContain('| Remaining Error Budget | 60% | 50% |');
    expect(result).toContain('| `redis.cache.singleflight` | `true` | `false` |');
    expect(result).toContain('| `redis.cache.ttlJitterPercent` | `20` | `42` |');
    expect(result).toContain('Coalesce misses');
  });

  it('derives gateway, retry, circuit, cache, and sizing values from the supplied topology', () => {
    const topology = { ...sandbox, nodes: sandbox.nodes.map(node => node.id === 'gateway'
      ? { ...node, timeoutMs: 432, rateLimiter: { rps: 765, burst: 17 },
        circuitBreaker: { ...node.circuitBreaker, errorThresholdPct: 33 },
        retryPolicy: { strategy: 'exponential_jitter' as const, retryBudget: 3, delayMs: 12 } }
      : node) };
    const pack = generateResiliencePack(topology);
    expect(pack).toContain('rate=765r/s');
    expect(pack).toContain('burst=17');
    expect(pack).toContain('proxy_read_timeout 432ms');
    expect(pack).toContain('error threshold: 33%');
    expect(pack).toContain('num_retries: 3');
    expect(pack).toContain('base_interval: 12ms');
    expect(pack).toContain('jitter 20%, singleflight enabled');
    expect(pack).toContain('shards 2');
  });
});
