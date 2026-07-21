import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_PER_SWEEP,
  DEFAULT_SWEEP_INTERVAL_MS,
  MAX_SWEEP_INTERVAL_MS,
  MIN_SWEEP_INTERVAL_MS,
  TASK_SOURCE_KINDS,
  TASK_SOURCE_KIND_INFO,
  TaskSourceInstanceSchema,
  TaskSourcesConfigSchema,
} from "../src/shared/task-source.ts";
import { TASK_SOURCES, taskSourceKinds } from "../src/server/task-sources/index.ts";

// What is at stake: a task source's kind id is PERSISTED inside the `taskSources` blob in
// `app_config`, so the list is append-only in the same way skill directory prefixes and
// the `MISSION_*` env fallbacks are. Rename one and every source an operator configured
// under the old spelling stops matching a registered kind - it never sweeps again, and
// nothing says so, because a source that files nothing is indistinguishable from an
// upstream with no new work.
//
// The rest of this file pins the two properties that make a registry safe to extend: every
// declared kind is actually implemented, and every kind's config schema can read the blob
// an operator who configured nothing would leave behind.

test("every declared kind is implemented, and nothing is implemented that isn't declared", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    assert.ok(TASK_SOURCES[kind], `${kind} is declared but has no implementation`);
    assert.equal(TASK_SOURCES[kind].kind, kind, `${kind}'s implementation names itself wrong`);
  }
  assert.deepEqual(Object.keys(TASK_SOURCES).sort(), [...TASK_SOURCE_KINDS].sort());
});

test("kind ids are unique - two sources sharing one would share a registry slot", () => {
  assert.equal(new Set(TASK_SOURCE_KINDS).size, TASK_SOURCE_KINDS.length);
});

// The panel's add control is derived from this, so a kind with no name is a row an
// operator cannot tell from any other.
test("every kind says what it is called and what it sweeps", () => {
  for (const k of taskSourceKinds()) {
    assert.ok(k.label.trim().length > 0, `${k.kind} has no label`);
    assert.ok(k.blurb.trim().length > 0, `${k.kind} has no blurb`);
  }
  assert.equal(taskSourceKinds().length, TASK_SOURCE_KINDS.length);
});

// A freshly added source stores `config: {}`, and the sweeper parses that blob through
// this schema on every tick. A kind whose schema refuses an empty object would be
// addable, storable, and permanently broken.
test("every kind's config schema accepts an empty object", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const parsed = TASK_SOURCE_KIND_INFO[kind].configSchema.safeParse({});
    assert.ok(parsed.success, `${kind} refuses an empty config: ${JSON.stringify(parsed)}`);
  }
});

test("a source ships switched off - adding one is configuration, enabling it is consent", () => {
  const parsed = TaskSourceInstanceSchema.parse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
  });
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.intervalMs, DEFAULT_SWEEP_INTERVAL_MS);
  assert.equal(parsed.maxPerSweep, DEFAULT_MAX_PER_SWEEP);
  assert.equal(parsed.defaults.priority, null, "nothing infers a priority");
  assert.deepEqual(parsed.defaults.labels, []);
});

// A mistyped interval must not let a source hammer someone else's API, nor park itself
// out of reach - both directions are clamped rather than refused, so an existing blob
// written by an older build still loads.
test("the sweep interval is clamped at both ends", () => {
  const at = (intervalMs: number): number =>
    TaskSourceInstanceSchema.parse({ id: "s", kind: "github-issues", repoRoot: "/r", intervalMs })
      .intervalMs;
  assert.equal(at(1), MIN_SWEEP_INTERVAL_MS);
  assert.equal(at(MAX_SWEEP_INTERVAL_MS * 10), MAX_SWEEP_INTERVAL_MS);
  assert.equal(at(600_000), 600_000);
});

// The ids key the seen table, the status map and the per-source routes. Two sources
// sharing one would share their seen rows, so whichever swept first would permanently
// suppress the other's items.
test("two sources cannot share an id", () => {
  const one = { id: "dup", kind: "github-issues", repoRoot: "/repo" };
  assert.ok(TaskSourcesConfigSchema.safeParse({ sources: [one] }).success);
  assert.equal(TaskSourcesConfigSchema.safeParse({ sources: [one, { ...one }] }).success, false);
});

// The kind's own schema runs at the config boundary, so a blob that could never sweep is
// refused by the PUT rather than failing silently every fifteen minutes.
test("a source's config is validated against its kind at the door", () => {
  const bad = TaskSourceInstanceSchema.safeParse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
    config: { assignedToMe: true, unassignedOnly: true },
  });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad), /select nothing together/);
});

// `preflight` is what the panel calls to tell a MISCONFIGURED source from an empty one.
// One that throws instead of answering turns that distinction back into a crash.
test("preflight answers rather than throwing, even against a config it cannot use", async () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const said = await TASK_SOURCES[kind].preflight(
      { assignedToMe: true, unassignedOnly: true },
      { sourceId: "s", repoRoot: "/definitely/not/here", signal: AbortSignal.abort() },
    );
    assert.equal(typeof said, "string", `${kind} must name the problem`);
  }
});

// The rule every implementation is held to: a broken sweep and a quiet one must not look
// alike. An unusable config comes back as an error, never as an empty success.
test("a sweep of an unusable config is an error, not an empty success", async () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const r = await TASK_SOURCES[kind].sweep(
      { limit: -5 },
      { sourceId: "s", repoRoot: "/definitely/not/here", signal: AbortSignal.abort() },
    );
    assert.deepEqual(r.items, []);
    assert.ok(r.error, `${kind} reported "no work" for a config it cannot read`);
  }
});
