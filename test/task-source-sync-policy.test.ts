import test from "node:test";
import assert from "node:assert/strict";
import {
  canRefreshSourceTask, localSourceContent, PUSHED_SOURCE_GROUPS, reconcileSourceContent, sameSourceContent,
} from "../src/shared/task-source-sync.ts";
import { TaskSourceInstanceSchema } from "../src/shared/task-source.ts";
import { mkTask } from "./helpers/session-fixture.ts";
const base = {title:"Original",intent:"Original body",priority:null,labels:["triage"]};
test("refresh is off on old and new source configurations", () => {
  assert.equal(TaskSourceInstanceSchema.parse({id:"s",kind:"github-issues",repoRoot:"/repo"}).keepUpdated,false);
});
test("an untouched task takes remote changes without changing identity", () => {
  const remote = {...base,title:"Changed",intent:"Changed body"};
  const result = reconcileSourceContent(base,base,remote);
  assert.deepEqual(result.content,remote); assert.deepEqual(result.conflicts,[]);
});
test("brief conflicts preserve both title and intent while independent labels update", () => {
  const local = {...base,intent:"Local notes"};
  const remote = {...base,title:"Remote title",labels:["ready"]};
  const result = reconcileSourceContent(base,local,remote);
  assert.equal(result.content.title,base.title); assert.equal(result.content.intent,local.intent);
  assert.deepEqual(result.content.labels,["ready"]); assert.deepEqual(result.conflicts,["brief"]);
  assert.equal(result.baseline.title,base.title);
});
test("unchanged source leaves local overrides alone; matching values resolve conflicts", () => {
  const local = {...base,title:"Local"};
  assert.deepEqual(reconcileSourceContent(base,local,base).content,local);
  assert.deepEqual(reconcileSourceContent(base,local,local).baseline,local);
  assert.deepEqual(reconcileSourceContent(base,local,local).conflicts,[]);
  assert.ok(sameSourceContent({...base,labels:["a","b"]},{...base,labels:["b","a"]}));
});
test("started, assigned and provisioned tasks are ineligible even when shelved", () => {
  const task = mkTask({status:"backlog"});
  assert.ok(canRefreshSourceTask(task));
  for (const patch of [{status:"running" as const},{dispatchedAt:1},{sessionId:"s"},{worktreePath:"/tree"}]) {
    assert.equal(canRefreshSourceTask({...task,...patch}),false);
  }
});

// The `dependencies` group: the same three-way merge over the source items that block a task.
const blocker = (n: number) => ({externalId:`acme/demo#${n}`,url:`https://github.com/acme/demo/issues/${n}`});
const withDeps = (...ns: number[]) => ({...base,blockedBy:ns.map(blocker)});
test("dependencies: an upstream-only change is applied", () => {
  const result = reconcileSourceContent(withDeps(1),withDeps(1),withDeps(1,2));
  assert.deepEqual(result.content.blockedBy,[blocker(1),blocker(2)]);
  assert.deepEqual(result.baseline.blockedBy,[blocker(1),blocker(2)]); assert.deepEqual(result.conflicts,[]);
});
test("dependencies: a local-only edit is kept", () => {
  const result = reconcileSourceContent(withDeps(1),withDeps(),withDeps(1));
  assert.deepEqual(result.content.blockedBy,[]); assert.deepEqual(result.baseline.blockedBy,[blocker(1)]);
  assert.deepEqual(result.conflicts,[]);
});
test("dependencies: both changed is a conflict that keeps local and the old baseline", () => {
  const result = reconcileSourceContent(withDeps(1),withDeps(1,3),withDeps(2),);
  assert.deepEqual(result.content.blockedBy,[blocker(1),blocker(3)]);
  assert.deepEqual(result.baseline.blockedBy,[blocker(1)]); assert.deepEqual(result.conflicts,["dependencies"]);
});
test("dependencies: order and urls do not make a change; the set of items does", () => {
  const reordered = {...base,blockedBy:[blocker(2),{...blocker(1),url:null}]};
  assert.ok(sameSourceContent(withDeps(1,2),reordered));
  assert.equal(sameSourceContent(withDeps(1),withDeps(1,2)),false);
});
test("dependencies with no baseline: agreement is adopted, a difference is flagged, never applied", () => {
  const agreed = reconcileSourceContent(base,withDeps(1),withDeps(1));
  assert.deepEqual(agreed.conflicts,[]); assert.deepEqual(agreed.baseline.blockedBy,[blocker(1)]);
  for (const [local,remote] of [[withDeps(),withDeps(1)],[withDeps(1),withDeps()]] as const) {
    const flagged = reconcileSourceContent(base,local,remote);
    assert.deepEqual(flagged.conflicts,["dependencies"]); assert.deepEqual(flagged.content.blockedBy,local.blockedBy);
    assert.equal(flagged.baseline.blockedBy,undefined);
  }
});
test("dependencies: a source that cannot relate has no group on either side, so nothing changes", () => {
  const result = reconcileSourceContent(base,base,{...base,title:"Changed"});
  assert.equal(result.content.blockedBy,undefined); assert.deepEqual(result.conflicts,[]);
});
test("pushed tasks reconcile the dependencies group only", () => {
  const local = withDeps(1);
  const remote = {...withDeps(1,2),title:"Upstream rename",labels:["other"]};
  const result = reconcileSourceContent(local,local,remote,PUSHED_SOURCE_GROUPS);
  assert.equal(result.content.title,base.title); assert.deepEqual(result.content.labels,base.labels);
  assert.deepEqual(result.content.blockedBy,[blocker(1),blocker(2)]); assert.deepEqual(result.conflicts,[]);
});
test("a task's local blockers are its edges to this source's items, and nothing else", () => {
  const linked = mkTask({id:"linked",source:{sourceId:"s",...blocker(2)}});
  const foreign = mkTask({id:"foreign",source:{sourceId:"other",...blocker(3)}});
  const task = mkTask({dependencies:[
    {type:"source",sourceId:"s",...blocker(1),title:"#1",state:"open",checkedAt:null,selectedAt:null,satisfiedAt:null},
    {type:"source",sourceId:"other",...blocker(4),title:"#4",state:"open",checkedAt:null,selectedAt:null,satisfiedAt:null},
    ...[linked,foreign,mkTask({id:"plain"})].map((t)=>({type:"task" as const,taskId:t.id,title:t.title,sessionId:null,
      episodeId:null,agentSessionId:null,branch:null,prUrl:null,selectedAt:null,satisfiedAt:null})),
  ]});
  assert.deepEqual(localSourceContent(task,{sourceId:"s",tasks:[linked,foreign]}).blockedBy,[blocker(1),blocker(2)]);
  assert.equal(localSourceContent(task,null).blockedBy,undefined);
});
