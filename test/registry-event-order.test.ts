import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { ServerEvent } from "../src/shared/types.ts";

// The order changes reach a browser in.
//
// What is at stake: a card that is wrong and stays wrong. The store is last-write-wins on the
// wire - `useEventStream` keys sessions by id and replaces - so a stale event arriving AFTER a
// fresh one is not a flicker, it is the state the dashboard then holds until something else
// happens to that session. For a task that has just finished, nothing does.
//
// The hazard is re-entrancy rather than concurrency. Listeners run synchronously and one of
// them concludes work from what it hears: `TaskManager` completes a task on a `session_upsert`
// carrying a merged pull request, which writes a new session entry and announces it from
// inside the first announcement. Delivered depth-first, the consequence goes out before its
// cause. `emitEvent` queues the nested one behind the outer instead.

const home = mkdtempSync(join(tmpdir(), "mission-event-order-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("a change announced from inside a delivery is sent AFTER the one that caused it", () => {
  const registry = new Registry();
  const seen: string[] = [];
  let reacted = false;

  // A listener that mutates in response to what it heard - the shape `TaskManager` has.
  registry.subscribe((e: ServerEvent) => {
    if (e.type !== "task_upsert" || reacted) return;
    reacted = true;
    registry.upsertTask(baseTask({ id: e.task.id, title: "second", repoRoot: "/repo" }));
  });
  registry.subscribe((e: ServerEvent) => {
    if (e.type === "task_upsert") seen.push(e.task.title);
  });

  registry.upsertTask(baseTask({ id: "t-order", title: "first", repoRoot: "/repo" }));

  assert.deepEqual(
    seen,
    ["first", "second"],
    "the cause is delivered first, so the consequence is what the store ends up holding",
  );
  // Still SYNCHRONOUS by the time the call returns - this is a reordering, not a deferral,
  // and every test in this suite that asserts straight after an ingest depends on that.
  assert.equal(registry.getTask("t-order")?.title, "second");
});

test("a listener that throws does not strand the queue for the next emit", () => {
  const registry = new Registry();
  const seen: string[] = [];
  let armed = true;

  registry.subscribe((e: ServerEvent) => {
    if (e.type !== "task_upsert" || !armed) return;
    armed = false;
    registry.upsertTask(baseTask({ id: "t-throw", title: "queued", repoRoot: "/repo" }));
    throw new Error("listener blew up mid-delivery");
  });
  registry.subscribe((e: ServerEvent) => {
    if (e.type === "task_upsert") seen.push(e.task.title);
  });

  assert.throws(() =>
    registry.upsertTask(baseTask({ id: "t-throw", title: "cause", repoRoot: "/repo" })),
  );
  seen.length = 0;

  // The abandoned queue is dropped rather than replayed: its ordering stopped meaning
  // anything the moment the drain was cut short, and re-sending it against a later event
  // would announce a state older than the one already on screen.
  registry.upsertTask(baseTask({ id: "t-throw", title: "after", repoRoot: "/repo" }));
  assert.deepEqual(seen, ["after"]);
});
