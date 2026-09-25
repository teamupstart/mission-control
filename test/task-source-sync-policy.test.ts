import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSourceContent, sameSourceContent, canRefreshSourceTask } from "../src/shared/task-source-sync.ts";
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
