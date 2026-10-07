import assert from "node:assert/strict";
import test from "node:test";
import { parseResumeProcesses, resumeDescendantsExited, type ResumeProcess } from "../src/server/terminal/resume-processes.ts";

const proc = (pid: number, ppid: number, startMs = pid): ResumeProcess => ({ pid, ppid, startMs });
const inventory = (...processes: ResumeProcess[]) => new Map(processes.map((p) => [p.pid, p]));
const guard = proc(10, 2);
const baseline = [proc(1, 0), proc(2, 1), guard, proc(3, 1)];
const before = inventory(...baseline);

test("ordinary child exit permits cleanup, including unrelated new process trees", () => {
  assert.equal(resumeDescendantsExited(before, inventory(...baseline), guard), true);
  assert.equal(resumeDescendantsExited(before, inventory(...baseline, proc(20, 3), proc(21, 20)), guard), true);
});

test("surviving descendants block cleanup regardless of their process group", () => {
  assert.equal(resumeDescendantsExited(before, inventory(...baseline, proc(20, guard.pid), proc(21, 20)), guard), false);
});

test("new orphans retain credentials even when their intermediate parents were never observed", () => {
  assert.equal(resumeDescendantsExited(before, inventory(...baseline, proc(21, 1)), guard), false);
  // A subreaper can adopt a detached grandchild instead of PID 1.
  assert.equal(resumeDescendantsExited(before, inventory(...baseline, proc(21, 2)), guard), false);
});

test("reparenting the guard does not erase its original potential reapers", () => {
  assert.equal(resumeDescendantsExited(before, inventory(...baseline.filter((p) => p.pid !== guard.pid),
    { ...guard, ppid: 1 }, proc(21, 2)), guard), false);
});

test("recycled PIDs cannot clear survivors or authenticate the guard", () => {
  assert.equal(resumeDescendantsExited(before, inventory(...baseline.filter((p) => p.pid !== 3), proc(3, 1, 30)), guard), false);
  assert.equal(resumeDescendantsExited(before, inventory(...baseline.filter((p) => p.pid !== guard.pid),
    { ...guard, startMs: 30 }), guard), false);
  // A missing parent replaced after its child started is not evidence of unrelated ancestry.
  assert.equal(resumeDescendantsExited(inventory(...baseline, proc(4, 1, 40)),
    inventory(...baseline, proc(4, 1, 40), proc(21, 4, 21)), guard), false);
  assert.equal(resumeDescendantsExited(inventory(...baseline, proc(4, 1, 40)),
    inventory(...baseline, proc(4, 1, 40), proc(20, 4, 30), proc(21, 20, 50)), guard), false);
});

test("unavailable inventories, missing parents and ancestry cycles retain the home", () => {
  assert.equal(resumeDescendantsExited(null, before, guard), false);
  assert.equal(resumeDescendantsExited(before, null, guard), false);
  assert.equal(resumeDescendantsExited(before, inventory(...baseline.filter((p) => p.pid !== 2)), guard), false);
  assert.equal(resumeDescendantsExited(before, inventory(...baseline, proc(21, 999)), guard), false);
  assert.equal(resumeDescendantsExited(before, inventory(...baseline, proc(21, 22, 20), proc(22, 21, 20)), guard), false);
  assert.equal(resumeDescendantsExited(inventory(...baseline, proc(2, 10)), before, guard), false);
});

test("process inventory parses only identities and excludes its collector", () => {
  const date = "Wed Sep 30 12:34:56 2026";
  assert.deepEqual(parseResumeProcesses(` 1 0 ${date}\n 10 1 ${date}\n 11 10 ${date}\n`, 11),
    inventory(proc(1, 0, Date.parse(date)), proc(10, 1, Date.parse(date))));
});

test("partial, malformed, duplicate and empty inventories fail closed", () => {
  const valid = "1 0 Wed Sep 30 12:34:56 2026\n";
  for (const output of ["", "\n", "1 0 invalid", valid + "unparsed row", valid + valid, "1 0 Wed Sep 30", "9999999999999999999 0 Wed Sep 30 12:34:56 2026"])
    assert.equal(parseResumeProcesses(output, 11), null, output);
});
