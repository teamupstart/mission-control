import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";
import { WORKFLOW_EXECUTION_LIMITS, type WorkflowRunDetail } from "../../src/shared/workflow.ts";

async function api<T>(d:DaemonHandle,path:string,body?:unknown,method?:string):Promise<T>{
 const r=await fetch(`${d.baseURL}${path}`,{method:method??(body===undefined?"GET":"POST"),headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok)throw new Error(`${path}: ${r.status} ${await r.text()}`);return await r.json() as T;
}
function git(d:DaemonHandle,...args:string[]){return execFileSync("git",["-C",d.repo,...args],{encoding:"utf8"}).trim();}
function yaml(d:DaemonHandle,source:string|null){
 if(source!==null)writeFileSync(join(d.repo,".coderabbit.yaml"),source);
 git(d,"add",".");git(d,"-c","user.name=Fixture","-c","user.email=fixture@example.com","-c","commit.gpgsign=false","commit","--allow-empty","-qm","CodeRabbit fixture");
}
async function dispatch(page:Page,d:DaemonHandle){
 await page.getByRole("button",{name:"Dispatch"}).click();const dialog=page.getByRole("dialog",{name:"Dispatch an agent"});
 await dialog.getByPlaceholder("search repos or type a path…").fill(d.repo);await page.keyboard.press("Escape");
 await dialog.getByPlaceholder("What should this agent do?").fill("Hold the CodeRabbit workflow fixture");
 await dialog.locator("select").filter({hasText:"finish without a Workflow"}).selectOption("__none");
 await dialog.getByRole("button",{name:"Dispatch now"}).click();await expect(dialog).toBeHidden();
 let id="";await expect.poll(async()=>{const ss=await api<Array<{id:string;state:string}>>(d,"/api/sessions");const s=ss.find(s=>s.state!=="exited");id=s?.id??"";return s?.state;}).toBe("idle");return id;
}
async function start(page:Page,d:DaemonHandle, options:{group?:boolean;maxRuns?:number;checks?:boolean; builtIn?:boolean;version?:number}={}){
 const base=git(d,"rev-parse","HEAD~1");git(d,"update-ref","refs/remotes/origin/main",base);git(d,"symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/main");
 const sessionId=await dispatch(page,d);
 // Dispatch can lease a pre-existing branch. The submission must inspect that checkout,
 // so author the fixture configuration there, just as the owning session would.
 const session=(await api<Array<{id:string;cwd:string}>>(d,"/api/sessions")).find(s=>s.id===sessionId)!;
 let source:string|null=null;try{source=readFileSync(join(d.repo,".coderabbit.yaml"),"utf8");}catch{/* absent */}
 if(source!==null){
  writeFileSync(join(session.cwd,".coderabbit.yaml"),source);
  execFileSync("git",["-C",session.cwd,"add",".coderabbit.yaml"]);
  execFileSync("git",["-C",session.cwd,"-c","user.name=Fixture","-c","user.email=fixture@example.com","-c","commit.gpgsign=false","commit","--allow-empty","-qm","Captured CodeRabbit fixture"]);
 }

 await api(d,"/api/workflows/config",{liveEnabled:true,checksEnabled:options.checks??true,repoAllowlist:[d.repo],defaultWorkflowId:null,checkCommands:[]},"PUT");
 if(options.maxRuns){const command=await api<Record<string,unknown>>(d,"/api/workflow-commands/coderabbit");await api(d,"/api/workflow-commands/coderabbit",{...command,expectedRevision:command.revision,maxRuns:options.maxRuns},"PUT");}
 const nodes=[{id:"s",kind:"session",position:{x:0,y:0}},{id:"cr",kind:"check",slot:"coderabbit",position:{x:200,y:0}},{id:"e",kind:"end",outcome:"Approved",position:{x:600,y:0}}];
 const edges=[{id:"a",source:"s",sourcePort:"submitted",target:"cr",targetPort:"activate"},{id:"p",source:"cr",sourcePort:"pass",target:"e",targetPort:"terminal"},{id:"f",source:"cr",sourcePort:"fail",target:"s",targetPort:"return_for_changes"}];
 if(options.group){nodes.push({id:"cr2",kind:"check",slot:"coderabbit",position:{x:200,y:200}},{id:"join",kind:"all_pass",position:{x:400,y:100}} as never);
  edges[1].target="join";edges[1].targetPort="result";edges[2].target="join";edges[2].targetPort="result";
  edges.push({id:"a2",source:"s",sourcePort:"submitted",target:"cr2",targetPort:"activate"},{id:"p2",source:"cr2",sourcePort:"pass",target:"join",targetPort:"result"},{id:"f2",source:"cr2",sourcePort:"fail",target:"join",targetPort:"result"},{id:"jp",source:"join",sourcePort:"pass",target:"e",targetPort:"terminal"},{id:"jf",source:"join",sourcePort:"fail",target:"s",targetPort:"return_for_changes"});
 }
 let versionId:string;
 if(options.builtIn){const versions=await api<Array<{id:string}>>(d,"/api/workflows/builtin-workflow:no-mistakes-review/versions");versionId=options.version ? versions.find(v=>v.id.endsWith(`@${options.version}`))!.id : versions[0]!.id;}
 else {const w=await api<{workflow:{id:string}}>(d,"/api/workflows",{name:"Arbitrary CodeRabbit workflow",draft:{nodes,edges}});const p=await api<{version:{id:string}}>(d,`/api/workflows/${w.workflow.id}/publish`,{expectedDraftRevision:1});versionId=p.version.id;}
 const b=await api<{id:string}>(d,"/api/workflow-bindings",{workflowVersionId:versionId,sessionId,deliveryMode:"preview"});
 const r=await api<{run:{id:string}}>(d,`/api/workflow-bindings/${b.id}/submit`,{requestId:"cr-initial"});
 return {id:r.run.id,bindingId:b.id,sessionId,cwd:session.cwd};
}
const detail=(d:DaemonHandle,id:string)=>api<WorkflowRunDetail>(d,`/api/workflow-runs/${id}`);
async function shot(page:Page,name:string){if(!process.env.MC_E2E_EVIDENCE)return;const dir=artifactsDir("coderabbit-workflows");mkdirSync(dir,{recursive:true});await page.screenshot({path:`${dir}${name}.png`,fullPage:true});}

test("Library typed tuning saves, reloads and removes without changing YAML enablement; policies are derived",async({dashboard,daemon})=>{
 await dashboard.goto(`${daemon.baseURL}/#/library/commands/coderabbit`);
 await expect(dashboard.getByLabel("How often this Command may run")).toHaveValue("10");
 await expect(dashboard.getByLabel("If the command is unavailable")).toBeDisabled();
 await expect(dashboard.getByLabel("When the run budget is exhausted")).toBeDisabled();
 await expect(dashboard.getByRole("region",{name:"CodeRabbit tuning"})).toContainText("No Library override is required");
 await expect(dashboard.getByRole("main")).toContainText("completed review. Granting");
 await dashboard.getByLabel("Repository root for CodeRabbit tuning").fill(daemon.repo);await dashboard.keyboard.press("Escape");
 await dashboard.getByRole("button",{name:"Add repository tuning"}).click();
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).fill("main");await dashboard.getByLabel(`Severity for ${daemon.repo}`).selectOption("minor");
 await dashboard.getByRole("button",{name:"Save Command"}).click();await expect(dashboard.getByRole("button",{name:"Save Command"})).toBeDisabled();await dashboard.reload();
 await expect(dashboard.getByLabel(`Base ref for ${daemon.repo}`)).toHaveValue("main");await expect(dashboard.getByLabel(`Severity for ${daemon.repo}`)).toHaveValue("minor");
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).fill("temporary");
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).fill("main");
 await expect(dashboard.getByRole("button",{name:"Save Command"})).toBeDisabled();
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).scrollIntoViewIfNeeded();
 expect(await dashboard.locator(".wf-command-review-rule").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await shot(dashboard,"library-tuning");
 await dashboard.getByRole("button",{name:"Remove tuning"}).click();await dashboard.getByRole("button",{name:"Save Command"}).click();
 await expect.poll(async()=>((await api<{overrides:unknown[]}>(daemon,"/api/workflow-commands/coderabbit")).overrides.length)).toBe(0);
});

