import { useCallback, useEffect, useRef, useState } from 'react';
import { createSimulator, type NodeConfigPatch, type TickSnapshot } from './engine/simulator';
import { incidents, sandbox } from './scenarios';
import type { ScenarioTopology } from './scenarios';
import { decodeStateFromHash, encodeStateToHash, generatePostMortemMarkdown, generateResiliencePack } from './engine/exporter';
import { IncidentBriefModal } from './ui/components/IncidentBriefModal';
import { PostMortemModal } from './ui/components/PostMortemModal';
import { TopologyCanvas } from './ui/canvas/TopologyCanvas';
import { TopControlBar } from './ui/components/TopControlBar';
import { NodeInspector } from './ui/components/NodeInspector';
import { TelemetryDock } from './ui/components/TelemetryDock';

function makeWorld(id:string,seed:number, sharedTopology?:ScenarioTopology) {
  const scenario=incidents.find(item=>item.id===id);
  const topology:ScenarioTopology=sharedTopology??scenario?.topology??sandbox;
  const simulator=createSimulator(topology,{seed,scenario});
  return {scenario,topology,simulator};
}
function initialWorld() {
  const state=decodeStateFromHash(window.location.hash);
  if (state && state.topology.nodes.every(n=>typeof (n as {x?:unknown}).x==='number' && typeof (n as {y?:unknown}).y==='number')) {
    try {
      const id=state.scenarioId ?? sandbox.id;
      if (id!==sandbox.id && !incidents.some(s=>s.id===id)) throw new Error('Unknown scenario');
      return { id, seed:state.seed, world:makeWorld(id,state.seed,state.topology as ScenarioTopology) };
    } catch { /* Invalid shared state falls back to the first incident. */ }
  }
  return { id:incidents[0].id as string, seed:73, world:makeWorld(incidents[0].id,73) };
}
export default function App() {
  const initial=useRef<ReturnType<typeof initialWorld> | null>(null);
  if (!initial.current) initial.current=initialWorld();
  const [id,setId]=useState<string>(initial.current.id);
  const [seed,setSeed]=useState(initial.current.seed);
  const [playing,setPlaying]=useState(true);
  const [speed,setSpeed]=useState(1);
  const world=useRef(initial.current.world);
  const [topology,setTopology]=useState(world.current.topology);
  const [snapshot,setSnapshot]=useState(world.current.simulator.getSnapshot());
  const [history,setHistory]=useState<TickSnapshot[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [sideCollapsed,setSideCollapsed]=useState(false);
  const [dockCollapsed,setDockCollapsed]=useState(false);
  const [brief,setBrief]=useState(false);
  const [postOpen,setPostOpen]=useState(false);
  const [resolved,setResolved]=useState(false);
  const [baselineMetrics,setBaselineMetrics]=useState<TickSnapshot | null>(null);
  const outage=useRef<{peak:TickSnapshot | null; maxP99:number; maxError:number; changed:boolean; resolved:boolean}>({peak:null,maxP99:0,maxError:0,changed:false,resolved:false});
  const baselineTopology=useRef(world.current.scenario?.topology??world.current.topology);
  const [resolution,setResolution]=useState<TickSnapshot | null>(null);
  const playingRef=useRef(playing); playingRef.current=playing;
  const speedRef=useRef(speed); speedRef.current=speed;
  const reset=useCallback((newId:string,newSeed:number)=>{
    world.current=makeWorld(newId,newSeed); setId(newId); setSeed(newSeed); setTopology(world.current.topology);
    setSnapshot(world.current.simulator.getSnapshot()); setHistory([]); setSelected(null);
    baselineTopology.current=world.current.scenario?.topology??world.current.topology;
    outage.current={peak:null,maxP99:0,maxError:0,changed:false,resolved:false};
    setBrief(false);setPostOpen(false);setResolved(false);setBaselineMetrics(null);setResolution(null);
  },[]);
  useEffect(()=>{
    let frame=0,last=performance.now(),acc=0;
    const loop=(now:number)=>{
      const elapsed=Math.min(now-last,250); last=now;
      if(playingRef.current){ acc+=elapsed*speedRef.current; if(acc>=100){const ticks=world.current.simulator.step(Math.floor(acc/100)*100); acc%=100; if(ticks.length){
        const scenario=world.current.scenario;
        for(const tick of ticks) {
          const tracker=outage.current;
          if(scenario && !tracker.changed) {
            tracker.peak=tick;
            tracker.maxP99=Math.max(tracker.maxP99,tick.global.p99);
            tracker.maxError=Math.max(tracker.maxError,tick.global.errorRate);
          }
          if(scenario && tracker.changed && !tracker.resolved && tick.sla && tick.sla.remainingPercent>0 &&
            tick.sla.healthyDurationMs>=scenario.slaTargets.holdDurationMs) {
            tracker.resolved=true;setResolved(true);setPostOpen(true);setResolution(tick);
          }
        }
        setSnapshot(ticks[ticks.length-1]);setHistory(h=>[...h,...ticks].slice(-600));
      }} }
      frame=requestAnimationFrame(loop);
    };
    frame=requestAnimationFrame(loop); return ()=>cancelAnimationFrame(frame);
  },[]);
  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;if(e.code==='Space'){e.preventDefault();setPlaying(p=>!p);}if(e.key.toLowerCase()==='r')reset(id,seed);};
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[id,seed,reset]);
  const update=(patch:NodeConfigPatch)=>{
    if(!selected)return;
    if (!outage.current.changed && outage.current.peak) {
      const peak=outage.current.peak;
      setBaselineMetrics({...peak,global:{...peak.global,p99:outage.current.maxP99,errorRate:outage.current.maxError}});
    }
    outage.current.changed=true;
    world.current.simulator.updateNodeConfig(selected,patch);
    setTopology(t=>({...t,nodes:t.nodes.map(n=>n.id===selected?{...n,...patch,
      retryPolicy:{...n.retryPolicy,...patch.retryPolicy},circuitBreaker:{...n.circuitBreaker,...patch.circuitBreaker},
      cache:{...n.cache,...patch.cache},rateLimiter:{...n.rateLimiter,...patch.rateLimiter},sharding:{...n.sharding,...patch.sharding},
      edgeCircuitBreakers:Object.fromEntries([...new Set([...Object.keys(n.edgeCircuitBreakers??{}),...Object.keys(patch.edgeCircuitBreakers??{})])].map(id=>[id,{...n.edgeCircuitBreakers?.[id],...patch.edgeCircuitBreakers?.[id]}]))}:n)}));
    setSnapshot(world.current.simulator.getSnapshot());
  };
  const scenario=world.current.scenario;
  return <div className="app">
    <TopControlBar id={id} onScenario={next=>reset(next,seed)} playing={playing} onPlay={()=>setPlaying(p=>!p)} speed={speed} onSpeed={setSpeed} seed={seed} onSeed={value=>reset(id,Number.isFinite(value)?value:0)} onReset={()=>reset(id,seed)} onBrief={()=>setBrief(true)} hasIncident={!!world.current.scenario} snapshot={snapshot}/>
    <div className="workspace"><main className="main"><div className="mission"><div><span className="incident-tag">{scenario?'● SEV-1 INCIDENT':'● SANDBOX'}</span><span className="mission-id">{scenario?'INCIDENT / '+String(incidents.findIndex(s=>s.id===id)+1).padStart(2,'0'):'FREE BUILD'}</span><h1>{scenario?.name??sandbox.name}</h1><p>{scenario?.symptomSummary??'Explore the starter topology and tune node configuration.'}</p></div><div className="mission-actions"><button onClick={()=>setBrief(true)} disabled={!scenario}>☷ &nbsp; Brief / Hints</button><button disabled title="Coming in Phase 5">⚡ &nbsp; Inject fault</button></div></div>
      {scenario && <div className={'resolution-banner '+(resolved?'resolved':'')}>{resolved?<button onClick={()=>setPostOpen(true)}>✓ Incident resolved · View post-mortem</button>:<>SLA HOLD <b>{Math.max(0,scenario.slaTargets.holdDurationMs-(snapshot.sla?.healthyDurationMs??0))/1000}s</b> · BUDGET <b>{snapshot.sla?.remainingPercent.toFixed(1)}%</b></>}</div>}
      <TopologyCanvas topology={topology} snapshot={snapshot} selected={selected} onSelect={setSelected}/>
      <TelemetryDock history={history} snapshot={snapshot} topology={topology} target={scenario?.slaTargets.p99LatencyMs} collapsed={dockCollapsed} toggle={()=>setDockCollapsed(v=>!v)}/>
    </main><NodeInspector edges={topology.edges} node={topology.nodes.find(n=>n.id===selected)} snapshot={snapshot} collapsed={sideCollapsed} toggle={()=>setSideCollapsed(v=>!v)} update={update}/></div>
    {brief&&scenario&&<IncidentBriefModal key={scenario.id} scenario={scenario} close={()=>setBrief(false)}/>}
    {postOpen&&scenario&&baselineMetrics&&resolution&&(()=>{
      const before={...baselineMetrics.global,remainingBudget:baselineMetrics.sla?.remainingPercent??0};
      const after={...resolution.global,remainingBudget:resolution.sla?.remainingPercent??0};
      const markdown=generatePostMortemMarkdown({title:scenario.name,symptoms:scenario.brief+' '+scenario.symptomSummary,before,after,baseline:baselineTopology.current,current:topology,takeaways:scenario.canonicalFixHints});
      const hash=encodeStateToHash({topology,seed,scenarioId:id});
      return <PostMortemModal markdown={markdown} pack={generateResiliencePack(topology)} shareUrl={window.location.href.split('#')[0]+hash} before={before} after={after} close={()=>setPostOpen(false)}/>;
    })()}
    <footer><span><i className="green"/> SIMULATION {playing?'RUNNING':'PAUSED'} <b>·</b> {speed}× SPEED</span><span className="footer-right">LOGICAL TIME &nbsp; <b>{(snapshot.nowMs/1000).toFixed(1)}s</b> &nbsp;&nbsp; <span>SPACE</span> pause &nbsp; <span>R</span> reset</span></footer>
  </div>;
}
