// Run only with the same operator approval as routing.mjs. Two synthetic turns, no tools.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const delayMs=Number(process.env.SPIKE_PRESTART_MS??2000);
const turns=Number(process.env.SPIKE_TURNS??2);
if(!Number.isFinite(delayMs)||delayMs<0||![1,2].includes(turns)) throw Error('Invalid experiment settings');
const start=performance.now(),session=randomUUID();
const child=spawn('claude',['-p','--model','claude-haiku-4-5','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--setting-sources','','--settings','{"alwaysThinkingEnabled":false,"disableAllHooks":true}','--system-prompt','Return only the requested word.'],{cwd:'/private/tmp',env:{...process.env,CLAUDECODE:'',MAX_THINKING_TOKENS:'0'}});
let pending='',sent=0,sendAt=0;
function send(){sendAt=performance.now();sent++;child.stdin.write(JSON.stringify({type:'user',session_id:session,message:{role:'user',content:sent===1?'Say alpha':'Say beta'},parent_tool_use_id:null})+'\n');}
const warm=setTimeout(send,delayMs);
child.stdout.on('data',chunk=>{
 pending+=chunk;
 while(pending.includes('\n')){
  const n=pending.indexOf('\n'),line=pending.slice(0,n);pending=pending.slice(n+1);
  let frame;try{frame=JSON.parse(line);}catch{continue;}
  if(frame.type==='system') console.log(JSON.stringify({event:'system',subtype:frame.subtype,sinceSpawnMs:performance.now()-start}));
  if(frame.type==='result'){
   console.log(JSON.stringify({event:'result',prestartMs:delayMs,turn:sent,sinceSpawnMs:performance.now()-start,sinceSendMs:performance.now()-sendAt,result:frame.result,subtype:frame.subtype,apiMs:frame.duration_api_ms,errors:frame.errors,usage:frame.usage}));
   if(sent<turns) send();else child.stdin.end();
  }
 }
});
child.stderr.on('data',s=>process.stderr.write(s));
const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
child.on('close',code=>{clearTimeout(timer);clearTimeout(warm);console.log(JSON.stringify({event:'exit',code}));process.exitCode=code??1;});
