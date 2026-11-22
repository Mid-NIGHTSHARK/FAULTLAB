import type { NodeConfigPatch } from '../engine/simulator';
import type { Edge, IncidentScenario, NodeConfig, NodeType, Topology } from '../engine/types';

export interface PositionedNode extends NodeConfig {
  x: number;
  y: number;
}

export interface ScenarioTopology extends Topology {
  nodes: PositionedNode[];
}

export interface Sev1Scenario extends IncidentScenario {
  topology: ScenarioTopology;
  symptomSummary: string;
  canonicalFixHints: [string, string];
  slaTargets: IncidentScenario['slaTargets'] & {
    p99LatencyMs: number;
    maxErrorRatePct: number;
    holdDurationMs: number;
  };
  canonicalFix: Record<string, NodeConfigPatch>;
}

export function node(
  id: string, name: string, type: NodeType, x: number, y: number,
  patch: NodeConfigPatch = {},
): PositionedNode {
  return {
    id, name, type, x, y, baseLatencyMs: 1, workerPoolCapacity: 512,
    maxQueueSize: 100, timeoutMs: 1_500, ...patch,
    retryPolicy: { strategy: 'none', retryBudget: 0, delayMs: 0, ...patch.retryPolicy },
    circuitBreaker: {
      failureThreshold: 100_000, resetTimeoutMs: 500, halfOpenMaxRequests: 1, ...patch.circuitBreaker,
    },
    cache: { ttlMs: 2_000, ttlJitterPercent: 0, singleflight: false, ...patch.cache },
    rateLimiter: { rps: 50_000, burst: 1_000, ...patch.rateLimiter },
    sharding: { shardCount: 1, zipfSkew: 0, ...patch.sharding },
  };
}

export function edge(sourceNodeId: string, targetNodeId: string, required = true): Edge {
  return { id: `${sourceNodeId}->${targetNodeId}`, sourceNodeId, targetNodeId, required };
}

export function linear(id: string, name: string, nodes: PositionedNode[]): ScenarioTopology {
  return { id, name, nodes, edges: nodes.slice(1).map((target, i) => edge(nodes[i].id, target.id)) };
}

export function sla(p99LatencyMs: number, maxErrorRatePct: number): Sev1Scenario['slaTargets'] {
  return { p99LatencyMs, maxErrorRatePct, availability: 1 - maxErrorRatePct / 100, holdDurationMs: 5_000 };
}
