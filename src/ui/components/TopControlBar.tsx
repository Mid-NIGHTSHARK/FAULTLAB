import type { TickSnapshot } from '../../engine/simulator';
import { incidents, sandbox } from '../../scenarios';

interface Props {
  id: string; onScenario: (id: string) => void; playing: boolean; onPlay: () => void;
  speed: number; onSpeed: (speed: number) => void; seed: number; onSeed: (seed: number) => void;
  onReset: () => void; snapshot: TickSnapshot;
}
export function TopControlBar(p: Props) {
  return <header className="topbar">
    <div className="brand"><div className="brand-icon">◈</div><div><strong>FAULT<span>LAB</span></strong><small>MISSION CONTROL</small></div></div>
    <div className="scenario-select"><label htmlFor="scenario">ACTIVE SCENARIO</label><select id="scenario" value={p.id} onChange={e=>p.onScenario(e.target.value)}>{incidents.map((s,i)=><option value={s.id} key={s.id}>{String(i+1).padStart(2,'0')} · {s.name}</option>)}<option value={sandbox.id}>Free-Build Sandbox</option></select></div>
    <div className="controls"><button className="play" onClick={p.onPlay} title="Play or pause (Space)">{p.playing ? 'Ⅱ' : '▶'}</button><select aria-label="Simulation speed" value={p.speed} onChange={e=>p.onSpeed(Number(e.target.value))}><option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select><button title="Reset (R)" onClick={p.onReset}>↻</button><label className="seed">SEED <input aria-label="Seed" type="number" value={p.seed} onChange={e=>p.onSeed(Number(e.target.value))}/></label></div>
    <div className="top-metrics"><div><small>OFFERED RPS</small><b>{Math.round(p.snapshot.global.rps).toLocaleString()}</b></div><div><small>P99 LATENCY</small><b>{p.snapshot.global.p99.toFixed(0)} <em>ms</em></b></div><div><small>ERROR RATE</small><b className={p.snapshot.global.errorRate>.02?'danger':''}>{(p.snapshot.global.errorRate*100).toFixed(2)}<em>%</em></b></div></div>
    <div className="budget"><div><small>SLA ERROR BUDGET</small><b>{p.snapshot.sla ? p.snapshot.sla.remainingPercent.toFixed(1)+'%' : '—'}</b></div><div className="track"><span style={{width:`${p.snapshot.sla?.remainingPercent ?? 0}%`}} /></div><small>{p.snapshot.sla ? 'REMAINING' : 'SANDBOX'}</small></div>
  </header>;
}