for(const [name,source] of [["missing",null],["false","reviews: {auto_review: {enabled: false}}"],["invalid","reviews: ["]] as const) test(`${name} YAML warns and skips in an arbitrary custom workflow`,async({dashboard,daemon})=>{
 yaml(daemon,source);const r=await start(dashboard,daemon);
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.find(a=>a.nodeId==="cr")?.output;}).toMatchObject({status:"skipped",warning:expect.any(String)});
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await expect(dashboard.getByRole("main")).toContainText("Warning:");
 if(name==="invalid")await expect(dashboard.getByRole("main")).toContainText("Error: Invalid CodeRabbit YAML");
 const log=readFileSync(join(daemon.recordDir,"coderabbit.jsonl"),"utf8");expect(log).not.toContain('"review"');await dashboard.locator(".wf-run-summary").filter({hasText:"Warning:"}).scrollIntoViewIfNeeded();await shot(dashboard,`yaml-${name}`);
});

test("YAML enabled without override executes, retains early/advisory findings beyond raw cap and presents repair reader",async({dashboard,daemon})=>{
 yaml(daemon,"reviews: {auto_review: {enabled: true}}");writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({mode:"findings",largeRaw:true}));
 const r=await start(dashboard,daemon);await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.find(a=>a.nodeId==="cr")?.output;},{timeout:60000}).toMatchObject({status:"failed",review:{counts:{major:1,minor:1}}});
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await expect(dashboard.getByRole("main")).toContainText("Early retained finding");
 await dashboard.getByRole("button",{name:/Load findings/}).click();await expect(dashboard.locator(".wf-run-command-artifact pre")).toContainText("Advisory retained finding");await shot(dashboard,"retained-findings");
 const d=await detail(daemon,r.id);const a=d.attempts.find(a=>a.nodeId==="cr")!;expect(JSON.stringify(a.verdict)).toContain("read_workflow_command_output");expect(JSON.stringify(a.verdict)).toContain("Verify each claim");
 const calls=readFileSync(join(daemon.recordDir,"coderabbit.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
 const review=calls.find(c=>c.args[0]==="review");expect(review.autoUpdate).toBe("true");expect(review.home).toBe(daemon.home);expect(review.args).not.toContain("--use-credits");expect(review.args).not.toContain("--api-key");
 // A repair submission refreshes YAML, while history retains the original enabled snapshot.
 writeFileSync(join(r.cwd,".coderabbit.yaml"),"reviews: {auto_review: {enabled: false}}\n");
 execFileSync("git",["-C",r.cwd,"add",".coderabbit.yaml"]);
 execFileSync("git",["-C",r.cwd,"-c","user.name=Fixture","-c","user.email=fixture@example.com","-c","commit.gpgsign=false","commit","-qm","Disable review in repair submission"]);
 await api(daemon,`/api/workflow-runs/${r.id}/resubmit`,{requestId:"yaml-repair-disabled"});
 await expect.poll(async()=>{const next=await detail(daemon,r.id);return next.attempts.filter(a=>a.nodeId==="cr").at(-1)?.output;},{timeout:60000}).toMatchObject({status:"skipped",review:{comparison:{yaml:{enabled:false}}}});
 const next=await detail(daemon,r.id);
 const retained=next.attempts.find(attempt=>attempt.id===a.id)!.output as {review:{comparison:{yaml:{enabled:boolean}}}};
 expect(retained.review.comparison.yaml.enabled).toBe(true);
 expect(readFileSync(join(daemon.recordDir,"coderabbit.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s)).filter(call=>call.args[0]==="review")).toHaveLength(1);

});

test("many findings keep the recorded outcome valid for downstream workflow evidence",async({dashboard,daemon})=>{
 yaml(daemon,"reviews: {auto_review: {enabled: true}}");
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({longTitles:true}));
 const r=await start(dashboard,daemon);
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.find(a=>a.nodeId==="cr")?.output;},{timeout:60000}).toMatchObject({status:"failed",review:{counts:{major:8}}});
 const d=await detail(daemon,r.id);const output=d.attempts.find(a=>a.nodeId==="cr")!.output as {note:string};
 expect(output.note.length).toBeLessThanOrEqual(WORKFLOW_EXECUTION_LIMITS.verdictSummary);
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await dashboard.getByRole("button",{name:/Load findings/}).click();
 await expect(dashboard.locator(".wf-run-command-artifact pre")).toContainText("Finding 8:");
});

