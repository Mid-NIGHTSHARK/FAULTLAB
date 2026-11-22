import { describe, expect, it } from 'vitest';
import type { NodeType } from '../src/engine/types';

describe('project smoke test', () => {
  it('runs Vitest with TypeScript', () => {
    const nodeType: NodeType = 'service';
    expect(nodeType).toBe('service');
  });
});
