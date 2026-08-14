// The kind, from the column it is stored in to the two readers that act on it.
//
// `tasks.kind` is unconstrained `TEXT` with no `CHECK` and no migration in its history,
// which is what made adding a third kind a zero-migration change - and is also what made
// the read path a lie. It cast the column straight into `TaskKind`, so whatever string was
// in that row became a typed kind, and a value from a NEWER build flowed into code that
// then looked it up in a `Record<TaskKind, …>` and got `undefined` back from a lookup the
// types had promised could not fail.
//
// The schedule store had solved this vocabulary already, in the same words, and answered
// it differently: `readPersistedEnum` and DROP the template. A template can be dropped and
// a task row cannot - one unreadable row must not remove work from somebody's backlog - so
// the task path validates the same way and degrades to `ship`, the kind every automated
// writer already defaults to. Both halves are pinned here, because "falls back" and
// "throws it away" are one line apart and only one of them keeps the backlog intact.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkTask } from "./helpers/session-fixture.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import { TASK_KIND_INFO } from "../src/shared/task.ts";
import { buildBacklogPrompt } from "../src/server/foreman/backlog-prompt.ts";

// Above the dynamic imports, in the file body: a home arriving through the environment was
// there before the preload ran, which is what an operator's configured state dir looks
// like, and `openDb` refuses it.
const home = mkdtempSync(join(tmpdir(), "mission-task-kind-"));
process.env.HARNESS_HOME = home;
const { getTask, openDb, upsertTask } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("every kind survives a write and a read", () => {
  for (const kind of TASK_KINDS) {
    const id = `t-${kind}`;
    upsertTask(mkTask({ id, kind, title: `a ${kind} task` }));
    assert.equal(getTask(id)?.kind, kind, `${kind} should come back as itself`);
  }
});

test("a kind this build has never heard of reads as ship, and the row survives", () => {
  // Written past the typed API on purpose. This is a row from a LATER build - the case the
  // cast could never have handled, and the only one worth testing, since a value this build
  // knows about cannot reach the fallback.
  const id = "t-from-the-future";
  upsertTask(mkTask({ id, kind: "ship", title: "written by a newer build" }));
  openDb().prepare("UPDATE tasks SET kind = ? WHERE id = ?").run("teleport", id);

  const row = getTask(id);
  // The row is STILL THERE, which is the half that distinguishes this from the schedule
  // store's answer. Dropping it would take a task off the backlog because one column was
  // written by a build that knew a word this one does not.
  assert.ok(row, "an unreadable kind must not remove the task");
  assert.equal(row.kind, "ship", "an unknown kind degrades to the default");
  assert.equal(row.title, "written by a newer build", "and nothing else about the row moves");
  // Typed, not merely equal: the point is that what leaves this function is a member of
  // the vocabulary, so a `Record<TaskKind, …>` lookup downstream cannot miss.
  assert.ok((TASK_KINDS as readonly string[]).includes(row.kind));
});

test("the backlog planner is told what each kind is for, from the registry", () => {
  // The bug this replaced was not a missing case, it was a WRONG one: the prompt asked
  // `kind === "ship" ? "deliver a change" : "investigate and report"`, so every kind that
  // was not ship was described to the model as an investigation. A third kind would have
  // been mislabelled rather than merely unmentioned, and the planner orders the backlog by
  // what it believes each task is for.
  const tasks = TASK_KINDS.map((kind, i) =>
    mkTask({ id: `p${i}`, kind, title: `a ${kind} task`, intent: `do the ${kind} work` }),
  );
  const prompt = buildBacklogPrompt(tasks);

  for (const kind of TASK_KINDS) {
    assert.ok(
      prompt.includes(`kind: ${kind} (${TASK_KIND_INFO[kind].purpose})`),
      `the planner should be told what a ${kind} is for`,
    );
  }
  // The specific mislabelling, stated as its own assertion so a regression names itself
  // rather than showing up as a diff in a long prompt.
  assert.ok(
    !prompt.includes("kind: plan (investigate and report)"),
    "a plan must not be described to the planner as a scout",
  );
});
