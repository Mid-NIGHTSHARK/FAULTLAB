import { Fragment, type ReactNode } from 'react';
import type { Edge, NodeConfig } from '../../engine/types';
import type { NodeConfigPatch, TickSnapshot } from '../../engine/simulator';

interface Props { edges: Edge[]; node: NodeConfig | undefined; snapshot: TickSnapshot; collapsed: boolean; toggle: () => void; update: (patch: NodeConfigPatch) => void }
export function NodeInspector({node,edges,snapshot,collapsed,toggle,update}:Props) {
  if(collapsed) return <aside className="collapsed-side"><button onClick={toggle} title="Open inspector">◀</button></aside>;
  const m=node && snapshot.nodes[node.id];
  const slider=(label:string,value:number,min:number,max:number,step:number,change:(v:number)=>void)=><label className="slider"><span>{label}<b>{value.toLocaleString()}</b></span><input type="range" min={min} max={Math.max(max,value)} step={step} value={value} onChange={e=>change(Number(e.target.value))}/></label>;
  const toggleField=(label:string,value:boolean,change:(v:boolean)=>void)=><div className="toggle-row"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={value} className="ops-switch" onClick={()=>change(!value)}/></div>;
  const fields: Record<string, ReactNode> = node ? {
    workers: slider('Workers',node.workerPoolCapacity,0,1000,1,v=>update({workerPoolCapacity:v})),
    queue: slider('Max queue',node.maxQueueSize,0,1000,1,v=>update({maxQueueSize:v})),
    timeout: slider('Timeout (ms)',node.timeoutMs,1,5000,1,v=>update({timeoutMs:v})),
    retry: <label className="select-label">Retry policy<select value={node.retryPolicy.strategy} onChange={e=>update({retryPolicy:{strategy:e.target.value as NodeConfig['retryPolicy']['strategy']}})}><option value="none">None</option><option value="fixed">Fixed</option><option value="exponential_jitter">Exponential jitter</option></select></label>,
    retries: slider('Retry budget',node.retryPolicy.retryBudget,0,10,1,v=>update({retryPolicy:{retryBudget:v}})),
    breaker: toggleField('Circuit breaker', (node.circuitBreaker.minSamples ?? node.circuitBreaker.failureThreshold)<100000,v=>update({circuitBreaker:{minSamples:v?20:100000}})),
    threshold: slider('Breaker threshold %',node.circuitBreaker.errorThresholdPct??50,0,100,1,v=>update({circuitBreaker:{errorThresholdPct:v}})),
    rate: slider('Rate limit RPS',node.rateLimiter.rps,0,50000,1,v=>update({rateLimiter:{rps:v}})),
    burst: slider('Burst capacity',node.rateLimiter.burst,0,5000,1,v=>update({rateLimiter:{burst:v}})),
    ...(node.type==='cache'?{
      enabled: toggleField('Cache enabled',node.cache.enabled!==false,v=>update({cache:{enabled:v}})),
      singleflight: toggleField('Singleflight',node.cache.singleflight,v=>update({cache:{singleflight:v}})),
      jitter: slider('TTL jitter %',node.cache.ttlJitterPercent,0,100,1,v=>update({cache:{ttlJitterPercent:v}})),
    }:{}),
    ...(node.type==='database'?{
      skew: slider('Hot-key skew',node.sharding.zipfSkew,0,5,.1,v=>update({sharding:{zipfSkew:v}})),
      shards: slider('Shard count',node.sharding.shardCount,1,32,1,v=>update({sharding:{shardCount:v}})),
    }:{}),
  } : {};
  const priorities: Partial<Record<NodeConfig['type'], string[]>> = {
    cache: ['enabled','singleflight','jitter'],
    gateway: ['rate','burst','timeout','retry'],
    service: ['retry','retries','breaker','threshold','timeout'],
    database: ['workers','queue','skew','shards'],
    queue: ['queue','workers','timeout'],
  };
  const primary = (node && priorities[node.type]) ?? ['workers','queue','timeout'];
  const renderField = (key: string) => <Fragment key={key}>{fields[key]}</Fragment>;
  return <aside className="inspector"><div className="panel-head"><div><span className="eyebrow">NODE DETAILS</span><h2>Inspector</h2></div><button onClick={toggle} title="Collapse inspector">›</button></div>
    {!node||!m ? <div className="empty-inspector"><div>⌖</div><b>Select a node</b><p>Inspect live metrics and tune its configuration.</p></div> : <div className="inspector-scroll">
      <div className="node-title"><span className="type-icon">◇</span><div><b>{node.name}</b><small>{node.type.toUpperCase()} · {node.id}</small></div><span className="online">● LIVE</span></div>
      <div className="section-title">LIVE TELEMETRY <span>●</span></div>
      <div className="telemetry-grid">{[['RPS',m.rps.toFixed(0)],['ERROR RATE',(m.errorRate*100).toFixed(2)+'%'],['P50',m.p50.toFixed(1)+' ms'],['P95',m.p95.toFixed(1)+' ms'],['P99',m.p99.toFixed(1)+' ms'],['QUEUE',String(m.queueDepth)],['WORKERS',String(m.activeWorkers)],['CACHE HIT',(m.cacheHitRate*100).toFixed(1)+'%'],['CIRCUIT',m.circuitState.replace('_',' ').toUpperCase()]].map(([k,v])=><div key={k}><small>{k}</small><b>{v}</b></div>)}</div>
      <div className="section-title">CONFIGURATION <span>LIVE</span></div>
      <div className="primary-controls">{primary.map(renderField)}</div>
      <details key={node.id} className="advanced-controls"><summary>Advanced Controls</summary>
      {Object.keys(fields).filter(key=>!primary.includes(key)).map(renderField)}
      {edges.filter(edge=>edge.sourceNodeId===node.id).map(edge=>{
        const config=node.edgeCircuitBreakers?.[edge.id];
        const enabled=(config?.minSamples??node.circuitBreaker.minSamples??node.circuitBreaker.failureThreshold)<100000;
        return <div key={edge.id} className="edge-config"><small>{edge.id}</small>
          {toggleField('Edge breaker',enabled,v=>update({edgeCircuitBreakers:{[edge.id]:{minSamples:v?20:100000}}}))}
          {slider('Edge threshold %',config?.errorThresholdPct??node.circuitBreaker.errorThresholdPct??50,0,100,1,v=>update({edgeCircuitBreakers:{[edge.id]:{errorThresholdPct:v}}}))}
        </div>;
      })}
      </details>
    </div>}
  </aside>;
}
