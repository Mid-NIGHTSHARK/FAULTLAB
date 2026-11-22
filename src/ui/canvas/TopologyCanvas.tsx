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
  const load = useRef(new Map<string, { ratio: number; queue: number; warning: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean; nodeId?: string } | null>(null);
  const fit = () => { view.current = { zoom: 1, x: 0, y: 0 }; };

  useEffect(() => { fit(); particles.current = []; load.current.clear(); seen.current = -1; }, [topology.id]);
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
      const newTick = snapshot.nowMs !== seen.current;
      if (snapshot.nowMs < seen.current) load.current.clear();
      if (newTick) {
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
        const direction = b.x < a.x ? -1 : 1;
        const x1 = a.x + 74*direction, x2 = b.x - 74*direction;
        ctx.beginPath(); ctx.moveTo(x1, a.y); ctx.bezierCurveTo((x1+x2)/2, a.y, (x1+x2)/2, b.y, x2, b.y);
        ctx.strokeStyle = snapshot.circuits[edge.id] === 'open' ? '#ef4444' : '#334155'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#94a3b8'; ctx.beginPath(); ctx.moveTo(x2, b.y); ctx.lineTo(x2-12*direction, b.y-6); ctx.lineTo(x2-12*direction, b.y+6); ctx.closePath(); ctx.fill();
      }
      particles.current = particles.current.filter((particle) => particle.progress < 1);
      for (const particle of particles.current) {
        const edge = topology.edges.find((item) => item.id === particle.edge); if (!edge) continue;
        const a = nodes.get(edge.sourceNodeId)!, b = nodes.get(edge.targetNodeId)!;
        particle.progress += elapsed * particle.speed;
        const direction = b.x < a.x ? -1 : 1;
        const t = Math.min(1, particle.progress), x1 = a.x+74*direction, x2 = b.x-74*direction, mid = (x1+x2)/2;
        const x = (1-t)**3*x1+3*(1-t)**2*t*mid+3*(1-t)*t*t*mid+t**3*x2;
        const y = (1-t)**3*a.y+3*(1-t)**2*t*a.y+3*(1-t)*t*t*b.y+t**3*b.y;
        ctx.fillStyle = particle.color; ctx.shadowColor = particle.color; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(x,y,3.5,0,Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
      }
      for (const node of topology.nodes) {
        const m = snapshot.nodes[node.id]; if (!m) continue;
        const capacity = Math.max(1, node.workerPoolCapacity * (node.type === 'database' ? node.sharding.shardCount : 1));
        const previousLoad = load.current.get(node.id) ?? { ratio: 0, queue: 0, warning: 0 };
        const decay = Math.exp(-elapsed / 0.45);
        const ratio = Math.max(m.activeWorkers/capacity, newTick ? m.peakUtilization : 0, previousLoad.ratio*decay);
        const queue = Math.max(m.queueDepth, newTick ? m.peakQueueDepth : 0, previousLoad.queue*decay);
        const warning = ratio > .75 ? 1 : Math.max(0, previousLoad.warning - elapsed);
        load.current.set(node.id, { ratio, queue, warning });
        const alert = m.errorRate > .02 ? '#ef4444' : warning > 0 ? '#f59e0b' : null;
        const color = alert ?? '#10b981';
        ctx.fillStyle = '#111827';
        ctx.strokeStyle = alert === '#f59e0b' ? `rgba(245,158,11,${warning})` : alert ?? (selected === node.id ? '#06b6d4' : '#334155');
        ctx.lineWidth = selected === node.id ? 3 : 1.5;
        if (alert) { ctx.shadowColor = alert; ctx.shadowBlur = 9; }
        ctx.beginPath(); ctx.roundRect(node.x-71,node.y-55,142,110,10); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = color; ctx.font = 'bold 11px monospace'; ctx.fillText(node.type.toUpperCase(),node.x-61,node.y-34);
        ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(node.name,node.x-61,node.y-10,122);
        ctx.fillStyle = '#94a3b8'; ctx.font = '10px monospace';
        ctx.fillText(`${m.activeWorkers}/${capacity} workers`,node.x-61,node.y+8);
        ctx.fillStyle = '#1e293b'; ctx.fillRect(node.x-61,node.y+31,122,4);
        ctx.fillStyle = color;
        const queueCapacity = node.maxQueueSize * (node.type === 'database' ? node.sharding.shardCount : 1);
        ctx.fillRect(node.x-61,node.y+31,122*Math.min(1,queue/Math.max(1,queueCapacity)),4);
        const extra = node.type === 'cache' ? `hit ${Math.round(m.cacheHitRate*100)}%` : `q ${Math.round(queue)}`;
        ctx.fillStyle = '#cbd5e1'; ctx.font = '9px monospace';
        ctx.fillText(`p99 ${Math.round(m.p99)}ms · err ${(m.errorRate*100).toFixed(1)}% · ${extra}`,node.x-61,node.y+47,122);
        ctx.beginPath(); ctx.strokeStyle = '#1F2937'; ctx.lineWidth = 3;
        ctx.arc(node.x+54,node.y-34,12,0,Math.PI*2); ctx.stroke();
        if (ratio > 0) {
          ctx.beginPath(); ctx.strokeStyle = color;
          ctx.arc(node.x+54,node.y-34,12,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.min(1,ratio)); ctx.stroke();
        }
        ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(ratio*100)}%`,node.x+54,node.y-34);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        if (m.circuitState !== 'closed') { ctx.fillStyle = '#ef4444'; ctx.font = 'bold 10px monospace'; ctx.fillText(m.circuitState.toUpperCase().replace('_','-'),node.x-61,node.y+23); }
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
        const hit=topology.nodes.find(n=>Math.abs(n.x-x)<71&&Math.abs(n.y-y)<55);
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
          const hit=topology.nodes.find(n=>Math.abs(n.x-x)<71&&Math.abs(n.y-y)<55);
          if(hit) onSelect(hit.id);
        }
        drag.current=null;
      }} />
    <div className="canvas-heading"><span className="eyebrow">LIVE TOPOLOGY</span><span>Request flow</span></div>
    <button className="fit-button" onClick={fit}>⊞ &nbsp; Fit view</button>
    <div className="canvas-legend"><span><i className="green"/>Healthy</span><span><i className="cyan"/>Cache</span><span><i className="violet"/>Retry</span><span><i className="amber"/>Rate Limited</span><span><i className="red"/>Error</span></div>
  </div>;
}
