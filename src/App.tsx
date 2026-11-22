import { useCallback, useEffect, useRef, useState } from 'react';
import { createSimulator, type NodeConfigPatch, type TickSnapshot } from './engine/simulator';
import { incidents, sandbox } from './scenarios';
import type { ScenarioTopology } from './scenarios';
import { TopologyCanvas } from './ui/canvas/TopologyCanvas';
import { TopControlBar } from './ui/components/TopControlBar';
import { NodeInspector } from './ui/components/NodeInspector';
import { TelemetryDock } from './ui/components/TelemetryDock';

function makeWorld(id:string,seed:number) {
  const scenario=incidents.find(item=>item.id===id);
  const topology:ScenarioTopology=scenario?.topology??sandbox;
  const simulator=createSimulator(topology,{seed,scenario});
  return {scenario,topology,simulator};
}
export default function App() {
  const [id,setId]=useState<string>(incidents[0].id);
  const [seed,setSeed]=useState(73);
  const [playing,setPlaying]=useState(true);
  const [speed,setSpeed]=useState(1);
  const world=useRef(makeWorld(incidents[0].id,73));
  const [topology,setTopology]=useState(world.current.topology);
  const [snapshot,setSnapshot]=useState(world.current.simulator.getSnapshot());
  const [history,setHistory]=useState<TickSnapshot[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [sideCollapsed,setSideCollapsed]=useState(false);
  const [dockCollapsed,setDockCollapsed]=useState(false);
  const playingRef=useRef(playing); playingRef.current=playing;
  const speedRef=useRef(speed); speedRef.current=speed;
  const reset=useCallback((newId:string,newSeed:number)=>{
    world.current=makeWorld(newId,newSeed); setId(newId); setSeed(newSeed); setTopology(world.current.topology);
    setSnapshot(world.current.simulator.getSnapshot()); setHistory([]); setSelected(null);
  },[]);
  useEffect(()=>{
    let frame=0,last=performance.now(),acc=0;
    const loop=(now:number)=>{
      const elapsed=Math.min(now-last,250); last=now;
      if(playingRef.current){ acc+=elapsed*speedRef.current; if(acc>=100){const ticks=world.current.simulator.step(Math.floor(acc/100)*100); acc%=100; if(ticks.length){setSnapshot(ticks[ticks.length-1]);setHistory(h=>[...h,...ticks].slice(-600));}} }
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
    world.current.simulator.updateNodeConfig(selected,patch);
    setTopology(t=>({...t,nodes:t.nodes.map(n=>n.id===selected?{...n,...patch,
      retryPolicy:{...n.retryPolicy,...patch.retryPolicy},circuitBreaker:{...n.circuitBreaker,...patch.circuitBreaker},
      cache:{...n.cache,...patch.cache},rateLimiter:{...n.rateLimiter,...patch.rateLimiter},sharding:{...n.sharding,...patch.sharding},
      edgeCircuitBreakers:Object.fromEntries([...new Set([...Object.keys(n.edgeCircuitBreakers??{}),...Object.keys(patch.edgeCircuitBreakers??{})])].map(id=>[id,{...n.edgeCircuitBreakers?.[id],...patch.edgeCircuitBreakers?.[id]}]))}:n)}));
    setSnapshot(world.current.simulator.getSnapshot());
  };
  const scenario=world.current.scenario;
  return <div className="app">
    <TopControlBar id={id} onScenario={next=>reset(next,seed)} playing={playing} onPlay={()=>setPlaying(p=>!p)} speed={speed} onSpeed={setSpeed} seed={seed} onSeed={value=>reset(id,Number.isFinite(value)?value:0)} onReset={()=>reset(id,seed)} snapshot={snapshot}/>
    <div className="workspace"><main className="main"><div className="mission"><div><span className="incident-tag">{scenario?'● SEV-1 INCIDENT':'● SANDBOX'}</span><span className="mission-id">{scenario?'INCIDENT / '+String(incidents.findIndex(s=>s.id===id)+1).padStart(2,'0'):'FREE BUILD'}</span><h1>{scenario?.name??sandbox.name}</h1><p>{scenario?.symptomSummary??'Explore the starter topology and tune node configuration.'}</p></div><div className="mission-actions"><button disabled title="Coming in Phase 5">☷ &nbsp; Incident brief</button><button disabled title="Coming in Phase 5">⚡ &nbsp; Inject fault</button></div></div>
      <TopologyCanvas topology={topology} snapshot={snapshot} selected={selected} onSelect={setSelected}/>
      <TelemetryDock history={history} snapshot={snapshot} topology={topology} target={scenario?.slaTargets.p99LatencyMs} collapsed={dockCollapsed} toggle={()=>setDockCollapsed(v=>!v)}/>
    </main><NodeInspector edges={topology.edges} node={topology.nodes.find(n=>n.id===selected)} snapshot={snapshot} collapsed={sideCollapsed} toggle={()=>setSideCollapsed(v=>!v)} update={update}/></div>
    <footer><span><i className="green"/> SIMULATION {playing?'RUNNING':'PAUSED'} <b>·</b> {speed}× SPEED</span><span className="footer-right">LOGICAL TIME &nbsp; <b>{(snapshot.nowMs/1000).toFixed(1)}s</b> &nbsp;&nbsp; <span>SPACE</span> pause &nbsp; <span>R</span> reset</span></footer>
  </div>;
}
