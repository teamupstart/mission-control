import { readFileSync, existsSync } from 'node:fs';
const root='.tmp/voice-spike/';
const names=['Steve','Will','Luna','Atlas','Nova','Jordan','Quinn','Sage','Phoenix','Rowan'];
const inDomain=r=>r.answer?.choice==='not sure'||(r.kind==='option'?['Postgres','SQLite'].includes(r.answer?.choice):r.answer?.choice.split('+').length<=2&&r.answer.choice.split('+').every(name=>names.includes(name)));
const q=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]??null;
for(const backend of ['haiku','luna']) for(const suffix of ['', '-policy']) {
 const file=root+`routing-${backend}${suffix}.jsonl`; if(!existsSync(file))continue;
 const rows=readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
 const valid=r=>!r.error&&r.exitCode===0&&typeof r.answer?.choice==='string'&&Number.isFinite(r.answer.confidence)&&r.answer.confidence>=0&&r.answer.confidence<=1;
 const good=rows.filter(valid),latencies=rows.map(r=>r.ms),apis=rows.map(r=>r.apiMs).filter(Number.isFinite);
 const thresholds=[.8,.9,.95,.98,.99,1].map(threshold=>{
  const accepted=good.filter(r=>inDomain(r)&&r.answer.confidence>=threshold&&r.answer.choice!=='not sure');
  return {threshold,accepted:accepted.length,wrong:accepted.filter(r=>!r.correct).length,abstained:rows.length-accepted.length};
 });
 console.log(JSON.stringify({backend,policy:!!suffix,n:rows.length,uniqueCases:new Set(rows.map(r=>r.id)).size,valid:good.length,inDomain:good.filter(inDomain).length,correct:good.filter(r=>r.correct).length,p50Ms:q(latencies,.5),p95Ms:q(latencies,.95),maxMs:q(latencies,1),apiP50Ms:q(apis,.5),apiP95Ms:q(apis,.95),thinkingTokensObserved:[...new Set(rows.map(r=>r.thinkingTokens).filter(Number.isFinite))],categories:['plain','phonetic','split','mention','option'].map(kind=>{const r=rows.filter(x=>x.kind===kind);return {kind,n:r.length,valid:r.filter(valid).length,correct:r.filter(x=>valid(x)&&x.correct).length}}),thresholds,failures:rows.filter(r=>!valid(r)||!r.correct).map(r=>({id:r.id,expected:r.expected,answer:r.answer,error:r.error}))}));
}
for(const prestartMs of [0,2000]) {
 const rows=[];
 for(const trial of [1,2,3]) {
  const path=root+`stream-${prestartMs}-${trial}.jsonl`;if(!existsSync(path))continue;
  rows.push(...readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(r=>r.event==='result'));
 }
 if(rows.length) console.log(JSON.stringify({experiment:'one-shot-prestart',prestartMs,n:rows.length,successes:rows.filter(r=>r.subtype==='success'&&r.result==='alpha').length,sendP50Ms:q(rows.map(r=>r.sinceSendMs),.5),spawnP50Ms:q(rows.map(r=>r.sinceSpawnMs),.5),trials:rows.map(r=>({sendMs:r.sinceSendMs,spawnMs:r.sinceSpawnMs,apiMs:r.apiMs}))}));
}
