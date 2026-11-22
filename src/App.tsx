import { useCallback, useEffect, useRef, useState } from 'react';
import { createSimulator, type NodeConfigPatch, type TickSnapshot } from './engine/simulator';
import { incidents, sandbox } from './scenarios';
import type { ScenarioTopology } from './scenarios';
import type { NodeType } from './engine/types';
import { wouldCreateCycle } from './engine/topology';
import { node } from './scenarios/model';
import { ChaosToolbar } from './ui/components/ChaosToolbar';
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
  const [generation,setGeneration]=useState(0);
  const [history,setHistory]=useState<TickSnapshot[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [sideCollapsed,setSideCollapsed]=useState(false);
  const [dockCollapsed,setDockCollapsed]=useState(false);
  const [connectMode,setConnectMode]=useState(false);
  const [connectSource,setConnectSource]=useState<string|null>(null);
  const [toast,setToast]=useState('');
  const [sandboxExport,setSandboxExport]=useState(false);
  const faultSequence=useRef(0);
  const [brief,setBrief]=useState(false);
  const [postOpen,setPostOpen]=useState(false);
  const [resolved,setResolved]=useState(false);
  const [baselineMetrics,setBaselineMetrics]=useState<TickSnapshot | null>(null);
  const outage=useRef<{peak:TickSnapshot | null; maxP99:number; maxError:number; changed:boolean; resolved:boolean}>({peak:null,maxP99:0,maxError:0,changed:false,resolved:false});
  const baselineTopology=useRef(world.current.scenario?.topology??world.current.topology);
  const [resolution,setResolution]=useState<TickSnapshot | null>(null);
  const generationRef=useRef(0); generationRef.current=generation;
  const playingRef=useRef(playing); playingRef.current=playing;
  const speedRef=useRef(speed); speedRef.current=speed;
  const reset=useCallback((newId:string,newSeed:number)=>{
    world.current=makeWorld(newId,newSeed); setId(newId); setSeed(newSeed); setTopology(world.current.topology);
    setSnapshot(world.current.simulator.getSnapshot()); setHistory([]); setSelected(null);setGeneration(value=>value+1);
    baselineTopology.current=world.current.scenario?.topology??world.current.topology;
    outage.current={peak:null,maxP99:0,maxError:0,changed:false,resolved:false};
    setBrief(false);setPostOpen(false);setResolved(false);setBaselineMetrics(null);setResolution(null);setConnectMode(false);setConnectSource(null);setSandboxExport(false);
  },[]);
  useEffect(()=>{
    let frame=0,last=performance.now(),acc=0, seenGeneration=generationRef.current;
    const loop=(now:number)=>{
      const elapsed=Math.min(now-last,250); last=now;
      if(seenGeneration!==generationRef.current){acc=0;seenGeneration=generationRef.current;}
      if(playingRef.current){ acc+=elapsed*speedRef.current; if(acc>=100){const ticks=world.current.simulator.step(Math.floor(acc/100)*100); acc%=100; if(ticks.length){
        const scenario=world.current.scenario;
        for(const tick of ticks) {
          const tracker=outage.current;
          if(scenario && !tracker.resolved &&
            (tick.global.p99>scenario.slaTargets.p99LatencyMs ||
             tick.global.errorRate*100>scenario.slaTargets.maxErrorRatePct)) {
            tracker.peak=tick;
            tracker.maxP99=Math.max(tracker.maxP99,tick.global.p99);
            tracker.maxError=Math.max(tracker.maxError,tick.global.errorRate);
          }
          if(scenario && tracker.changed && tracker.peak && !tracker.resolved && tick.sla && tick.sla.remainingPercent>0 &&
            tick.sla.healthyDurationMs>=scenario.slaTargets.holdDurationMs) {
            tracker.resolved=true;
            setBaselineMetrics({...tracker.peak,global:{...tracker.peak.global,p99:tracker.maxP99,errorRate:tracker.maxError}});
            setResolved(true);setPostOpen(true);setResolution(tick);
          }
        }
        setSnapshot(ticks[ticks.length-1]);setHistory(h=>[...h,...ticks.map(tick=>({...tick,nodes:{},circuits:{},activeFaults:[],recentTraces:[],edgeTraversals:[]}))].slice(-600));
      }} }
      frame=requestAnimationFrame(loop);
    };
    frame=requestAnimationFrame(loop); return ()=>cancelAnimationFrame(frame);
  },[]);
  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{
      if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement||e.target instanceof HTMLElement&&e.target.isContentEditable)return;
      if(e.key==='Escape'){setBrief(false);setPostOpen(false);setSandboxExport(false);setConnectMode(false);setConnectSource(null);return;}
      if(e.code==='Space'){e.preventDefault();setPlaying(p=>!p);return;}
      if(e.key>='1'&&e.key<='5'){reset(incidents[Number(e.key)-1].id,seed);return;}
      if(e.key.toLowerCase()==='s'){reset(sandbox.id,seed);return;}
      if(e.key.toLowerCase()==='r'){
        if(id===sandbox.id){world.current=makeWorld(id,seed,topology);setSnapshot(world.current.simulator.getSnapshot());setHistory([]);setGeneration(value=>value+1);setSelected(null);setConnectMode(false);setConnectSource(null);setSandboxExport(false);}
        else reset(id,seed);
      }
    };
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[id,seed,reset,topology]);
  const update=(patch:NodeConfigPatch)=>{
    if(!selected)return;
    outage.current.changed=true;
    world.current.simulator.updateNodeConfig(selected,patch);
    setTopology(t=>({...t,nodes:t.nodes.map(n=>n.id===selected?{...n,...patch,
      retryPolicy:{...n.retryPolicy,...patch.retryPolicy},circuitBreaker:{...n.circuitBreaker,...patch.circuitBreaker},
      cache:{...n.cache,...patch.cache},rateLimiter:{...n.rateLimiter,...patch.rateLimiter},sharding:{...n.sharding,...patch.sharding},
      edgeCircuitBreakers:Object.fromEntries([...new Set([...Object.keys(n.edgeCircuitBreakers??{}),...Object.keys(patch.edgeCircuitBreakers??{})])].map(id=>[id,{...n.edgeCircuitBreakers?.[id],...patch.edgeCircuitBreakers?.[id]}]))}:n)}));
    setSnapshot(world.current.simulator.getSnapshot());
  };
  const rebuild=(next:ScenarioTopology)=>{
    world.current=makeWorld(sandbox.id,seed,next);
    setTopology(next);setSnapshot(world.current.simulator.getSnapshot());setHistory([]);setGeneration(value=>value+1);
  };
  const flash=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(''),2500);};
  const addNode=(type:NodeType)=>{
    const positions=[];
    for(let y=65;y<=495;y+=120) for(let x=80;x<=920;x+=165) positions.push({x,y});
    const pos=positions.find(p=>topology.nodes.every(n=>Math.abs(n.x-p.x)>=155||Math.abs(n.y-p.y)>=115));
    if(!pos){flash('No space available. Move nodes to make room.');return;}
    let index=1;while(topology.nodes.some(n=>n.id===`${type}-${index}`))index++;
    const id=`${type}-${index}`;
    rebuild({...topology,nodes:[...topology.nodes,node(id,`${type[0].toUpperCase()+type.slice(1)} ${index}`,type,pos.x,pos.y,type==='traffic'?{trafficRps:200}:{})]});
    setSelected(id);
  };
  const selectNode=(nodeId:string)=>{
    if(!connectMode){setSelected(nodeId);return;}
    if(!connectSource){setConnectSource(nodeId);setSelected(nodeId);return;}
    if(wouldCreateCycle(topology,connectSource,nodeId)){flash('Connection rejected: a cycle would be created.');setConnectSource(null);return;}
    if(topology.edges.some(e=>e.sourceNodeId===connectSource&&e.targetNodeId===nodeId)){flash('Connection already exists.');setConnectSource(null);return;}
    const edgeId=`${connectSource}->${nodeId}`;
    rebuild({...topology,edges:[...topology.edges,{id:edgeId,sourceNodeId:connectSource,targetNodeId:nodeId}]});
    setConnectSource(null);setSelected(nodeId);
  };
  const removeEdge=(edgeId:string)=>{
    const nodes=topology.nodes.map(n=>{if(!n.edgeCircuitBreakers?.[edgeId])return n;const entries={...n.edgeCircuitBreakers};delete entries[edgeId];return {...n,edgeCircuitBreakers:entries};});
    rebuild({...topology,nodes,edges:topology.edges.filter(e=>e.id!==edgeId)});
  };
  const removeNode=()=>{
    if(!selected)return;
    const removed=new Set(topology.edges.filter(e=>e.sourceNodeId===selected||e.targetNodeId===selected).map(e=>e.id));
    const nodes=topology.nodes.filter(n=>n.id!==selected).map(n=>{
      if(!n.edgeCircuitBreakers)return n;
      return {...n,edgeCircuitBreakers:Object.fromEntries(Object.entries(n.edgeCircuitBreakers).filter(([edgeId])=>!removed.has(edgeId)))};
    });
    rebuild({...topology,nodes,edges:topology.edges.filter(e=>!removed.has(e.id))});setSelected(null);setConnectSource(null);
  };
  const inject=(kind:string,target:string,parameters:Record<string,number>)=>{
    const simulator=world.current.simulator;
    simulator.injectFault({id:`manual-${++faultSequence.current}`,nodeId:target,kind,startMs:simulator.getSnapshot().nowMs,durationMs:60_000,parameters});
    setSnapshot(simulator.getSnapshot());
  };
  const clearFault=(faultId:string)=>{world.current.simulator.clearFault(faultId);setSnapshot(world.current.simulator.getSnapshot());};
  const shareUrl=()=>window.location.href.split('#')[0]+encodeStateToHash({topology,seed,scenarioId:id});
  const copyShare=async()=>{try{await navigator.clipboard.writeText(shareUrl());flash('Share URL copied.');}catch{flash('Copy failed. Open the resilience pack to select the URL.');setSandboxExport(true);}};
  const scenario=world.current.scenario;
  return <div className="app">
    <TopControlBar id={id} onScenario={next=>reset(next,seed)} playing={playing} onPlay={()=>setPlaying(p=>!p)} speed={speed} onSpeed={setSpeed} seed={seed} onSeed={value=>reset(id,Number.isFinite(value)?value:0)} onReset={()=>{if(id===sandbox.id){world.current=makeWorld(id,seed,topology);setSnapshot(world.current.simulator.getSnapshot());setHistory([]);setGeneration(value=>value+1);setSelected(null);setConnectMode(false);setConnectSource(null);setSandboxExport(false);}else reset(id,seed);}} onBrief={()=>setBrief(true)} hasIncident={!!world.current.scenario} snapshot={snapshot}/>
    <div className="workspace"><main className="main"><div className="mission"><div><span className="incident-tag">{scenario?'● SEV-1 INCIDENT':'● SANDBOX'}</span><span className="mission-id">{scenario?'INCIDENT / '+String(incidents.findIndex(s=>s.id===id)+1).padStart(2,'0'):'FREE BUILD'}</span><h1>{scenario?.name??sandbox.name}</h1><p>{scenario?.symptomSummary??'Explore the starter topology and tune node configuration.'}</p></div><div className="mission-actions"><button onClick={()=>setBrief(true)} disabled={!scenario}>☷ &nbsp; Brief / Hints</button>{!scenario&&<><button onClick={()=>setSandboxExport(true)}>Resilience pack</button><button onClick={copyShare}>Copy share URL</button></>}</div></div>
      {scenario && <div className={'resolution-banner '+(resolved?'resolved':'')}>{resolved?<button onClick={()=>setPostOpen(true)}>✓ Incident resolved · View post-mortem</button>:<>SLA HOLD <b>{Math.max(0,scenario.slaTargets.holdDurationMs-(snapshot.sla?.healthyDurationMs??0))/1000}s</b> · BUDGET <b>{snapshot.sla?.remainingPercent.toFixed(1)}%</b></>}</div>}
      <ChaosToolbar topology={topology} selected={selected} faults={snapshot.activeFaults} inject={inject} clear={clearFault}/>
      {!scenario&&<div className="sandbox-bar"><span>ADD NODE</span>{(['traffic','gateway','service','cache','database','queue','external'] as NodeType[]).map(type=><button key={type} onClick={()=>addNode(type)}>{type}</button>)}<button className={connectMode?'active':''} onClick={()=>{setConnectMode(!connectMode);setConnectSource(null);}}>{connectMode?(connectSource?'Choose target':'Choose source'):'Connect mode'}</button>{selected&&<button className="delete-node" onClick={removeNode}>Delete node</button>}</div>}
      {toast&&<div className="toast" role="status">{toast}</div>}
      <TopologyCanvas topology={topology} snapshot={snapshot} selected={selected} onSelect={selectNode} editable={!scenario} connectMode={connectMode} onMove={(nodeId,x,y)=>setTopology(t=>({...t,nodes:t.nodes.map(n=>n.id===nodeId?{...n,x,y}:n)}))}/>
      <TelemetryDock key={generation} history={history} snapshot={snapshot} topology={topology} target={scenario?.slaTargets.p99LatencyMs} collapsed={dockCollapsed} toggle={()=>setDockCollapsed(v=>!v)}/>
    </main><NodeInspector edges={topology.edges} node={topology.nodes.find(n=>n.id===selected)} snapshot={snapshot} collapsed={sideCollapsed} toggle={()=>setSideCollapsed(v=>!v)} update={update}/></div>
    {!scenario&&selected&&<div className="edge-editor"><b>Connections · {selected}</b>{topology.edges.filter(e=>e.sourceNodeId===selected||e.targetNodeId===selected).map(e=><button key={e.id} onClick={()=>removeEdge(e.id)} title="Disconnect edge">{e.sourceNodeId} → {e.targetNodeId} ×</button>)}</div>}
    {sandboxExport&&<div className="modal-backdrop" onClick={()=>setSandboxExport(false)}><section className="modal postmortem" role="dialog" aria-modal="true" aria-label="Sandbox resilience pack" onClick={e=>e.stopPropagation()}><div className="modal-head"><h2>Sandbox resilience pack</h2><button onClick={()=>setSandboxExport(false)}>×</button></div><p>Share URL</p><input className="share-input" readOnly value={shareUrl()}/><pre>{generateResiliencePack(topology)}</pre><button className="action-button" onClick={()=>navigator.clipboard.writeText(generateResiliencePack(topology)).then(()=>flash('Pack copied.')).catch(()=>flash('Copy failed.'))}>Copy pack</button></section></div>}
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
