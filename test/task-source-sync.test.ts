import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSourceInstanceSchema, GithubIssuesConfigSchema, JiraConfigSchema } from "../src/shared/task-source.ts";
import type { TaskCandidate, TaskSourceInstance, TaskSourceRef } from "../src/shared/task-source.ts";
import { sourceContent } from "../src/shared/task-source-sync.ts";
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { getTask, listTasks, deleteTask, openDb, countTaskSourceSeen, inTransaction } = await import("../src/server/db.ts");
const { setTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");
const { ingestSweep } = await import("../src/server/task-sources/ingest.ts");
const { refreshSourceTasks, sourceSyncReviews, resolveSourceSync } = await import("../src/server/task-sources/sync.ts");
const { getSourceSync, saveSourceSync } = await import("../src/server/task-sources/sync-store.ts");
const { TASK_SOURCES, readLinkedSource } = await import("../src/server/task-sources/index.ts");
const { sweepOnce } = await import("../src/server/task-sources/sweeper.ts");
const { ghLinkedIssueArgs } = await import("../src/server/task-sources/github-issues.ts");
const { linkedJiraConfig } = await import("../src/server/task-sources/jira.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

beforeEach(() => {
  for (const task of listTasks()) deleteTask(task.id);
  openDb().exec("DELETE FROM task_source_seen; DELETE FROM task_source_sync;");
  setTaskSourcesConfig({sources:[]});
});
const candidate = (number = 1): TaskCandidate => ({
  ref:{sourceId:"s",externalId:`acme/demo#${number}`,url:`https://github.com/acme/demo/issues/${number}`},
  title:`Original ${number}`, intent:"Original body",repoRoot:"/repo",labels:["upstream"],
});
async function setup(enabled = true) {
  const src = TaskSourceInstanceSchema.parse({id:"s",kind:"github-issues",repoRoot:"/repo",keepUpdated:enabled,
    defaults:{agent:"claude",priority:"med",labels:["triage"]}});
  setTaskSourcesConfig({sources:[src]});
  const registry = new Registry(); const tasks = new TaskManager(registry);
  await ingestSweep(src,{items:[candidate()],error:null},tasks,{resolveRepoRoot:async () => ({ok:true,repoRoot:"/repo"})});
  return {src,registry,tasks,task:listTasks()[0]!};
}
async function refresh(src:TaskSourceInstance,tasks:InstanceType<typeof TaskManager>,items:TaskCandidate[]) {
  return refreshSourceTasks(src,{items,error:null},tasks,{sourceId:src.id,repoRoot:src.repoRoot,signal:new AbortController().signal});
}
test("refresh updates the same task and fixed import defaults, and unchanged sweeps emit nothing", async () => {
  const {src,registry,tasks,task}=await setup();
  const events:unknown[]=[]; registry.subscribe(e=>{if(e.type==="task_upsert")events.push(e);});
  const remote={...candidate(),title:"Remote title",intent:"Remote body"};
  assert.equal((await refresh(src,tasks,[remote])).updated,1);
  assert.equal(listTasks().length,1); assert.equal(getTask(task.id)!.title,remote.title);
  assert.equal(getTask(task.id)!.enabled,false); assert.equal(getTask(task.id)!.priority,"med");
  const changed={...src,defaults:{...src.defaults,priority:"high" as const,labels:["new default"]}};
  setTaskSourcesConfig({sources:[changed]});
  assert.equal((await refresh(changed,tasks,[remote])).unchanged,1);
  assert.equal(events.length,1); assert.deepEqual(getTask(task.id)!.labels,["triage","upstream"]);
});
test("off stays import-only; deleted tasks remain suppressed",async()=>{
  const {src,tasks,task}=await setup(false);
  assert.equal((await refresh(src,tasks,[{...candidate(),title:"Remote"}])).updated,0);
  assert.equal(getTask(task.id)!.title,task.title);
  deleteTask(task.id); assert.equal(getSourceSync(task.id),null); assert.equal(countTaskSourceSeen(src.id),1);
  const report=await ingestSweep(src,{items:[candidate()],error:null},tasks);
  assert.equal(report.filed,0); assert.equal(listTasks().length,0);
});
test("local conflict survives, stale resolutions are refused, and Keep local advances only the baseline",async()=>{
  const {src,tasks,task}=await setup();
  await tasks.update(task.id,{intent:"Local notes"});
  const remote={...candidate(),title:"Remote title",intent:"Remote body",labels:["ready"]};
  assert.equal((await refresh(src,tasks,[remote])).conflicted,1);
  assert.equal(getTask(task.id)!.intent,"Local notes"); assert.deepEqual(getTask(task.id)!.labels,["triage","ready"]);
  const old=sourceSyncReviews([src])[0]!;
  await tasks.update(task.id,{intent:"Newer local notes"});
  assert.equal((await resolveSourceSync(src,task.id,old.version,"source",tasks)).ok,false);
  const review=sourceSyncReviews([src])[0]!;
  assert.ok((await resolveSourceSync(src,task.id,review.version,"local",tasks)).ok);
  assert.equal((await refresh(src,tasks,[remote])).unchanged,1);
  assert.equal(getTask(task.id)!.intent,"Newer local notes");
  const changed={...remote,intent:"Another remote edit"};
  await refresh(src,tasks,[changed]);
  assert.ok((await resolveSourceSync(src,task.id,sourceSyncReviews([src])[0]!.version,"source",tasks)).ok);
  assert.equal(getTask(task.id)!.intent,changed.intent);
});
test("legacy links need adoption and newly pushed links are excluded",async()=>{
  const {src,registry,tasks,task}=await setup();
  openDb().prepare("DELETE FROM task_source_sync WHERE task_id=?").run(task.id);
  await refresh(src,tasks,[candidate()]);
  const review=sourceSyncReviews([src])[0]!; assert.equal(review.adoption,true);
  assert.ok((await resolveSourceSync(src,task.id,review.version,"source",tasks)).ok);
  assert.equal(getSourceSync(task.id)!.origin,"imported");
  const pushed=mkTask({id:"pushed",source:null}); registry.upsertTask(pushed);
  assert.ok(tasks.attachSource(pushed.id,candidate(2).ref).ok);
  assert.equal(getSourceSync(pushed.id)!.origin,"pushed");
  assert.equal(sourceSyncReviews([src]).length,1);
});
test("linked reads bypass discovery; missing results keep the task and show the error",async(t)=>{
  const {src,tasks,task}=await setup();
  let requested:string[]=[];
  const reader = t.mock.method(TASK_SOURCES["github-issues"],"readLinked",async(_cfg: unknown,refs: TaskSourceRef[])=>{
    requested=refs.map((r:{externalId:string})=>r.externalId);
    return {items:[{...candidate(),title:"Closed issue, edited"}],error:null};
  });
  await refresh(src,tasks,[]); assert.deepEqual(requested,[candidate().ref.externalId]);
  assert.equal(getTask(task.id)!.title,"Closed issue, edited");
  reader.mock.mockImplementation(async()=>({items:[],error:"upstream unavailable"}));
  assert.equal((await refresh(src,tasks,[])).skipped,1);
  assert.equal(getTask(task.id)!.title,"Closed issue, edited");
  assert.equal(sourceSyncReviews([src])[0]!.error,"upstream unavailable");
});
test("an in-flight pause, local edit, or dispatch cannot overwrite newer state",async(t)=>{
  const {src,registry,tasks,task}=await setup();
  const reader = t.mock.method(TASK_SOURCES["github-issues"],"readLinked",async()=>{
    await tasks.update(task.id,{intent:"Changed during read"});
    return {items:[{...candidate(),intent:"Remote"}],error:null};
  });
  assert.equal((await refresh(src,tasks,[])).skipped,1); assert.equal(getTask(task.id)!.intent,"Changed during read");
  reader.mock.mockImplementation(async()=>{
    setTaskSourcesConfig({sources:[{...src,keepUpdated:false}]});
    return {items:[{...candidate(),intent:"Remote"}],error:null};
  });
  await refresh(src,tasks,[]); assert.equal(getTask(task.id)!.intent,"Changed during read");
  setTaskSourcesConfig({sources:[src]});
  reader.mock.mockImplementation(async()=>{
    registry.upsertTask({...getTask(task.id)!,status:"running",dispatchedAt:Date.now()});
    return {items:[{...candidate(),intent:"Remote"}],error:null};
  });
  assert.equal((await refresh(src,tasks,[])).skipped,1); assert.equal(getTask(task.id)!.intent,"Changed during read");
});
test("a per-item linked-read error preserves that task while valid siblings update", async (t) => {
  const { src, tasks, task } = await setup();
  await ingestSweep(src, { items: [candidate(2)], error: null }, tasks,
    { resolveRepoRoot: async () => ({ ok: true, repoRoot: "/repo" }) });
  const sibling = listTasks().find((item) => item.source?.externalId === candidate(2).ref.externalId)!;
  t.mock.method(TASK_SOURCES["github-issues"], "readLinked", async () => ({
    items: [{ ...candidate(2), title: "Refreshed sibling" }], error: null,
    itemErrors: { [candidate().ref.externalId]: "The linked item belongs to another Jira site." },
  }));
  const result = await refresh(src, tasks, []);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(getTask(task.id)!.title, task.title);
  assert.equal(getTask(sibling.id)!.title, "Refreshed sibling");
  assert.equal(sourceSyncReviews([src]).find((review) => review.taskId === task.id)!.error,
    "The linked item belongs to another Jira site.");
  assert.equal(sourceSyncReviews([src]).find((review) => review.taskId === sibling.id)!.error, null);
});
test("GitHub linked failures never persist command output or parser details in reviews or the API", async () => {
  const { src, registry, tasks, task } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "mission-linked-gh-"));
  const bin = join(dir, "gh");
  const before = process.env.MISSION_GH_BIN;
  const secret = "fake-token-should-not-be-persisted /private/operator/path account@example.test";
  process.env.MISSION_GH_BIN = bin;
  const localSource = { ...src, repoRoot: dir };
  setTaskSourcesConfig({ sources: [localSource] });
  try {
    const { buildApp } = await import("../src/server/routes.ts");
    const app = buildApp({ registry, tasks, reviews: {} as never, queues: {} as never });
    for (const [stream, code] of [["stderr", 1], ["stdout", 0]] as const) {
      writeFileSync(bin, `#!/usr/bin/env node\nprocess.${stream}.write(${JSON.stringify(secret)}); process.exitCode = ${code};\n`);
      chmodSync(bin, 0o755);
      assert.equal((await refresh(localSource, tasks, [])).skipped, 1);
      const record = getSourceSync(task.id)!;
      assert.equal(record.error, code === 1
        ? "The linked GitHub issue could not be read. Check access and authentication, then sweep again."
        : "The linked GitHub issue returned unreadable content.");
      assert.ok(!JSON.stringify(record).includes(secret));
      const response = await app.request("/api/task-sources/config", { headers: { host: "127.0.0.1:7317" } });
      const body = await response.text();
      for (const fragment of secret.split(" ")) assert.ok(!body.includes(fragment), fragment);
    }
  } finally {
    if (before === undefined) delete process.env.MISSION_GH_BIN;
    else process.env.MISSION_GH_BIN = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("the sweep entry point rejects overlap during a linked refresh even within one millisecond", async (t) => {
  const { src, tasks, task } = await setup();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(TASK_SOURCES["github-issues"], "sweep", async () => ({ items: [], error: null }));
  const reader = t.mock.method(TASK_SOURCES["github-issues"], "readLinked", async () => {
    entered();
    await gate;
    return { items: [{ ...candidate(), title: "Refreshed" }], error: null };
  });
  const first = sweepOnce(src, tasks);
  try {
    await started;
    const attempt = getSourceSync(task.id);
    const second = await sweepOnce(src, tasks);
    assert.equal(second.error, "a sweep of this source is already running");
    assert.equal(reader.mock.callCount(), 1);
    assert.deepEqual(getSourceSync(task.id), attempt);
    release();
    assert.equal((await first).sync?.updated, 1);
    assert.equal(getTask(task.id)!.title, "Refreshed");
  } finally {
    release();
    await first;
  }
});
test("duplicate live identities and a changed upstream site never pick an arbitrary target",async()=>{
  const {src,registry,tasks,task}=await setup();
  registry.upsertTask({...task,id:"duplicate"});
  assert.equal((await refresh(src,tasks,[{...candidate(),title:"Remote"}])).skipped,2);
  assert.equal(getTask(task.id)!.title,task.title);
  deleteTask("duplicate");
  await refresh(src,tasks,[{...candidate(),ref:{...candidate().ref,url:"https://other.test/item"},title:"Wrong site"}]);
  assert.match(sourceSyncReviews([src])[0]!.error!,/different issue link/);
});
test("attempts rotate fairly even when the first batch times out",async(t)=>{
  const {src,registry,tasks,task}=await setup();
  for(let i=2;i<=27;i++) {
    const c=candidate(i);registry.upsertTask({...task,id:`item-${i}`,source:c.ref,createdAt:i});
  }
  const requested:string[][]=[];
  const controller=new AbortController();
  t.mock.method(TASK_SOURCES["github-issues"],"readLinked",async(_cfg: unknown,refs: TaskSourceRef[])=>{
    requested.push(refs.map((r:{externalId:string})=>r.externalId)); controller.abort();
    return {items:[],error:"timeout"};
  });
  await refreshSourceTasks(src,{items:[],error:null},tasks,{sourceId:"s",repoRoot:"/repo",signal:controller.signal});
  await refresh(src,tasks,[]);
  assert.equal(requested[0]!.length,25);
  assert.ok(requested[1]!.some(id=>!requested[0]!.includes(id)),"later tasks must get a turn");
});
test("task and baseline changes roll back together before any event is published",async()=>{
  const {src,registry,tasks,task}=await setup(); const before=getSourceSync(task.id)!;
  const events:unknown[]=[];registry.subscribe(e=>{if(e.type==="task_upsert")events.push(e);});
  await assert.rejects(tasks.applySourceContent(task.id,task.source!,sourceContent(task),{...sourceContent(task),title:"After"},()=>{
    saveSourceSync(task.id,src.id,{...before,baseline:{...before.baseline!,title:"After"}}); throw new Error("rollback");
  },()=>true),/rollback/);
  assert.deepEqual(getSourceSync(task.id),before); assert.equal(getTask(task.id)!.title,task.title); assert.equal(events.length,0);
  assert.throws(()=>inTransaction(()=>{deleteTask(task.id);throw new Error("keep");}),/keep/);
  assert.ok(getSourceSync(task.id));
});
test("linked-refresh registry accepts 25 identities and rejects 26 without calling the provider", async (t) => {
  const src = TaskSourceInstanceSchema.parse({ id: "s", kind: "github-issues", repoRoot: "/repo" });
  const items = Array.from({ length: 25 }, (_, index) => candidate(index + 1));
  const refs = items.map((item) => item.ref);
  const ctx = { sourceId: src.id, repoRoot: src.repoRoot, signal: new AbortController().signal };
  const result = { items, error: null };
  const provider = t.mock.method(TASK_SOURCES["github-issues"], "readLinked", async () => result);

  assert.deepEqual(await readLinkedSource(src, refs, ctx), result);
  assert.equal(provider.mock.callCount(), 1);
  assert.deepEqual(provider.mock.calls[0]!.arguments, [src.config, refs, ctx]);

  assert.deepEqual(await readLinkedSource(src, [...refs, candidate(26).ref], ctx), {
    items: [],
    error: "a linked refresh may read at most 25 items",
  });
  assert.equal(provider.mock.callCount(), 1, "the rejected request must not invoke the provider");
});

test("provider identity readers build bounded explicit requests",()=>{
  const args=ghLinkedIssueArgs(candidate().ref);
  assert.deepEqual(args.slice(0,3),["issue","view",candidate().ref.url]);
  assert.ok(!args.includes("--state"));
  const cfg=JiraConfigSchema.parse({site:"acme.atlassian.net",jql:"status = Open"});
  const linked=linkedJiraConfig(cfg,[{sourceId:"s",externalId:"MC-1",url:"https://acme.atlassian.net/browse/MC-1"}]);
  assert.equal(linked.jql,'key in ("MC-1")');
  assert.throws(()=>linkedJiraConfig(cfg,[{sourceId:"s",externalId:"MC-1",url:"https://another.atlassian.net/browse/MC-1"}]),/another Jira site/);
  assert.ok(GithubIssuesConfigSchema.parse({}));
});

test("review HTTP route validates the request, source ownership and stale revisions",async()=>{
  const {src,registry,tasks,task}=await setup();
  const { buildApp } = await import("../src/server/routes.ts");
  const app=buildApp({registry,tasks,reviews:{} as never,queues:{} as never});
  const request=(sourceId:string,body:unknown)=>app.request(`/api/task-sources/${sourceId}/sync/${task.id}/resolve`,{
    method:"POST",headers:{host:"127.0.0.1:7317","content-type":"application/json"},body:JSON.stringify(body),
  });
  assert.equal((await request(src.id,{choice:"bad"})).status,400);
  assert.equal((await request("missing",{choice:"source",version:"v"})).status,404);
  await tasks.update(task.id,{intent:"Local"}); await refresh(src,tasks,[{...candidate(),intent:"Remote"}]);
  const review=sourceSyncReviews([src])[0]!;
  assert.equal((await request(src.id,{choice:"source",version:"stale"})).status,409);
  const res=await request(src.id,{choice:"source",version:review.version});
  assert.equal(res.status,200); assert.equal(getTask(task.id)!.intent,"Remote");
});

test("recorded execution excludes a task even after reschedule clears dispatchedAt",async()=>{
  const {src,tasks,task}=await setup();
  openDb().prepare(`INSERT INTO historical_task_work_episode_bindings
    (task_id,episode_id,session_id,agent_session_id,bound_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(task.id,"ep","session","agent",1,1);
  assert.equal(sourceSyncReviews([src]).length,0);
  assert.equal((await refresh(src,tasks,[{...candidate(),title:"Remote"}])).updated,0);
  assert.equal((await tasks.applySourceContent(task.id,task.source!,sourceContent(task),
    {...sourceContent(task),title:"Remote"},()=>{},()=>true)).ok,false);
});