test("enabled unavailable trust block links to Setup and shows version/auth diagnostics",async({dashboard,daemon})=>{
 yaml(daemon,"reviews: {auto_review: {enabled: true}}");writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({unauthenticated:true}));const r=await start(dashboard,daemon,{checks:false});
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.find(a=>a.nodeId==="cr")?.state;}).toBe("error");
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await dashboard.getByRole("link",{name:"Settings > Setup"}).click();
 await expect(dashboard).toHaveURL(/#\/settings\/setup/);await dashboard.getByRole("button",{name:/Agent extensions:/}).click();await expect(dashboard.getByRole("main")).toContainText("CodeRabbit CLI");await expect(dashboard.getByRole("main")).toContainText("authentication");await shot(dashboard,"setup-auth");
});

test("duplicate CodeRabbit nodes share one allowance and exhausted gate warns in a grouped stage",async({dashboard,daemon})=>{
 yaml(daemon,"reviews: {auto_review: {enabled: true}}");const r=await start(dashboard,daemon,{group:true,maxRuns:1});
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.filter(a=>a.nodeId==="cr"||a.nodeId==="cr2").map(a=>(a.output as {status?:string})?.status).sort();},{timeout:60000}).toEqual(["budget_spent","passed"]);
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await dashboard.getByRole("button",{name:/^Skipped Command · coderabbit/}).click();await expect(dashboard.getByRole("main")).toContainText("allowance exhausted");await dashboard.locator(".wf-run-summary").filter({hasText:"allowance exhausted"}).scrollIntoViewIfNeeded();await shot(dashboard,"shared-exhaustion");
});

