import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from '../src/engine/topology';
import type { Topology } from '../src/engine/types';

function topology(pairs: [string, string][]): Topology {
  return { id:'test', name:'test', nodes:[], edges:pairs.map(([sourceNodeId,targetNodeId],index)=>({id:String(index),sourceNodeId,targetNodeId})) };
}
describe('wouldCreateCycle', () => {
  it('rejects self loops', () => expect(wouldCreateCycle(topology([]),'a','a')).toBe(true));
  it('rejects two node cycles', () => expect(wouldCreateCycle(topology([['a','b']]),'b','a')).toBe(true));
  it('rejects deep indirect cycles', () => expect(wouldCreateCycle(topology([['a','b'],['b','c'],['c','d']]),'d','a')).toBe(true));
  it('allows a diamond DAG', () => expect(wouldCreateCycle(topology([['a','b'],['a','c'],['b','d']]),'c','d')).toBe(false));
  it('allows disconnected components to be joined', () => expect(wouldCreateCycle(topology([['a','b'],['c','d']]),'b','c')).toBe(false));
});
