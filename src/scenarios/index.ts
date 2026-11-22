import { diwaliPoolExhaustion } from './diwaliPoolExhaustion';
import { hotShard } from './hotShard';
import { queueBackpressure } from './queueBackpressure';
import { sandbox } from './sandbox';
import { tatkal } from './tatkal';
import { upiRetryStorm } from './upiRetryStorm';

export { diwaliPoolExhaustion, hotShard, queueBackpressure, sandbox, tatkal, upiRetryStorm };
export type { PositionedNode, ScenarioTopology, Sev1Scenario } from './model';

export const incidents = [tatkal, upiRetryStorm, diwaliPoolExhaustion, hotShard, queueBackpressure] as const;
export const scenarioRegistry = { incidents, sandbox } as const;
