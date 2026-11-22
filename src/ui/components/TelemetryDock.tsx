import { useState } from 'react';
import type { TickSnapshot } from '../../engine/simulator';
import type { ScenarioTopology } from '../../scenarios';

type ChartSample = Pick<TickSnapshot, 'nowMs' | 'global'>;
interface Props { history: ChartSample[]; snapshot: TickSnapshot; topology: ScenarioTopology; target?: number; collapsed: boolean; toggle:()=>void }
type MetricKey = 'p50' | 'p95' | 'p99' | 'rps' | 'errorRate';
function Chart({history, keys, colors, target, unit}:{history:ChartSample[];keys:MetricKey[];colors:string[];target?:number;unit:string}) {
  const span = Math.max(12_000, (history.at(-1)?.nowMs ?? 0) - (history[0]?.nowMs ?? 0));
  const start = (history.at(-1)?.nowMs ?? 0) - span;
  const values=keys.map(k=>history.map(s=>k==='errorRate'?s.global[k]*100:s.global[k]));
  const max=Math.max(1,target??0,...values[0],...(unit==='ms'?values.flat():[]));
  const secondaryMax=Math.max(1,...(values[1]??[]));
  const y=(value:number,scale:number)=>92-value/scale*80;
  return <div className="plot">
    <div className="plot-axis"><span>{Math.ceil(max).toLocaleString()} {unit}</span>{target!==undefined&&<span className="plot-target">SLA {target} ms</span>}<span>0</span></div>
    <svg viewBox="0 0 600 110" preserveAspectRatio="none" className="chart" aria-label="Live telemetry chart">
      {[12,52,92].map(line=><line key={line} x1="0" x2="600" y1={line} y2={line} stroke="#253142" strokeWidth="1"/>)}
      {target!==undefined&&<line x1="0" x2="600" y1={y(target,max)} y2={y(target,max)} stroke="#ef4444" strokeDasharray="5 5"/>}
      {values.map((series,i)=><polyline key={keys[i]} fill="none" stroke={colors[i]} strokeWidth="2" vectorEffect="non-scaling-stroke" points={series.map((v,j)=>`${(history[j].nowMs-start)*600/span},${y(v,unit==='ms'||i===0?max:secondaryMax)}`).join(' ')}/>)}
    </svg>
  </div>;
}
export function TelemetryDock({history,snapshot,topology,target,collapsed,toggle}:Props) {
  const [tab,setTab]=useState<'metrics'|'shards'|'traces'>('metrics');
  const [filter,setFilter]=useState<'all'|'errors'|'slow'>('all');
  const [traceId,setTraceId]=useState<string|null>(null);
  const [selectedTrace,setSelectedTrace]=useState<TickSnapshot['recentTraces'][number] | null>(null);
  const traces=snapshot.recentTraces.filter(trace=>filter==='all'||(filter==='errors'?trace.status!=='ok':trace.durationMs >= (target ?? 100)));
  const databases=topology.nodes.filter(n=>n.type==='database'&&n.sharding.shardCount>1);
  return <section className={'dock '+(collapsed?'dock-collapsed':'')}><div className="dock-head"><div className="tabs"><button className={tab==='metrics'?'active':''} onClick={()=>{setTab('metrics');if(collapsed)toggle();}}>Live Metrics</button><button className={tab==='shards'?'active':''} onClick={()=>{setTab('shards');if(collapsed)toggle();}}>Shard Heatmap</button><button className={tab==='traces'?'active':''} onClick={()=>{setTab('traces');if(collapsed)toggle();}}>Traces</button></div><button onClick={toggle} title={collapsed?'Expand telemetry':'Collapse telemetry'}>{collapsed?'⌃':'⌄'}</button></div>
    {!collapsed && (tab==='metrics'?<div className="charts">
      <div>
        <div className="chart-head"><b>Global latency <small>ms</small></b><span><i className="cyan"/>p50 <i className="amber"/>p95 <i className="red"/>p99 <strong>{snapshot.global.p99.toFixed(1)} ms</strong></span></div>
        <Chart history={history} keys={['p50','p95','p99']} colors={['#06b6d4','#f59e0b','#ef4444']} target={target} unit="ms"/>
        <div className="chart-foot"><span>{history[0]?.nowMs < 0 ? 'PREVIEW + LIVE' : 'LIVE HISTORY'}</span><span>NOW</span></div>
      </div>
      <div>
        <div className="chart-head"><b>Throughput / errors</b><span><i className="green"/>RPS <i className="red"/>Error % <strong>{Math.round(snapshot.global.rps).toLocaleString()} RPS · {(snapshot.global.errorRate*100).toFixed(2)}%</strong></span></div>
        <Chart history={history} keys={['rps','errorRate']} colors={['#10b981','#ef4444']} unit="RPS"/>
        <div className="chart-foot"><span>{history[0]?.nowMs < 0 ? 'PREVIEW + LIVE' : 'LIVE HISTORY'}</span><span>NOW</span></div>
      </div>
    </div> : tab==='shards'? <div className="shard-area">{databases.length===0?<p>No sharded databases in this topology.</p>:databases.map(node=>{const loads=snapshot.nodes[node.id]?.perShardLoad??[];const peak=Math.max(1,...loads);const total=loads.reduce((a,b)=>a+b,0);return <div key={node.id} className="shard-group"><div className="chart-head"><b>{node.name}</b><span>AVG {loads.length?(total/loads.length).toFixed(0):0} requests / window</span></div><div className="shards">{loads.map((load,i)=><div className={'shard '+(load>total/loads.length*1.5?'hot':'')} key={i}><small>SHARD {i}</small><b>{load}</b><div className="track"><span style={{width:`${load/peak*100}%`}}/></div></div>)}</div></div>})}</div> : <div className="trace-view"><div className="trace-list"><div className="trace-filters">{(['all','errors','slow'] as const).map(value=><button className={filter===value?'active':''} key={value} onClick={()=>setFilter(value)}>{value}</button>)}</div>{traces.map(trace=><button className={'trace-row '+(traceId===trace.requestId?'active':'')} key={trace.requestId} onClick={()=>{setTraceId(trace.requestId);setSelectedTrace(trace);}}><b>#{trace.requestId}</b><span>{trace.durationMs.toFixed(1)} ms</span><span className={trace.status==='ok'?'resolved-label':'danger'}>{trace.statusCode??trace.status}</span><small>{trace.spans.length} hops</small></button>)}</div><div className="waterfall">{selectedTrace ? <><div className="chart-head"><b>Trace #{selectedTrace.requestId}</b><span>{selectedTrace.durationMs.toFixed(1)} ms · {selectedTrace.status}</span></div>{selectedTrace.spans.map(span=>{const total=Math.max(1,selectedTrace.durationMs,...selectedTrace.spans.map(s=>s.startMs+s.durationMs-selectedTrace.startMs));return <div className="span-row" key={span.id}><div><b>{topology.nodes.find(n=>n.id===span.nodeId)?.name??span.nodeId}</b> {span.retryAttempt>0&&<em>retry {span.retryAttempt}</em>} <small>{span.dropReason??span.status}</small></div><div className="span-track"><div className="span-queue" style={{left:`${(span.startMs-selectedTrace.startMs)/total*100}%`,width:`${span.queueWaitMs/total*100}%`}}/><div className="span-service" style={{left:`${(span.startMs-selectedTrace.startMs+span.queueWaitMs)/total*100}%`,width:`${Math.max(.3,span.serviceMs/total*100)}%`}}/></div></div>})}<small>AMBER queue wait · CYAN service execution</small></>:<p>Select a trace to inspect its spans.</p>}</div></div>)}
  </section>;
}
