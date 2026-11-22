import { useState } from 'react';
import type { Sev1Scenario } from '../../scenarios';

export function IncidentBriefModal({ scenario, close }: { scenario: Sev1Scenario; close: () => void }) {
  const [hints, setHints] = useState(0);
  return <div className="modal-backdrop" onClick={close}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="brief-title" onClick={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="incident-tag">● SEV-1 PAGER ALERT</span><h2 id="brief-title">{scenario.name}</h2></div><button onClick={close} aria-label="Close">×</button></div>
    <p>{scenario.brief}</p><h3>Symptoms</h3><p>{scenario.symptomSummary}</p>
    <div className="modal-sla"><span>P99 <b>{scenario.slaTargets.p99LatencyMs} ms</b></span><span>ERROR RATE <b>≤ {scenario.slaTargets.maxErrorRatePct}%</b></span><span>HOLD <b>{scenario.slaTargets.holdDurationMs/1000}s</b></span></div>
    <h3>Progressive hints</h3>{scenario.canonicalFixHints.slice(0,hints).map((hint,i)=><p className="hint" key={hint}><b>Hint {i+1}</b> {hint}</p>)}
    {hints<2&&<button className="action-button" onClick={()=>setHints(hints+1)}>Reveal hint {hints+1}</button>}
  </section></div>;
}
