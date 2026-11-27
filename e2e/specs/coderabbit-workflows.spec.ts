import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";
import { WORKFLOW_EXECUTION_LIMITS, type WorkflowCommandView, type WorkflowRunDetail } from "../../src/shared/workflow.ts";

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
async function start(page:Page,d:DaemonHandle, options:{group?:boolean;maxRuns?:number;checks?:boolean; builtIn?:boolean;version?:number;missingBase?:boolean}={}){
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
 // Dispatch can refresh the observed default while preparing its worktree.
 if(options.missingBase)git(d,"symbolic-ref","--delete","refs/remotes/origin/HEAD");

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
async function shot(page:Page,name:string){if(!process.env.MC_E2E_EVIDENCE)return;const dir=artifactsDir("coderabbit-workflows");mkdirSync(dir,{recursive:true});await page.screenshot({path:`${dir}${name}.png`,fullPage:true,mask:[page.locator(".wf-run-worklist-row-line").filter({hasText:/^\/(?:Users|home|private|tmp)\//})]});}

test.describe("pooled CodeRabbit cleanup", () => {
 test.use({ daemonEnv: {
  MC_E2E_GIT_CHECK_HAND_BACK_TIMEOUT: "1",
  MISSION_WORKTREE_SWEEP_MS: "30000",
  MISSION_WORKFLOW_SWEEP_MS: "1000",
 } });

 test("reclaims a hand-back after a 30-second network probe timeout", async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  yaml(daemon, "reviews: {}");
  writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ mode: "findings", findingsOnFirstReview: true }));
  const { id } = await start(dashboard, daemon, { maxRuns: 1 });
  await expect.poll(async () => (await detail(daemon, id)).run.currentPhase,
   { timeout: 90_000 }).toBe("check_cleanup_unresolved");
  const blocked = await detail(daemon, id);
  const first = blocked.attempts.find(a => a.nodeId === "cr")!;
  expect(first.verdict).toBeNull();
  expect(first.output).toMatchObject({ review: { status: "incomplete", remainingRuns: 1 } });
  expect(first.error).toContain("exited 2");
  const timeout = "network probe timeout: git ls-remote --symref origin HEAD timed out after 30 s";
  expect(first.error).toContain(timeout);
  expect(first.error).not.toContain("Settings > Setup");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${id}`);
  await expect(dashboard.getByRole("main")).toContainText("Mission Control retries worktree cleanup automatically");
  await expect(dashboard.getByRole("main")).toContainText("No action needed");
  await expect(dashboard.getByRole("link", { name: "Settings > Setup" })).toHaveCount(0);
  await shot(dashboard, "hand-back-blocked");
  const diagnostic = dashboard.getByText(timeout).first();
  await expect(diagnostic).toBeVisible();
  await diagnostic.scrollIntoViewIfNeeded();
  await shot(dashboard, "hand-back-diagnostic");
  await expect.poll(async () => (await detail(daemon, id)).run.status, { timeout: 150_000 }).toBe("completed");
  const after = await detail(daemon, id);
  expect(after.submissions.map(s => s.id)).toEqual(blocked.submissions.map(s => s.id));
  expect(after.events.filter(event => event.kind === "check_cleanup_resolved")).toHaveLength(1);
  expect(after.events.some(event => event.kind === "command_action_required")).toBe(false);
  const attempts = after.attempts.filter(a => a.nodeId === "cr");
  expect(attempts).toHaveLength(2);
  expect(attempts.at(-1)?.output).toMatchObject({ status: "passed", review: { remainingRuns: 0 } });
  const review = dashboard.getByText(/Complete CodeRabbit review/).first();
  await expect(review).toBeVisible();
  await review.scrollIntoViewIfNeeded();
  await shot(dashboard, "hand-back-recovered");
 });
});

test("Library typed tuning saves, reloads and removes without changing YAML enablement; policies are derived",async({dashboard,daemon})=>{
 yaml(daemon, "reviews: {}");
 await dashboard.goto(`${daemon.baseURL}/#/library/commands/coderabbit`);
 await expect(dashboard.getByLabel("How often this Command may run")).toHaveValue("10");
 await expect(dashboard.getByLabel("If the command is unavailable")).toBeDisabled();
 await expect(dashboard.getByLabel("When the run budget is exhausted")).toBeDisabled();
 await expect(dashboard.getByRole("region",{name:"CodeRabbit tuning"})).toContainText("unless the YAML turns it off");
 const defaultCommand = dashboard.getByLabel("Default CodeRabbit command");
 await expect(defaultCommand).toHaveAttribute("placeholder", "coderabbit review --deep");
 const allowanceHelp = dashboard.locator(".wf-command-budget")
  .filter({ hasText: "Reported infrastructure failures return their slot." });
 await expect(allowanceHelp).toContainText("CodeRabbit skips with a warning unless a review is still incomplete.");
 await expect(allowanceHelp).toContainText("An incomplete review blocks the run. Raise the allowance and submit a new round to continue.");
 await expect(allowanceHelp).toContainText("Retrying the same submission uses its original allowance.");
 if (process.env.MC_E2E_EVIDENCE) {
  const dir = artifactsDir("coderabbit-workflows");
  mkdirSync(dir, { recursive: true });
  await allowanceHelp.screenshot({ path: `${dir}library-allowance.png` });
 }
 await defaultCommand.fill("coderabbit review --fresh");
 await dashboard.getByLabel("Repository root for CodeRabbit tuning").fill(daemon.repo);await dashboard.keyboard.press("Escape");
 await dashboard.getByRole("button",{name:"Add repository tuning"}).click();
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).fill("main");await dashboard.getByLabel(`Severity for ${daemon.repo}`).selectOption("minor");
 const repoCommand = dashboard.getByLabel(`CodeRabbit command for ${daemon.repo}`);
 await expect(repoCommand).toHaveAttribute("placeholder", "coderabbit review --fresh");
 await repoCommand.fill("coderabbit review --use-credits");
 await dashboard.getByRole("button",{name:"Save Command"}).click();
 await expect(dashboard.getByRole("alert")).toContainText("Mission Control adds the workflow review flags");
 await repoCommand.fill("coderabbit review");
 await dashboard.getByRole("button",{name:"Save Command"}).click();await expect(dashboard.getByRole("button",{name:"Save Command"})).toBeDisabled();await dashboard.reload();
 await expect(dashboard.getByLabel(`Base ref for ${daemon.repo}`)).toHaveValue("main");await expect(dashboard.getByLabel(`Severity for ${daemon.repo}`)).toHaveValue("minor");
 await expect(defaultCommand).toHaveValue("coderabbit review --fresh");
 await expect(repoCommand).toHaveValue("coderabbit review");
 await expect(dashboard.locator(".wf-command-review-rule .wf-command-preview")).toContainText("coderabbit review --agent --gate minor --committed");
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).fill("temporary");
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).fill("main");
 await expect(dashboard.getByRole("button",{name:"Save Command"})).toBeDisabled();
 await dashboard.getByLabel(`Base ref for ${daemon.repo}`).scrollIntoViewIfNeeded();
 expect(await dashboard.locator(".wf-command-review-rule").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 if (process.env.MC_E2E_EVIDENCE) {
  const dir = artifactsDir("coderabbit-workflows");
  mkdirSync(dir, { recursive: true });
  await dashboard.getByRole("region", { name: "CodeRabbit tuning" }).screenshot({ path: `${dir}library-tuning.png` });
 }
 await dashboard.goto(`${daemon.baseURL}/#/fleet`);
 const run = await start(dashboard, daemon);
 await expect.poll(async () => (await detail(daemon, run.id)).attempts.find(a => a.nodeId === "cr")?.output).toMatchObject({ status: "passed" });
 const calls = readFileSync(join(daemon.recordDir, "coderabbit.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
 const review = calls.find(call => call.args[0] === "review");
 expect(review.args).toEqual(["review", "--agent", "--gate", "minor", "--committed", "--base-commit", expect.stringMatching(/^[a-f0-9]{40}$/)]);
 await dashboard.goto(`${daemon.baseURL}/#/library/commands/coderabbit`);
 await dashboard.getByRole("button",{name:"Remove tuning"}).click();await dashboard.getByRole("button",{name:"Save Command"}).click();
 await expect.poll(async()=>((await api<{overrides:unknown[]}>(daemon,"/api/workflow-commands/coderabbit")).overrides.length)).toBe(0);
});

test("clearing only the repository CodeRabbit command inherits the default after reload", async ({ dashboard, daemon }) => {
 const endpoint = "/api/workflow-commands/coderabbit";
 const command = await api<WorkflowCommandView>(daemon, endpoint);
 await api(daemon, endpoint, {
  ...command,
  expectedRevision: command.revision,
  defaultCommand: ["coderabbit", "review", "--fresh"],
  overrides: [{
   repoRoot: daemon.repo,
   command: [],
   review: { kind: "coderabbit", baseRef: "main", severity: "minor", command: ["coderabbit", "review", "--deep"] },
  }],
 }, "PUT");

 await dashboard.goto(`${daemon.baseURL}/#/library/commands/coderabbit`);
 const repositoryCommand = dashboard.getByLabel(`CodeRabbit command for ${daemon.repo}`);
 const save = dashboard.getByRole("button", { name: "Save Command" });
 await expect(repositoryCommand).toHaveValue("coderabbit review --deep");
 await repositoryCommand.clear();
 await save.click();
 await expect(save).toBeDisabled();
 await dashboard.reload();

 await expect(repositoryCommand).toHaveValue("");
 await expect(dashboard.getByLabel(`Base ref for ${daemon.repo}`)).toHaveValue("main");
 await expect(dashboard.getByLabel(`Severity for ${daemon.repo}`)).toHaveValue("minor");
 await expect(dashboard.locator(".wf-command-review-rule .wf-command-preview")).toContainText(
  'coderabbit review --fresh --agent --gate minor --committed --base-commit "<merge-base of main>"',
 );
 if (process.env.MC_E2E_EVIDENCE) {
  const dir = artifactsDir("coderabbit-workflows");
  mkdirSync(dir, { recursive: true });
  await dashboard.getByRole("region", { name: "CodeRabbit tuning" }).screenshot({ path: `${dir}library-inherited-command.png` });
 }
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
 const review=calls.find(c=>c.args[0]==="review");expect(review.autoUpdate).toBe("true");expect(review.home).toBe(daemon.home);expect(review.args).toContain("--deep");expect(review.args).not.toContain("--use-credits");expect(review.args).not.toContain("--api-key");
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
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 const notice = dashboard.getByRole("region", { name: "Rounds" }).getByRole("status")
  .filter({ hasText: "CodeRabbit review skipped because the run allowance is exhausted." });
 await expect(notice).toBeVisible();
 await notice.scrollIntoViewIfNeeded();
 await expect(notice).toBeInViewport();
 await shot(dashboard, "round-allowance-warning");
 await dashboard.getByRole("button",{name:/^Skipped Command · coderabbit/}).click();await expect(dashboard.getByRole("main")).toContainText("allowance exhausted");await dashboard.locator(".wf-run-summary").filter({hasText:"allowance exhausted"}).scrollIntoViewIfNeeded();await shot(dashboard,"shared-exhaustion");
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

test("Retry resolves a corrected comparison on the same submission without spending failed preflight allowance", async ({ dashboard, daemon }) => {
 yaml(daemon, "reviews: {auto_review: {enabled: true}}");
 const r = await start(dashboard, daemon, { missingBase: true });
 await expect.poll(async () => (await detail(daemon, r.id)).run.status, { timeout: 60_000 }).toBe("blocked");
 const before = await detail(daemon, r.id);
 const failed = before.attempts.find(a => a.nodeId === "cr")!;
 expect(failed.state).toBe("error");
 expect(failed.output).toMatchObject({ review: { comparison: { error: expect.stringContaining("explicit baseRef") } } });
 expect(readFileSync(join(daemon.recordDir, "coderabbit.jsonl"), "utf8")).not.toContain('"review"');
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await expect(dashboard.getByRole("main")).toContainText("explicit baseRef");
 await expect(dashboard.getByRole("main")).toContainText("then retry");
 await shot(dashboard, "comparison-retry-blocked");
 git(daemon, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
 await dashboard.getByRole("button", { name: /Retry the failed call/ }).click();
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.filter(a => a.nodeId === "cr").at(-1)?.output,
  { timeout: 60_000 }).toMatchObject({ status: "passed", review: { remainingRuns: 9, comparison: { error: null } } });
 const after = await detail(daemon, r.id);
 expect(after.submissions.map(s => s.id)).toEqual(before.submissions.map(s => s.id));
 expect(after.attempts.find(a => a.id === failed.id)!.output).toEqual(failed.output);
 await expect(dashboard.getByRole("main")).toContainText("Complete CodeRabbit review");
 await shot(dashboard, "comparison-retry-recovered");
 const calls = readFileSync(join(daemon.recordDir, "coderabbit.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
 expect(calls.filter(c => c.args[0] === "review")).toHaveLength(1);
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
 await expect(dashboard.getByRole("main")).toContainText("CodeRabbit completion reported no review coverage");
 // The CLI is installed and signed in, so Setup would show nothing wrong. Point at the output.
 await expect(dashboard.getByRole("main")).toContainText("Inspect this attempt's retained CodeRabbit output");
 await expect(dashboard.getByRole("link", { name: "Settings > Setup" })).toHaveCount(0);
 await dashboard.getByText(/Inspect this attempt's retained CodeRabbit output/).first().scrollIntoViewIfNeeded();
 await shot(dashboard, "missing-coverage-incomplete-r2");
});

test("a CLI 0.9.2 completion that lists reviewed files passes when it covers the pinned comparison", async ({ dashboard, daemon }) => {
 yaml(daemon, "reviews: {auto_review: {enabled: true}}");
 writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ reviewedFiles: "all" }));
 const r = await start(dashboard, daemon);
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")?.output,
  { timeout: 60_000 }).toMatchObject({ status: "passed", review: { status: "complete", remainingRuns: 9 } });
 expect((await detail(daemon, r.id)).run.status).toBe("completed");
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await expect(dashboard.getByRole("main")).toContainText("Complete CodeRabbit review: 0 findings");
 const rounds = dashboard.getByRole("region", { name: "Rounds" });
 await expect(rounds).toBeVisible();
 await expect(rounds.getByText("CodeRabbit review skipped because the run allowance is exhausted.", { exact: true })).toHaveCount(0);
 await expect(dashboard.getByRole("main")).not.toContainText("Invalid CodeRabbit completion/gate");
 await shot(dashboard, "reviewed-files-complete");
});

test("a CLI 0.9.2 completion that skipped a changed file blocks with its coverage gap, not a Setup link", async ({ dashboard, daemon }) => {
 yaml(daemon, "reviews: {auto_review: {enabled: true}}");
 writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ reviewedFiles: "missing-one" }));
 const r = await start(dashboard, daemon);
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")?.state,
  { timeout: 60_000 }).toBe("error");
 const attempt = (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")!;
 expect(attempt.verdict).toBeNull();
 expect(attempt.output).toMatchObject({ review: { status: "incomplete" } });
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await expect(dashboard.getByRole("main")).toContainText(/CodeRabbit review coverage disagrees with the pinned comparison: 1 of \d+ changed files not reviewed/);
 await expect(dashboard.getByRole("link", { name: "Settings > Setup" })).toHaveCount(0);
 await dashboard.getByText(/Inspect this attempt's retained CodeRabbit output/).first().scrollIntoViewIfNeeded();
 await shot(dashboard, "reviewed-files-gap");
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
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await dashboard.getByRole("tab",{name:/^Review worklist/}).click();await dashboard.getByRole("group",{name:"Worklist segment"}).getByRole("button",{name:/^Passed/}).click();await dashboard.getByRole("button",{name:/^Skipped Command · coderabbit/}).click();await expect(dashboard.getByRole("main")).toContainText("Neither root .coderabbit.yaml nor .coderabbit.config.ts exists");await dashboard.locator(".wf-run-summary").filter({hasText:"Neither root .coderabbit.yaml nor .coderabbit.config.ts exists"}).scrollIntoViewIfNeeded();await shot(dashboard,"no-mistakes-yaml-gate");
});

test("No-Mistakes runs its enabled CodeRabbit stage with --deep by default", async ({ dashboard, daemon }) => {
 yaml(daemon, "reviews: {}");
 const run = await start(dashboard, daemon, { builtIn: true });
 await expect.poll(async () => (await detail(daemon, run.id)).run.status).toBe("waiting_for_evidence_readiness");
 await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
 await dashboard.getByRole("tab", { name: /^Evidence/ }).click();
 await dashboard.getByRole("button", { name: "Continue to review" }).click();
 await expect.poll(async () => (await detail(daemon, run.id)).attempts.find(a => a.nodeId === "nmr-check-coderabbit")?.output,
  { timeout: 60_000 }).toMatchObject({ status: "passed", command: expect.arrayContaining(["--deep", "--agent", "--committed"]) });
});

test("an existing binding stays on No-Mistakes version 21 and never gains CodeRabbit implicitly",async({dashboard,daemon})=>{
 yaml(daemon,"reviews: {auto_review: {enabled: true}}");const r=await start(dashboard,daemon,{builtIn:true,version:21});
 const binding=(await api<Array<{id:string;workflowVersionId:string}>>(daemon,"/api/workflow-bindings")).find(b=>b.id===r.bindingId)!;expect(binding.workflowVersionId).toBe("builtin-workflow:no-mistakes-review@21");
 const old=await api<{graph:{nodes:Array<{id:string}>}}>(daemon,"/api/workflows/builtin-workflow:no-mistakes-review/versions/21");expect(old.graph.nodes.some(n=>n.id==="nmr-check-coderabbit")).toBe(false);
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);await expect(dashboard.getByRole("main")).toContainText("v21");
 expect((await detail(daemon,r.id)).run.workflowVersionId).toBe(binding.workflowVersionId);
 await expect.poll(async()=>(await detail(daemon,r.id)).submissions[0]!.context,{timeout:60000}).toHaveProperty("evidence");
 expect((await detail(daemon,r.id)).submissions[0]!.context).not.toHaveProperty("evidence.coderabbit");
});

test("Setup reports an old CLI and a corrected stored-auth state without starting a review",async({dashboard,daemon})=>{
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({old:true}));
 await dashboard.goto(`${daemon.baseURL}/#/settings/setup`);await dashboard.getByRole("button",{name:/Agent extensions:/}).click();await expect(dashboard.getByRole("main")).toContainText("is older than 0.9.1. Upgrade that binary, or set MISSION_CODERABBIT_BIN to a newer CLI");
 const cliRow=dashboard.locator('[data-anchor="setup/dependency-coderabbit-cli"]');await expect(cliRow.getByRole("link",{name:"Open the CodeRabbit CLI guide"})).toBeVisible();await expect(cliRow).not.toContainText("brew install --cask coderabbit");
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({unauthenticated:true}));
 await dashboard.getByRole("button",{name:/Re-check/}).click();await expect(dashboard.getByRole("main")).toContainText("The CodeRabbit CLI is installed but not signed in.");
 writeFileSync(join(daemon.home,"coderabbit-script.json"),JSON.stringify({}));await dashboard.getByRole("button",{name:/Re-check/}).click();
 await expect(dashboard.getByRole("main")).not.toContainText("The CodeRabbit CLI is installed but not signed in.");await expect(dashboard.getByRole("main")).toContainText("CodeRabbit 0.9.1");await expect(dashboard.getByRole("main")).toContainText("Stored CodeRabbit authentication is ready");await shot(dashboard,"setup-ready");
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

test("exhausted incomplete review needs a fresh submission with an increased allowance", async ({ dashboard, daemon }) => {
 yaml(daemon, "reviews: {auto_review: {enabled: true}}");
 writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ omitCoverage: true }));
 const r = await start(dashboard, daemon, { maxRuns: 1 });
 await expect.poll(async () => (await detail(daemon, r.id)).run.status, { timeout: 60_000 }).toBe("blocked");
 await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
 await dashboard.getByRole("button", { name: /Retry the failed call/ }).click();
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.filter(a => a.nodeId === "cr")).toHaveLength(2);
 const guidance = "raise the run allowance in Library > Commands, then submit a new round";
 const message = dashboard.locator(".wf-run-error").filter({ hasText: guidance }).first();
 await expect(message).toContainText("allowance is exhausted");
 await message.scrollIntoViewIfNeeded();
 await expect(message).toBeInViewport({ ratio: 1 });
 await shot(dashboard, "incomplete-allowance-guidance");
 const allowance = async (maxRuns: number) => {
  const command = await api<Record<string, unknown>>(daemon, "/api/workflow-commands/coderabbit");
  await api(daemon, "/api/workflow-commands/coderabbit", { ...command, expectedRevision: command.revision, maxRuns }, "PUT");
 };
 const resubmit = (requestId: string) => api(daemon, `/api/workflow-runs/${r.id}/resubmit`, { requestId, resubmitUnchanged: true });
 const reviews = () => readFileSync(join(daemon.recordDir, "coderabbit.jsonl"), "utf8").trim().split("\n")
  .map(line => JSON.parse(line)).filter(call => call.args[0] === "review");
 // A catalog edit cannot change the comparison frozen by this submission.
 await allowance(2);
 await dashboard.getByRole("button", { name: /Retry the failed call/ }).click();
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.filter(a => a.nodeId === "cr")).toHaveLength(3);
 await expect.poll(async () => (await detail(daemon, r.id)).run.status).toBe("blocked");
 await expect(dashboard.getByRole("main")).toContainText(guidance);
 expect(reviews()).toHaveLength(1);
 // Resubmitting alone must not turn the exhausted, incomplete review into a pass.
 await allowance(1);
 await resubmit("cr-allowance-unchanged");
 await expect.poll(async () => (await detail(daemon, r.id)).attempts.filter(a => a.nodeId === "cr")).toHaveLength(4);
 await expect.poll(async () => (await detail(daemon, r.id)).run.status).toBe("blocked");
 expect((await detail(daemon, r.id)).attempts.filter(a => a.nodeId === "cr").every(a => a.verdict === null)).toBe(true);
 expect(reviews()).toHaveLength(1);
 // Follow the rendered remedy: a new round captures the explicitly increased allowance.
 writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ mode: "clean" }));
 await allowance(2);
 await resubmit("cr-allowance-increased");
 await expect.poll(async () => (await detail(daemon, r.id)).run.status, { timeout: 60_000 }).toBe("completed");
 await expect(dashboard.getByRole("main")).toContainText("Complete CodeRabbit review");
 expect(reviews()).toHaveLength(2);
 expect(reviews().every(call => !call.args.includes("--use-credits"))).toBe(true);
 await shot(dashboard, "incomplete-allowance-recovered");
});

