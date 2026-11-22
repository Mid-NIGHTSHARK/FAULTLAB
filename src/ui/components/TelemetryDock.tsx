import { useState } from 'react';
import type { TickSnapshot } from '../../engine/simulator';
import type { ScenarioTopology } from '../../scenarios';

interface Props { history: TickSnapshot[]; snapshot: TickSnapshot; topology: ScenarioTopology; target?: number; collapsed: boolean; toggle:()=>void }
function Chart({history, keys, colors, target}:{history:TickSnapshot[];keys:('p50'|'p95'|'p99'|'rps'|'errorRate')[];colors:string[];target?:number}) {
  const values=keys.map(k=>history.map(s=>k==='errorRate'?s.global[k]*100:s.global[k]));
  const max=Math.max(1,target??0,...values.flat());
  return <svg viewBox="0 0 600 110" preserveAspectRatio="none" className="chart" aria-label="Live telemetry chart">
    {[0,1,2].map(i=><line key={i} x1="0" x2="600" y1={10+i*45} y2={10+i*45} stroke="#253142" strokeWidth="1"/>)}
    {target!==undefined&&<line x1="0" x2="600" y1={100-target/max*90} y2={100-target/max*90} stroke="#ef4444" strokeDasharray="5 5"/>}
    {values.map((series,i)=><polyline key={keys[i]} fill="none" stroke={colors[i]} strokeWidth="2" vectorEffect="non-scaling-stroke" points={series.map((v,j)=>`${600-(series.length-1-j)*600/599},${100-v/max*90}`).join(' ')}/>)}
  </svg>;
}
export function TelemetryDock({history,snapshot,topology,target,collapsed,toggle}:Props) {
  const [tab,setTab]=useState<'metrics'|'shards'>('metrics');
  const databases=topology.nodes.filter(n=>n.type==='database'&&n.sharding.shardCount>1);
  return <section className={'dock '+(collapsed?'dock-collapsed':'')}><div className="dock-head"><div className="tabs"><button className={tab==='metrics'?'active':''} onClick={()=>{setTab('metrics');if(collapsed)toggle();}}>Live Metrics</button><button className={tab==='shards'?'active':''} onClick={()=>{setTab('shards');if(collapsed)toggle();}}>Shard Heatmap</button><button disabled title="Coming in Phase 5">Trace Waterfall <span>SOON</span></button></div><button onClick={toggle} title={collapsed?'Expand telemetry':'Collapse telemetry'}>{collapsed?'⌃':'⌄'}</button></div>
    {!collapsed && (tab==='metrics'?<div className="charts"><div><div className="chart-head"><b>Global latency <small>ms</small></b><span><i className="cyan"/>p50 <i className="amber"/>p95 <i className="red"/>p99 {target!==undefined&&<><i className="target"/>SLA</>}</span></div><Chart history={history} keys={['p50','p95','p99']} colors={['#06b6d4','#f59e0b','#ef4444']} target={target}/><div className="chart-foot"><span>LAST 60 SECONDS</span><span>NOW</span></div></div><div><div className="chart-head"><b>Throughput / errors</b><span><i className="green"/>RPS <i className="red"/>Error %</span></div><Chart history={history} keys={['rps']} colors={['#10b981']}/><div className="chart-foot"><span>OFFERED RPS</span><span>{Math.round(snapshot.global.rps).toLocaleString()} RPS · {(snapshot.global.errorRate*100).toFixed(2)}% errors</span></div><div className="error-spark"><Chart history={history} keys={['errorRate']} colors={['#ef4444']}/></div></div></div> : <div className="shard-area">{databases.length===0?<p>No sharded databases in this topology.</p>:databases.map(node=>{const loads=snapshot.nodes[node.id]?.perShardLoad??[];const peak=Math.max(1,...loads);const total=loads.reduce((a,b)=>a+b,0);return <div key={node.id} className="shard-group"><div className="chart-head"><b>{node.name}</b><span>AVG {loads.length?(total/loads.length).toFixed(0):0} requests / window</span></div><div className="shards">{loads.map((load,i)=><div className={'shard '+(load>total/loads.length*1.5?'hot':'')} key={i}><small>SHARD {i}</small><b>{load}</b><div className="track"><span style={{width:`${load/peak*100}%`}}/></div></div>)}</div></div>})}</div>)}
  </section>;
}
