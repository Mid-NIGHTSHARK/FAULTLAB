import { useState } from 'react';

interface Props { resolved?: boolean; markdown: string; pack: string; shareUrl: string; before: {p99:number;errorRate:number}; after:{p99:number;errorRate:number}; close:()=>void }
export function PostMortemModal({resolved=true,markdown,pack,shareUrl,before,after,close}:Props) {
  const [tab,setTab]=useState<'markdown'|'pack'>('markdown');
  const [feedback,setFeedback]=useState('');
  const copy=async(text:string,label:string)=>{try{await navigator.clipboard.writeText(text);setFeedback(label+' copied');}catch{setFeedback('Copy failed. Select and copy the text below.');}};
  const download=()=>{const url=URL.createObjectURL(new Blob([markdown],{type:'text/markdown'}));const a=document.createElement('a');a.href=url;a.download='faultlab-post-mortem.md';a.click();URL.revokeObjectURL(url);};
  return <div className="modal-backdrop" onClick={close}><section className="modal postmortem" role="dialog" aria-modal="true" aria-labelledby="post-title" onClick={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className={resolved?"resolved-label":"eyebrow"}>{resolved?"● INCIDENT RESOLVED":"INCIDENT IN PROGRESS · CURRENT TELEMETRY"}</span><h2 id="post-title">{resolved?"Post-Mortem":"Export / Share"}</h2></div><button onClick={close} aria-label="Close">×</button></div>
    <div className="modal-sla"><span>P99 <b>{before.p99.toFixed(1)} → {after.p99.toFixed(1)} ms</b></span><span>ERROR RATE <b>{(before.errorRate*100).toFixed(2)}% → {(after.errorRate*100).toFixed(2)}%</b></span></div>
    <div className="modal-tabs"><button className={tab==='markdown'?'active':''} onClick={()=>setTab('markdown')}>Post-Mortem (Markdown)</button><button className={tab==='pack'?'active':''} onClick={()=>setTab('pack')}>Resilience Pack</button></div>
    <pre>{tab==='markdown'?markdown:pack}</pre>
    <div className="modal-actions"><button onClick={()=>copy(markdown,'Markdown')}>Copy Markdown</button><button onClick={download}>Download .md</button><button onClick={()=>copy(shareUrl,'Share URL')}>Copy Share URL</button><button onClick={()=>copy(pack,'Resilience pack')}>Copy Pack</button><span role="status">{feedback}</span></div>
  </section></div>;
}