for (const [name, failures] of [["recovers with one slot", 1], ["retry limit", 3]] as const) {
 test(`recoverable connection ${name} preserves the review gate`, async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  yaml(daemon, "reviews: {auto_review: {enabled: true}}");
  writeFileSync(join(daemon.home, "coderabbit-script.json"), JSON.stringify({ connectionFailures: failures }));
  const r = await start(dashboard, daemon, { maxRuns: 1 });
  await expect.poll(async () => (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")?.state,
   { timeout: 60_000 }).toBe("error");
  const first = (await detail(daemon, r.id)).attempts.find(a => a.nodeId === "cr")!;
  expect(first.verdict).toBeNull();
  expect(first.output).toMatchObject({ review: { status: "incomplete", remainingRuns: 1 } });
  await dashboard.goto(`${daemon.baseURL}/#/runs/${r.id}`);
  if (name === "recovers with one slot") {
   // Pin the regression to the observable blocked gate, before inspecting retry metadata.
   await shot(dashboard, "connection-recovers-initial");
   expect((await detail(daemon, r.id)).run.status, "a recoverable disconnect must keep the workflow running for automatic retry").toBe("running");
  }
  expect(first.output).toMatchObject({ review: { retryableConnection: true } });
  await expect.poll(async () => (await detail(daemon, r.id)).run.status,
   { timeout: 180_000 }).toBe(name === "recovers with one slot" ? "completed" : "blocked");
  const d = await detail(daemon, r.id);
  const attempts = d.attempts.filter(a => a.nodeId === "cr");
  expect(attempts).toHaveLength(name === "recovers with one slot" ? 2 : 3);
  for (const attempt of attempts) {
   expect((attempt.output as {review:{comparison:unknown}}).review.comparison)
    .toEqual((first.output as {review:{comparison:unknown}}).review.comparison);
  }
  if (name === "recovers with one slot") {
   await expect(dashboard.getByRole("main")).toContainText("Complete CodeRabbit review");
   expect(attempts.at(-1)?.output).toMatchObject({ status: "passed", review: { remainingRuns: 0 } });
  } else {
   await expect(dashboard.getByRole("main")).toContainText("WebSocket closed");
   await expect(dashboard.getByRole("main")).toContainText("Automatic connection retry limit reached");
   await expect(dashboard.getByRole("button", {name: /Retry the failed call/})).toBeVisible();
   expect(attempts.every(a => a.verdict === null)).toBe(true);
  }
  await expect(dashboard.getByRole("link", {name: "Settings > Setup"})).toHaveCount(0);
  const calls = readFileSync(join(daemon.recordDir, "coderabbit.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
  const reviews = calls.filter(c => c.args[0] === "review");
  expect(reviews).toHaveLength(attempts.length);
  expect(reviews.every(c => JSON.stringify(c.args) === JSON.stringify(reviews[0].args))).toBe(true);
  expect(reviews.every(c => !c.args.includes("--use-credits"))).toBe(true);
  if (name === "retry limit") {
   const message = dashboard.locator(".wf-run-error").filter({ hasText: "Automatic connection retry limit reached" }).first();
   await expect(message).toContainText("WebSocket closed");
   await expect(message).toContainText("Inspect retained output and retry after connectivity recovers");
   await message.scrollIntoViewIfNeeded();
   await expect(message).toBeInViewport({ ratio: 1 });
   await shot(dashboard, "connection-retry-limit-detail-r2");
  } else {
   await shot(dashboard, `connection-${name.replaceAll(" ", "-")}`);
  }
 });
}
