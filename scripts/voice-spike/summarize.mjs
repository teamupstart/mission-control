import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function tokenWords(row) {
 const words=[];
 row.tokens.forEach((token,i)=>{
  const start=row.timestamps[i],end=start+row.durations[i];
  if (/^[ ▁]/.test(token)||words.length===0) words.push({word:token.trim().replace(/^▁/,''),startTime:start,endTime:end});
  else {words.at(-1).word+=token;words.at(-1).endTime=end;}
 });return words;
}
const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const corpus=JSON.parse(readFileSync('.tmp/voice-spike/audio/corpus.json','utf8'));
 for(const backend of ['fluid','fluid-boosted','sherpa','sherpa-hotwords','small']) {
  const path=`.tmp/voice-spike/${backend}-results.jsonl`;if(!existsSync(path))continue;
  const all=readFileSync(path,'utf8').trim().split('\n').filter(x=>x.includes('{')).map(x=>JSON.parse(x.slice(x.indexOf('{'))));
  const rows=all.filter(x=>x.id);if(!rows.length)continue;
  const names=rows.filter(x=>corpus.find(c=>c.id===x.id)?.name && !x.id.startsWith('gap-'));
  const gaps=rows.filter(x=>x.id.startsWith('gap-')||x.id.startsWith('continuous-')).map(x=>{
   const words=backend.startsWith('fluid')?x.words:tokenWords(x);
   return {id:x.id,text:x.text,gapMs:words.length>=2?(words[1].startTime-words[0].endTime)*1000:null};
  });
  console.log(JSON.stringify({backend,n:rows.length,load:all.find(x=>x.loadMs),nameCorrect:names.filter(x=>x.text.split(/\W/)[0].toLowerCase()===x.id.split('-')[0].toLowerCase()).length,nameTrials:names.length,p50Ms:quantile(rows.map(x=>x.ms),.5),p95Ms:quantile(rows.map(x=>x.ms),.95),durationBins:[2,4,6].map(seconds=>{const r=rows.filter(x=>corpus.find(c=>c.id===x.id)?.seconds===seconds);return {seconds,n:r.length,p50Ms:quantile(r.map(x=>x.ms),.5),p95Ms:quantile(r.map(x=>x.ms),.95)}}),peakRssBytes:Math.max(...rows.map(x=>x.rss??0)),gaps}));
 }
}