test("incomplete vendor result blocks without repair and retains findings access",async({dashboard,daemon})=>{
 yaml(daemon,"reviews: {auto_review: {enabled: true}}");writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({mode:"incomplete",retryAfterSeconds:0}));const r=await start(dashboard,daemon);
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.find(a=>a.nodeId==="cr")?.state;},{timeout:60000}).toBe("error");
 const d=await detail(daemon,r.id);expect(d.attempts.find(a=>a.nodeId==="cr")!.verdict).toBeNull();
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await expect(dashboard.getByRole("link",{name:"Settings > Setup"})).toBeVisible();await expect(dashboard.getByRole("main")).toContainText("incomplete");await dashboard.getByRole("link",{name:"Settings > Setup"}).scrollIntoViewIfNeeded();await shot(dashboard,"incomplete-block");
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({mode:"clean"}));
 await dashboard.getByRole("button",{name:/Retry the failed call/}).click();
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.filter(a=>a.nodeId==="cr").at(-1)?.output;},{timeout:60000}).toMatchObject({status:"passed"});
 await expect(dashboard.getByRole("main")).toContainText("Complete CodeRabbit review");
});

test("a passing gate without an explicit coverage count remains incomplete", async ({ dashboard, daemon }) => {
 yaml(daemon, "reviews: {auto_review: {enabled: true}}");
 writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ omitCoverage: true }));
 const r = await start(dashboard, daemon);
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")?.state,
  { timeout: 60_000 }).toBe("error");
 const attempt = (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")!;
 expect(attempt.verdict).toBeNull();
 expect(attempt.output).toMatchObject({ review: { status: "incomplete" } });
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await expect(dashboard.getByRole("main")).toContainText("incomplete");
 await expect(dashboard.getByRole("link", { name: "Settings > Setup" })).toBeVisible();
 await dashboard.getByRole("link", { name: "Settings > Setup" }).scrollIntoViewIfNeeded();
 await shot(dashboard, "missing-coverage-incomplete-r2");
});


