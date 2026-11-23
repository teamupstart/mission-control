// Tool-free synthetic benchmark. Run only with operator approval for provider usage.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const backend = process.argv[2] ?? 'haiku';
if (!['haiku','luna'].includes(backend)) throw Error('Expected haiku or luna');
const cases = JSON.parse(readFileSync('scripts/voice-spike/routing-cases.json','utf8'));
const policy = process.argv.includes("--policy");
const schemaPath = resolve("scripts/voice-spike/routing-schema.json");
const schema = readFileSync(schemaPath,"utf8");
let system = 'Route a voice utterance. Return ONLY JSON {"choice":string,"confidence":number}. Invented roster: Steve build engineer; Will frontend; Luna tests; Atlas architecture; Nova releases; Jordan product; Quinn security; Sage docs; Phoenix operations; Rowan performance. A phonetic name means its roster spelling. Two separate commands to two agents means choice "First+Second"; a mention in one command stays with the first agent. For option questions the options are Postgres (recommended, relational server) and SQLite (embedded file); return the option or "not sure". Confidence is 0 to 1. No tools.';
if(policy) system += ' The explicitly addressed name ALWAYS outranks its role. Never substitute a different agent because a task seems better suited to its role. A phonetic match also outranks role. A mention such as ask Luna stays addressed to the first agent. Only split when each named agent is directly given a separate command. Do not explain or include reasoning in the response.';
mkdirSync('.tmp/voice-spike',{recursive:true});
const dest=resolve(`.tmp/voice-spike/routing-${backend}${policy?"-policy":""}.jsonl`);
for (const row of cases.slice(Number(process.env.SPIKE_START ?? 0),Number(process.env.SPIKE_LIMIT ?? 60))) {
 const start=performance.now();
 const input = (row.kind === "option" ? "Open options card reply: " : "Utterance: ") + row.text;
 const args=backend==='haiku' ? ['-p','--model','claude-haiku-4-5','--output-format','json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--setting-sources','','--settings','{"alwaysThinkingEnabled":false,"disableAllHooks":true}','--system-prompt',system,input] : ['exec','--ephemeral','--ignore-user-config','--ignore-rules','-c','approval_policy="never"','--skip-git-repo-check','--sandbox','read-only','--json','-m','gpt-6-luna','-c','model_reasoning_effort="none"','-c','features.shell_tool=false','-c','features.unified_exec=false',system+'\n'+input];
 if(policy) {
  const extra=backend==='haiku'?['--json-schema',schema]:['--output-schema',schemaPath];
  args.splice(args.length-1,0,...extra);
 }
 const env={...process.env,MAX_THINKING_TOKENS:'0'}; delete env.CLAUDECODE;
 const child=spawn(backend==='haiku'?'claude':'codex',args,{cwd:'/private/tmp',env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr=''; child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const exitCode=await new Promise((yes,no)=>{child.on('error',no);child.on('close',yes)});clearTimeout(timer);
 let answer=null,apiMs=null,error=null,thinkingTokens=null,rawText=null;
 try {
  if(backend==='haiku'){const parsed=JSON.parse(stdout);apiMs=parsed.duration_api_ms;thinkingTokens=parsed.usage?.output_tokens_details?.thinking_tokens??null;rawText=parsed.result;answer=policy?parsed.structured_output:JSON.parse(parsed.result.replace(/^```json\s*|\s*```$/g,''));apiMs=parsed.duration_api_ms;}
  else {const frames=stdout.trim().split('\n').map(s=>JSON.parse(s));const last=frames.findLast(x=>x.type==='item.completed'&&x.item?.type==='agent_message'); rawText=last.item.text;answer=JSON.parse(last.item.text.replace(/^```json\s*|\s*```$/g,''));}
  if(!answer || typeof answer.choice !== 'string' || !Number.isFinite(answer.confidence) || answer.confidence<0 || answer.confidence>1) throw Error('Invalid response schema');
 } catch(e){error=e.message;}
 const result={id:row.id,kind:row.kind,expected:row.expected,answer,correct:answer?.choice===row.expected,ms:performance.now()-start,apiMs,exitCode,error,thinkingTokens,rawText,policy};
 appendFileSync(dest,JSON.stringify(result)+'\n');console.log(JSON.stringify(result));
 if(error){appendFileSync(dest+'.errors',JSON.stringify({id:row.id,rawText,stderr})+'\n'); if(exitCode!==0) break;}
}
