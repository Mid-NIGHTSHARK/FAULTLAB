import type { FaultEvent, NodeType } from '../../engine/types';
import type { ScenarioTopology } from '../../scenarios';

interface Props {
  topology: ScenarioTopology;
  selected: string | null;
  faults: FaultEvent[];
  inject: (kind: string, target: string, parameters: Record<string,number>) => void;
  clear: (id: string) => void;
}

export function ChaosToolbar({topology,selected,faults,inject,clear}:Props) {
  const selectedNode=topology.nodes.find(n=>n.id===selected);
  const find=(types:NodeType[], preferred=true)=> (preferred && selectedNode && types.includes(selectedNode.type) ? selectedNode : topology.nodes.find(n=>types.includes(n.type)));
  const entries: {label:string;kind:string;target:typeof selectedNode;params:Record<string,number>}[]=[
    {label:'10× Traffic',kind:'traffic_spike',target:find(['traffic']),params:{multiplier:10}},
    {label:'Cache Flush',kind:'cache_flush',target:find(['cache']),params:{}},
    {label:'Latency / Error',kind:'latency_error',target:selectedNode??find(['external','database','service']),params:{latencyMs:100,errorRate:.25}},
    {label:'Node Crash',kind:'node_crash',target:selectedNode??find(['database','external','service']),params:{}},
    {label:'Hot-Key Skew',kind:'hot_key_skew',target:find(['database','cache']),params:{skew:4}},
  ];
  return <div className="chaos-bar"><span className="chaos-label">⚡ CHAOS</span>{entries.map(entry=><button key={entry.kind} disabled={!entry.target} title={entry.target?`Inject ${entry.label} on ${entry.target.name}`:'No compatible node in this topology'} onClick={()=>entry.target&&inject(entry.kind,entry.target.id,entry.params)}>{entry.label}</button>)}<div className="fault-pills">{faults.map(f=><span key={f.id} className="fault-pill" title={f.id}>{f.kind.replaceAll('_',' ')} · {topology.nodes.find(n=>n.id===f.nodeId)?.name??f.nodeId}<button aria-label={`Clear ${f.kind} on ${f.nodeId}`} onClick={()=>clear(f.id)}>×</button></span>)}</div></div>;
}