test("the new No-Mistakes stage uses YAML defaults without tuning",async({dashboard,daemon})=>{
 yaml(daemon,null);const r=await start(dashboard,daemon,{builtIn:true});
 // Exercise the shipped graph with its evidence policy intact. This fixture explicitly
 // continues past the unrelated evidence preflight using the operator control.
 await expect.poll(async()=>(await detail(daemon,r.id)).run.status,{timeout:60000}).toBe("waiting_for_evidence_readiness");
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await dashboard.getByRole("tab",{name:/^Evidence/}).click();
 await dashboard.getByRole("button",{name:"Continue to review"}).click();
 await expect.poll(async()=>{const d=await detail(daemon,r.id);return d.attempts.find(a=>a.nodeId==="nmr-check-coderabbit")?.output;},{timeout:60000}).toMatchObject({status:"skipped",warning:expect.any(String)});
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await dashboard.getByRole("tab",{name:/^Review worklist/}).click();await dashboard.getByRole("group",{name:"Worklist segment"}).getByRole("button",{name:/^Passed/}).click();await dashboard.getByRole("button",{name:/^Skipped Command · coderabbit/}).click();await expect(dashboard.getByRole("main")).toContainText("Root .coderabbit.yaml is missing");await dashboard.locator(".wf-run-summary").filter({hasText:"Root .coderabbit.yaml is missing"}).scrollIntoViewIfNeeded();await shot(dashboard,"no-mistakes-yaml-gate");
});

test("an existing binding stays on No-Mistakes version 21 and never gains CodeRabbit implicitly",async({dashboard,daemon})=>{
 yaml(daemon,null);const r=await start(dashboard,daemon,{builtIn:true,version:21});
 const binding=(await api<Array<{id:string;workflowVersionId:string}>>(daemon,"/api/workflow-bindings")).find(b=>b.id===r.bindingId)!;expect(binding.workflowVersionId).toBe("builtin-workflow:no-mistakes-review@21");
 const old=await api<{graph:{nodes:Array<{id:string}>}}>(daemon,"/api/workflows/builtin-workflow:no-mistakes-review/versions/21");expect(old.graph.nodes.some(n=>n.id==="nmr-check-coderabbit")).toBe(false);
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await expect(dashboard.getByRole("main")).toContainText("v21");
 expect((await detail(daemon,r.id)).run.workflowVersionId).toBe(binding.workflowVersionId);
});

test("Setup reports an old CLI and a corrected stored-auth state without starting a review",async({dashboard,daemon})=>{
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({old:true}));
 await dashboard.goto(`${daemon.baseURL}/#/settings/setup`);await dashboard.getByRole("button",{name:/Agent extensions:/}).click();await expect(dashboard.getByRole("main")).toContainText("CodeRabbit CLI >=0.9.1 is required");
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({unauthenticated:true}));
 await dashboard.getByRole("button",{name:/Re-check/}).click();await expect(dashboard.getByRole("main")).toContainText("stored authentication could not be confirmed");
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({}));await dashboard.getByRole("button",{name:/Re-check/}).click();
 await expect(dashboard.getByRole("main")).not.toContainText("stored authentication could not be confirmed");await expect(dashboard.getByRole("main")).toContainText("CodeRabbit 0.9.1; stored authentication ready");await shot(dashboard,"setup-ready");
 expect(readFileSync(join(daemon.recordDir,"coderabbit.jsonl"),"utf8")).not.toContain('"review"');
});

test("an arbitrary workflow's graph palette authors CodeRabbit and explains its YAML defaults",async({dashboard,daemon})=>{
 const w=await api<{workflow:{id:string}}>(daemon,"/api/workflows",{name:"CodeRabbit palette fixture"});
 await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${w.workflow.id}`);
 await dashboard.getByRole("button",{name:/^Graph/}).click();
 const palette=dashboard.getByRole("complementary",{name:"Workflow library and node palette"});
 await palette.getByLabel("Slot for new Command node").selectOption("coderabbit");
 await expect(palette).toContainText("without a Library override");await expect(palette).toContainText("incomplete review blocks");
 await palette.getByRole("button",{name:"＋ Command"}).click();await expect(dashboard.getByLabel("Workflow graph")).toContainText("Command · coderabbit");
 await expect.poll(async()=>{const d=await api<{workflow:{draft:{nodes:Array<{kind:string;slot?:string}>}}}>(daemon,`/api/workflows/${w.workflow.id}`);return d.workflow.draft.nodes.filter(n=>n.kind==="check").map(n=>n.slot);}).toEqual(["coderabbit"]);
 await shot(dashboard,"custom-graph-authoring");
});
