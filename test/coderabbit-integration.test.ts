// Drive YAML/allowance precedence, typed tuning and pinned Git identity with no vendor calls.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defaultWorkflowCommandMaxRuns, emptyWorkflowCommandView, WORKFLOW_COMMAND_DEFAULT_TIMEOUT_MS, type CodeRabbitComparison } from "../src/shared/workflow.ts";
import type { RunCheckInput, CheckRunDeps } from "../src/server/workflows/checks.ts";
import { withProcessEnv } from "./helpers/process-env.ts";
const home=mkdtempSync(join(tmpdir(),"mc-cr-integration-"));process.env.MISSION_HOME=home;
after(()=>rmSync(home,{recursive:true,force:true}));
const { runCheck }=await import("../src/server/workflows/checks.ts");
const { codeRabbitReadiness, resolveCodeRabbitComparison }=await import("../src/server/workflows/coderabbit.ts");
const { parseCodeRabbitConfig }=await import("../src/server/workflows/coderabbit-config.ts");
const { WorkflowCommandArtifactService }=await import("../src/server/workflows/command-artifacts.ts");
const { WorkflowCommandManager }=await import("../src/server/workflows/commands.ts");
const { Registry }=await import("../src/server/registry.ts");
const { BUILTIN_WORKFLOWS }=await import("../src/server/workflows/builtin-workflows.ts");
const { stubRun }=await import("../src/server/util/exec.ts");
const { openDb }=await import("../src/server/db.ts");
const { ensureToken }=await import("../src/shared/harness-runtime.mjs");
const { WorkflowCheckOutcomeSchema }=await import("../src/shared/protocol.ts");
const enabled=parseCodeRabbitConfig(Buffer.from('reviews: {auto_review: {enabled: true}}'));
const comparison:CodeRabbitComparison={interpreterVersion:1,yaml:enabled,head:"a".repeat(40),baseTip:"b".repeat(40),mergeBase:"c".repeat(40),baseRef:"main",severity:"major",maxRuns:10,timeoutMs:2700000,ruleRevision:1,empty:false,error:null};
const summary={comparison,status:"complete" as const,counts:{critical:0,major:0,minor:1,trivial:0,info:0,none:0},titles:["minor advisory"],diagnostic:"Complete review"};
const input=():RunCheckInput=>({slot:"coderabbit",command:emptyWorkflowCommandView("coderabbit"),policy:{checksEnabled:true,repoAllowlist:["/repo"]},reserveRun:()=>({granted:true,spent:0}),cwd:"/repo",repoRoot:"/repo",headSha:comparison.head,coderabbit:{yaml:enabled,dirty:false,comparison:async()=>comparison}});
const deps=():CheckRunDeps=>({codeRabbitProbe:async()=>({command:"/fake/coderabbit",env:{HOME:home},error:null}),execute:async()=>({kind:"exited",exitCode:0,output:"",truncatedBytes:0,review:summary})});
test("the real CodeRabbit probe hands a scrubbed managed environment to the review child", async () => {
 const bin = join(home, "coderabbit-env-fixture");
 const log = join(home, "coderabbit-env-records.jsonl");
 const secretNames = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "INNOCENT", "QUOTING"];
 const names = [...secretNames,
  "HOME", "FLEET_HOME", "HARNESS_HOME", "HTTP_PROXY", "LANG", "CODERABBIT_CLI_DISABLE_AUTO_UPDATE", "CR_CLI_AUTH_TIMEOUT"];
 writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');
const names=${JSON.stringify(names)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(names.map(name=>[name,process.env[name]??null])),stateHome:process.env.MISSION_HOME??null,stateExists:!!process.env.MISSION_HOME&&fs.existsSync(process.env.MISSION_HOME)})+'\\n');
console.log(process.argv[2]==='--version'?'0.9.1':JSON.stringify({type:'status',authenticated:true}));\n`, { mode: 0o700 });
 const token = ensureToken();
 await withProcessEnv({ MISSION_CODERABBIT_BIN: bin, HOME: home, GITHUB_TOKEN: "fixture-github",
  ANTHROPIC_API_KEY: "fixture-anthropic", AWS_SECRET_ACCESS_KEY: "fixture-aws", INNOCENT: token,
  QUOTING: `Bearer ${token}`, FLEET_HOME: "/fixture-fleet", HARNESS_HOME: "/fixture-harness",
  HTTP_PROXY: "http://fixture-proxy.invalid", LANG: "en_US.UTF-8",
  CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "false", CR_CLI_AUTH_TIMEOUT: "99999" }, async () => {
  const result = await runCheck(input(), { execute: async request => {
   execFileSync(request.command[0]!, request.command.slice(1), { env: request.env, encoding: "utf8" });
   return { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0, review: summary };
  } });
  assert.equal(result.kind, "outcome");
 });
 const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
 assert.deepEqual(calls.map(call => call.args[0]), ["--version", "auth", "review"]);
 for (const call of calls) {
  for (const name of secretNames) assert.equal(call.env[name], null, `${name} reached ${call.args[0]}`);
  assert.equal(call.env.FLEET_HOME, null); assert.equal(call.env.HARNESS_HOME, null);
  assert.equal(call.env.HOME, home); assert.equal(call.env.HTTP_PROXY, "http://fixture-proxy.invalid");
  assert.equal(call.env.LANG, "en_US.UTF-8"); assert.equal(call.env.CODERABBIT_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(call.env.CR_CLI_AUTH_TIMEOUT, "5000");
 }
 assert.equal(calls[0].stateExists, true);
 assert.equal(calls[1].stateExists, true);
 assert.equal(calls[1].stateHome, calls[0].stateHome);
 assert.equal(existsSync(calls[0].stateHome), false, "probe state must be cleaned up");
 assert.equal(calls[2].stateHome, null, "the executor must not inherit the deleted probe home");
});
test("YAML true needs no catalog override and defaults to ten runs and 45 minutes",async()=>{
 const i=input();assert.equal(i.command!.maxRuns,10);assert.equal(i.command!.overrides.length,0);
 const d=deps();let called=0;d.execute=async(request)=>{called++;assert.equal(request.timeoutMs,2700000);assert.equal(request.headSha,comparison.head);assert.deepEqual(request.command,["/fake/coderabbit","review","--agent","--gate","major","--committed","--base-commit",comparison.mergeBase!]);return {kind:"exited",exitCode:0,output:"",truncatedBytes:0,review:summary};};
 const r=await runCheck(i,d);assert.equal(r.kind,"outcome");if(r.kind==="outcome"){assert.equal(r.outcome.status,"passed");assert.equal(r.outcome.review!.remainingRuns,9);}assert.equal(called,1);
});
test("eight long finding titles still produce a schema-valid outcome for Persona evidence",async()=>{
 const r=await runCheck(input(),{...deps(),execute:async()=>({kind:"exited",exitCode:2,output:"",truncatedBytes:0,
  review:{...summary,counts:{...summary.counts,major:8},titles:Array.from({length:8},(_,i)=>`${i}: ${"x".repeat(246)}`)}})});
 assert.equal(r.kind,"outcome");
 if(r.kind==="outcome")assert.equal(WorkflowCheckOutcomeSchema.safeParse(r.outcome).success,true);
});
test("skipped and blocked review summaries without a Command view use shared CodeRabbit defaults", async () => {
 for (const state of ["skipped", "blocked"] as const) {
  const i = input(); i.command = null;
  if (state === "skipped") i.coderabbit!.yaml = parseCodeRabbitConfig(Buffer.from(""));
  else i.policy.checksEnabled = false;
  const r = await runCheck(i, { codeRabbitProbe: async () => { throw new Error("must not probe"); },
   execute: async () => { throw new Error("must not execute"); } });
  const review = r.kind === "outcome" ? r.outcome.review : r.kind === "action_required" ? r.review : null;
  assert.ok(review);
  assert.equal(review.comparison.maxRuns, defaultWorkflowCommandMaxRuns("coderabbit"));
  assert.equal(review.comparison.timeoutMs, WORKFLOW_COMMAND_DEFAULT_TIMEOUT_MS.coderabbit);
  if (state === "skipped") {
   assert.equal(r.kind, "outcome"); assert.equal(review.status, "skipped");
  } else {
   assert.equal(r.kind, "action_required"); assert.equal(review.status, "incomplete");
   assert.equal(review.remainingRuns, defaultWorkflowCommandMaxRuns("coderabbit"));
  }
 }
});
test("missing/false/invalid YAML skip with warning before trust/budget/probe/execute; invalid exposes error",async()=>{
 for(const source of ["","reviews: {auto_review: {enabled: false}}","reviews: ["]) {
  const i=input();i.coderabbit!.yaml=parseCodeRabbitConfig(Buffer.from(source));i.policy.checksEnabled=false;i.reserveRun=()=>{throw new Error("must not reserve");};
  const r=await runCheck(i,{codeRabbitProbe:async()=>{throw new Error("must not probe");},execute:async()=>{throw new Error("must not execute");}});
  assert.equal(r.kind,"outcome");if(r.kind==="outcome"){assert.equal(r.outcome.status,"skipped");assert.ok(r.outcome.warning);if(source.endsWith("["))assert.ok(r.outcome.diagnosticError);}
 }
});
test("exhausted allowance skips before missing runtime/trust/tool, regardless of generic block policy",async()=>{
 const i=input();i.command!.onBudgetExhausted="block";i.policy.checksEnabled=false;i.reserveRun=()=>({granted:false,spent:10});
 const r=await runCheck(i,{codeRabbitProbe:async()=>{throw new Error("must not probe");}});assert.equal(r.kind,"outcome");if(r.kind==="outcome"){assert.equal(r.outcome.status,"budget_spent");assert.equal(r.outcome.review!.remainingRuns,0);assert.match(r.outcome.warning!,/10\/10/);}
});
for(const [name,change] of [
 ["missing tool",(i:RunCheckInput,d:CheckRunDeps)=>{d.codeRabbitProbe=async()=>({error:"CLI absent"});}],
 ["trust denied",(i:RunCheckInput)=>{i.policy.checksEnabled=false;}],
 ["dirty content",(i:RunCheckInput)=>{i.coderabbit!.dirty=true;}],
 ["uncommitted YAML",(i:RunCheckInput)=>{i.coderabbit!.yaml={...enabled,committed:false};}],
 ["ambiguous base",(i:RunCheckInput)=>{i.coderabbit!.comparison=async()=>({...comparison,error:"ambiguous base"});}],
 ["corrupt frozen comparison",(i:RunCheckInput)=>{i.coderabbit!.comparison=async()=>{throw new Error("corrupt comparison metadata");};}],
 ["incomplete review",(_i:RunCheckInput,d:CheckRunDeps)=>{d.execute=async()=>({kind:"exited",exitCode:1,output:"",truncatedBytes:0,review:{...summary,status:"incomplete"}});}],
 ["timeout or cancellation",(_i:RunCheckInput,d:CheckRunDeps)=>{d.execute=async()=>({kind:"infrastructure",reason:"timeout"});}],
] as const) test(`${name} blocks with visible error/Setup action, never a repair verdict`,async()=>{
 const i=input(),d=deps();change(i,d);const r=await runCheck(i,d);assert.equal(r.kind,"action_required");if(r.kind==="action_required"){assert.equal(r.setup,true);assert.match(r.reason,/Error:.*Settings > Setup/);}
});
test("prelaunch failures release allowance, completed findings fail and keep all artifacts",async()=>{
 const i=input();let releases=0;i.reserveRun=()=>({granted:true,spent:9,release:()=>{releases++;}});
 await runCheck(i,{...deps(),codeRabbitProbe:async()=>({error:"login required"})});assert.equal(releases,1);
 const r=await runCheck(i,{...deps(),execute:async()=>({kind:"exited",exitCode:2,output:"",truncatedBytes:99,review:{...summary,counts:{...summary.counts,major:1}}})});
 assert.equal(releases,1);assert.equal(r.kind,"outcome");if(r.kind==="outcome"){assert.equal(r.outcome.status,"failed");assert.equal(r.outcome.review!.remainingRuns,0);}
});
test("bounded readiness refuses old/missing/malformed/unauthenticated status and accepts official status shape",async()=>{
 for(const mode of ["old","failure","unknown","signed-out","ready"]) {
  const seen:string[][]=[];const result=await codeRabbitReadiness(async(args)=>{seen.push(args);return stubRun({code:mode==="failure"?1:0,stderr:"sensitive must not surface",stdout:args[0]==="--version" ? mode==="old"?"0.9.0":"0.9.1" : mode==="unknown"?"{}":JSON.stringify({type:"status",phase:"auth",authenticated:mode!=="signed-out"})});});
  assert.equal(result===null,mode==="ready");assert.ok(!result?.includes("sensitive"));assert.equal(seen.length,mode==="old"||mode==="failure"?1:2);
 }
});
function repo(name:string) {
 mkdirSync(join(home,name));const root=realpathSync(join(home,name));const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
 git("init","-q","-b","main");git("config","user.email","fixture@example.com");git("config","user.name","Fixture");git("config","commit.gpgsign","false");writeFileSync(join(root,"file"),`base ${name}`);git("add",".");git("commit","-qm","base");
 const base=git("rev-parse","HEAD");git("update-ref","refs/remotes/origin/main",base);git("symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/main");git("checkout","-qb","feature");writeFileSync(join(root,"file"),`changed ${name}`);git("commit","-qam","change");return{root,base,git};
}
test("observed default base and full head resolve in correct repo; retries freeze comparison across ref movement",async()=>{
 const first=repo("one"),second=repo("two");assert.notEqual(first.base,second.base);
 for(const f of [first,second]) {
  const command=emptyWorkflowCommandView("coderabbit");const c=await resolveCodeRabbitComparison({repoRoot:f.root,headSha:f.git("rev-parse","--short","HEAD"),yaml:enabled,command});
  assert.equal(c.head,f.git("rev-parse","HEAD"));assert.equal(c.baseTip,f.base);assert.equal(c.mergeBase,f.base);assert.equal(c.empty,false);
  // The engine regression separately pins durable retries; this boundary resolves new submissions.
  f.git("update-ref","refs/remotes/origin/main",c.head!);assert.equal(c.baseTip,f.base);
  const refreshed=await resolveCodeRabbitComparison({repoRoot:f.root,headSha:c.head,yaml:enabled,command});assert.equal(refreshed.empty,true);
 }
});
test("typed CAS tuning survives reload and legacy writes, removal returns to defaults; reject argv/subdirectory",()=>{
 const f=repo("catalog");const manager=new WorkflowCommandManager(new Registry());let view=manager.get("coderabbit")!;
 const saved=manager.replace("coderabbit",{expectedRevision:view.revision,defaultCommand:null,overrides:[{repoRoot:f.root,command:[],review:{kind:"coderabbit",baseRef:"main",severity:"minor"}}],maxRuns:10,timeoutMs:null,onUnavailable:"skip",onBudgetExhausted:"block"});assert.ok(saved.ok);
 view=manager.get("coderabbit")!;assert.equal(view.overrides[0]!.review!.severity,"minor");assert.equal(view.onUnavailable,"block");assert.equal(view.onBudgetExhausted,"skip");
 manager.saveLegacyConfig([],()=>{});assert.deepEqual(manager.get("coderabbit"),view);
 assert.equal(manager.replace("coderabbit",{...view,expectedRevision:view.revision,defaultCommand:["danger"]}).ok,false);
 mkdirSync(join(f.root,"nested"));assert.equal(manager.replace("coderabbit",{...view,expectedRevision:view.revision,overrides:[{...view.overrides[0]!,repoRoot:join(f.root,"nested")}]}).ok,false);
 assert.ok(manager.replace("coderabbit",{...view,expectedRevision:view.revision,overrides:[]}).ok);assert.equal(manager.get("coderabbit")!.overrides.length,0);
});
test("normalized findings use the existing quota and authenticated reader; raw clipping loses no semantic body",()=>{
 const service=new WorkflowCommandArtifactService(openDb(),join(home,"bodies"));const input={runId:"run",submissionId:"sub",attemptId:"attempt"};
 const capture=service.beginCapture({...input,semanticBytes:4*1024*1024});capture.push("stdout",Buffer.alloc(3*1024*1024,120));capture.finalize(true);
 const body=Buffer.from('{"id":"early finding","comment":"retained independently"}\n');const artifact=service.publishFindings(input,body,true);
 assert.equal(artifact.availability,"retained");assert.equal(artifact.droppedBytes,0);assert.equal(service.read({runId:"run",attemptId:"attempt",artifactId:artifact.id}).text,body.toString());
 assert.throws(()=>service.read({runId:"other",attemptId:"attempt",artifactId:artifact.id}),/No such/);
 const noReserve=service.publishFindings({runId:"run",submissionId:"sub",attemptId:"no-reservation"},body,true);assert.equal(noReserve.availability,"unavailable");
});
test("all 33 previously published versions retain exact hashes; only No-Mistakes appends the stage",()=>{
 const expected=JSON.parse(readFileSync(new URL("./fixtures/coderabbit-workflow-history.json",import.meta.url),"utf8"));
 for(const [id,hash] of Object.entries(expected)){const v=BUILTIN_WORKFLOWS.flatMap(w=>w.versions).find(v=>v.id===id)!;assert.equal(createHash("sha256").update(JSON.stringify(v)).digest("hex"),hash,id);}
 const noMistakes=BUILTIN_WORKFLOWS.find(w=>w.definition.id.includes("no-mistakes"))!;assert.equal(noMistakes.versions.length,22);
 const nodes=noMistakes.versions.at(-1)!.graph.nodes;assert.equal(nodes.filter(n=>n.kind==="check"&&n.slot==="coderabbit").length,1);
 for(const w of BUILTIN_WORKFLOWS.filter(w=>w!==noMistakes))assert.ok(!w.versions.some(v=>v.graph.nodes.some(n=>n.kind==="check"&&n.slot==="coderabbit")));
});
test("a known vendor wait blocks explicit retry without another probe or execution",async()=>{
 const i=input();i.coderabbit!.retryAt=Date.now()+120000;let releases=0;i.reserveRun=()=>({granted:true,spent:1,release:()=>{releases++;}});
 const r=await runCheck(i,{codeRabbitProbe:async()=>{throw new Error("must not probe during vendor wait");},execute:async()=>{throw new Error("must not execute");}});
 assert.equal(r.kind,"action_required");if(r.kind==="action_required")assert.match(r.reason,/vendor wait is active/);assert.equal(releases,1);
});
test("a runtime refusal proven before process start returns its allowance",async()=>{
 const i=input();let releases=0;i.reserveRun=()=>({granted:true,spent:0,release:()=>{releases++;}});
 const r=await runCheck(i,{...deps(),execute:async()=>({kind:"infrastructure",started:false,reason:"no lease could be acquired"})});
 assert.equal(r.kind,"action_required");assert.equal(releases,1);
});
test("unexpected comparison and executor failures log classified secret-free diagnostics",async(t)=>{
 const logs:string[]=[];t.mock.method(console,"error",(...args:unknown[])=>logs.push(args.join(" ")));
 for(const stage of ["comparison","execution"]){
  const i=input(),d=deps();const fail=async()=>{throw new SyntaxError("credential=fixture-secret corrupt metadata");};
  if(stage==="comparison")i.coderabbit!.comparison=fail;else d.execute=fail;
  const r=await runCheck(i,d);assert.equal(r.kind,"action_required");
  if(r.kind==="action_required")assert.doesNotMatch(r.reason,/fixture-secret/);
  assert.match(logs.at(-1)??"",new RegExp(`event=coderabbit_exception.*state=${stage}.*error=SyntaxError`));
 }
 assert.ok(logs.every(line=>line.length<=200&&!line.includes("fixture-secret")));
});

test("an executor exception cannot refund a review that may already have started",async()=>{
 const i=input();let releases=0;i.reserveRun=()=>({granted:true,spent:0,release:()=>{releases++;}});
 const r=await runCheck(i,{...deps(),execute:async()=>{throw new Error("metadata persistence failed after the child exited");}});
 assert.equal(r.kind,"action_required");assert.equal(releases,0);
});
test("pending semantic publication keeps its reserved quota across asynchronous lease settlement",()=>{
 const db=openDb(),service=new WorkflowCommandArtifactService(db,join(home,"semantic-quota"));
 const input={runId:"semantic-quota-run",submissionId:"semantic-quota-sub",attemptId:"semantic-pending"};
 const bytes=Buffer.alloc(2*1024*1024,120);
 const semantic=service.beginCapture({...input,semanticBytes:4*1024*1024});semantic.push("stdout",bytes);semantic.finalize(true);
 // Other nodes may run while lease settlement awaits. They must not steal this capacity.
 for(let n=0;n<29;n++){
  const c=service.beginCapture({...input,attemptId:`quota-fill-${n}`});c.push("stdout",bytes);c.finalize(true);
 }
 const refused=service.beginCapture({...input,attemptId:"quota-extra"});assert.equal(refused.capacity,0);refused.finalize(true);
 const findings=service.publishFindings(input,Buffer.alloc(4*1024*1024,120),true);assert.equal(findings.availability,"retained");
 const retained=db.prepare("SELECT SUM(retained_bytes) AS bytes FROM workflow_command_artifacts WHERE run_id = ?").get(input.runId) as {bytes:number};
 assert.equal(retained.bytes,64*1024*1024);
 const restarted=new WorkflowCommandArtifactService(db,join(home,"semantic-quota"));assert.equal(restarted.listForAttempt(input.attemptId).find(a=>a.kind==="findings")!.availability,"retained");
});
