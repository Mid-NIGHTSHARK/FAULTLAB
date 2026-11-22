import { useEffect, useRef } from 'react';
import type { TickSnapshot } from '../../engine/simulator';
import type { ScenarioTopology } from '../../scenarios';

interface Particle { edge: string; progress: number; speed: number; color: string }
interface Props {
  topology: ScenarioTopology;
  snapshot: TickSnapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  editable?: boolean;
  connectMode?: boolean;
  onMove?: (id:string,x:number,y:number)=>void;
}

function geometry(rect: DOMRect, topology: ScenarioTopology, zoom: number) {
  const xs=topology.nodes.map(node=>node.x), ys=topology.nodes.map(node=>node.y);
  const minX=xs.length?Math.min(...xs):0, maxX=xs.length?Math.max(...xs):1000;
  const minY=ys.length?Math.min(...ys):0, maxY=ys.length?Math.max(...ys):560;
  const centerX=(minX+maxX)/2, centerY=(minY+maxY)/2;
  const scale=Math.max(0.01,Math.min((rect.width-80)/Math.max(250,maxX-minX+180),
    (rect.height-80)/Math.max(200,maxY-minY+150),1.2))*zoom;
  return {scale,centerX,centerY};
}

export function TopologyCanvas({ topology, snapshot, selected, onSelect, editable, connectMode, onMove }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ topology, snapshot, selected, onSelect });
  latest.current = { topology, snapshot, selected, onSelect };
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const particles = useRef<Particle[]>([]);
  const seen = useRef(-1);
  const drag = useRef<{ x: number; y: number; moved: boolean; nodeId?: string } | null>(null);
  const fit = () => { view.current = { zoom: 1, x: 0, y: 0 }; };

  useEffect(() => { fit(); particles.current = []; seen.current = -1; }, [topology.id]);
  useEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext('2d')!;
    let frame = 0;
    let previous = performance.now();
    function draw(time: number) {
      const { topology, snapshot, selected } = latest.current;
      const rect = element.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (element.width !== Math.round(rect.width * dpr) || element.height !== Math.round(rect.height * dpr)) {
        element.width = Math.round(rect.width * dpr); element.height = Math.round(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const {scale,centerX,centerY} = geometry(rect,topology,view.current.zoom);
      const ox = rect.width / 2 - centerX * scale + view.current.x;
      const oy = rect.height / 2 - centerY * scale + view.current.y;
      ctx.translate(ox, oy); ctx.scale(scale, scale);
      const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
      if (snapshot.nowMs !== seen.current) {
        seen.current = snapshot.nowMs;
        for (const event of snapshot.edgeTraversals) {
          if (particles.current.length >= 250) break;
          const target = topology.edges.find((edge) => edge.id === event.edgeId)?.targetNodeId;
          const metric = target ? snapshot.nodes[target] : undefined;
          particles.current.push({ edge: event.edgeId, progress: 0, speed: 1 / Math.max(0.35, Math.min(2, (metric?.p95 ?? 50) / 100)),
            color: {ok:'#10B981',cache_hit:'#06B6D4',retry:'#A855F7',rate_limited:'#F59E0B',error:'#EF4444'}[event.outcome] });
        }
      }
      const elapsed = Math.min((time - previous) / 1000, 0.05); previous = time;
      for (const edge of topology.edges) {
        const a = nodes.get(edge.sourceNodeId)!; const b = nodes.get(edge.targetNodeId)!;
        const x1 = a.x + 77, x2 = b.x - 77;
        ctx.beginPath(); ctx.moveTo(x1, a.y); ctx.bezierCurveTo((x1+x2)/2, a.y, (x1+x2)/2, b.y, x2, b.y);
        ctx.strokeStyle = snapshot.circuits[edge.id] === 'open' ? '#ef4444' : '#334155'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.moveTo(x2, b.y); ctx.lineTo(x2-9, b.y-5); ctx.lineTo(x2-9, b.y+5); ctx.fill();
      }
      particles.current = particles.current.filter((particle) => particle.progress < 1);
      for (const particle of particles.current) {
        const edge = topology.edges.find((item) => item.id === particle.edge); if (!edge) continue;
        const a = nodes.get(edge.sourceNodeId)!, b = nodes.get(edge.targetNodeId)!;
        particle.progress += elapsed * particle.speed;
        const t = Math.min(1, particle.progress), x1 = a.x+77, x2 = b.x-77, mid = (x1+x2)/2;
        const x = (1-t)**3*x1+3*(1-t)**2*t*mid+3*(1-t)*t*t*mid+t**3*x2;
        const y = (1-t)**3*a.y+3*(1-t)**2*t*a.y+3*(1-t)*t*t*b.y+t**3*b.y;
        ctx.fillStyle = particle.color; ctx.shadowColor = particle.color; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(x,y,3.5,0,Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
      }
      for (const node of topology.nodes) {
        const m = snapshot.nodes[node.id]; if (!m) continue;
        const capacity = Math.max(1, node.workerPoolCapacity * (node.type === 'database' ? node.sharding.shardCount : 1));
        const ratio = Math.min(1,m.activeWorkers/capacity);
        const color = m.errorRate > .05 ? '#ef4444' : ratio > .8 ? '#f59e0b' : '#10b981';
        ctx.fillStyle = '#111827'; ctx.strokeStyle = selected === node.id ? '#06b6d4' : '#334155'; ctx.lineWidth = selected === node.id ? 3 : 1.5;
        ctx.beginPath(); ctx.roundRect(node.x-76,node.y-55,152,110,10); ctx.fill(); ctx.stroke();
        ctx.fillStyle = color; ctx.font = 'bold 11px monospace'; ctx.fillText(node.type.toUpperCase(),node.x-62,node.y-34);
        ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(node.name.slice(0,19),node.x-62,node.y-10);
        ctx.fillStyle = '#94a3b8'; ctx.font = '11px monospace'; ctx.fillText(`${m.activeWorkers}/${capacity} workers`,node.x-62,node.y+13);
        ctx.fillStyle = '#1e293b'; ctx.fillRect(node.x-62,node.y+27,124,5); ctx.fillStyle = color; ctx.fillRect(node.x-62,node.y+27,124*Math.min(1,m.queueDepth/Math.max(1,node.maxQueueSize)),5);
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.arc(node.x+57,node.y-34,7,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(.04,ratio)); ctx.stroke();
        if (m.circuitState !== 'closed') { ctx.fillStyle = '#ef4444'; ctx.font = 'bold 10px monospace'; ctx.fillText(m.circuitState.toUpperCase().replace('_','-'),node.x-62,node.y+47); }
      }
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div className="canvas-wrap">
    <canvas ref={canvas} aria-label="Interactive service topology" onWheel={(e) => { e.preventDefault(); view.current.zoom = Math.max(.45,Math.min(2.5,view.current.zoom * (e.deltaY > 0 ? .9 : 1.1))); }}
      onPointerDown={(e) => {
        const rect=e.currentTarget.getBoundingClientRect();
        const {scale,centerX,centerY}=geometry(rect,topology,view.current.zoom);
        const x=(e.clientX-rect.left-rect.width/2-view.current.x)/scale+centerX;
        const y=(e.clientY-rect.top-rect.height/2-view.current.y)/scale+centerY;
        const hit=topology.nodes.find(n=>Math.abs(n.x-x)<76&&Math.abs(n.y-y)<55);
        drag.current={x:e.clientX,y:e.clientY,moved:false,nodeId:editable&&!connectMode?hit?.id:undefined};
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx=e.clientX-drag.current.x,dy=e.clientY-drag.current.y;
        if (Math.abs(dx)+Math.abs(dy)>1) drag.current.moved=true;
        if(drag.current.nodeId && onMove) {
          const rect=e.currentTarget.getBoundingClientRect();
          const {scale}=geometry(rect,topology,view.current.zoom);
          const node=topology.nodes.find(n=>n.id===drag.current?.nodeId);
          if(node) onMove(node.id,Math.max(76,Math.min(924,node.x+dx/scale)),Math.max(55,Math.min(505,node.y+dy/scale)));
        } else {view.current.x+=dx;view.current.y+=dy;}
        drag.current.x=e.clientX;drag.current.y=e.clientY;
      }}
      onPointerUp={(e) => {
        if (drag.current && !drag.current.moved) {
          const rect=e.currentTarget.getBoundingClientRect();
          const {scale,centerX,centerY}=geometry(rect,topology,view.current.zoom);
          const x=(e.clientX-rect.left-rect.width/2-view.current.x)/scale+centerX;
          const y=(e.clientY-rect.top-rect.height/2-view.current.y)/scale+centerY;
          const hit=topology.nodes.find(n=>Math.abs(n.x-x)<76&&Math.abs(n.y-y)<55);
          if(hit) onSelect(hit.id);
        }
        drag.current=null;
      }} />
    <div className="canvas-heading"><span className="eyebrow">LIVE TOPOLOGY</span><span>Request flow</span></div>
    <button className="fit-button" onClick={fit}>⊞ &nbsp; Fit view</button>
    <div className="canvas-legend"><span><i className="green"/>Healthy</span><span><i className="cyan"/>Cache</span><span><i className="violet"/>Retry</span><span><i className="red"/>Error</span></div>
  </div>;
}
