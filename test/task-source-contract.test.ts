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
import {
  TASK_SOURCES,
  canPushTo,
  pushToSource,
  taskSourceKinds,
} from "../src/server/task-sources/index.ts";

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

// The sentence the panel shows when `preflight` finds nothing wrong. It lives on the kind
// because what was proved differs per upstream: the panel used to hardcode "gh is reachable
// and this repo lists issues", which a Jira source would have claimed while never going
// near `gh` - a success message about somebody else's credential.
test("every kind says what a clean preflight actually proved", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const said = TASK_SOURCE_KIND_INFO[kind].preflightOk;
    assert.ok(said.trim().length > 0, `${kind} has no preflight success sentence`);
  }
  const sentences = TASK_SOURCE_KINDS.map((k) => TASK_SOURCE_KIND_INFO[k].preflightOk);
  assert.equal(new Set(sentences).size, sentences.length, "two kinds claim the same proof");
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

// ---- the outward verb ----
//
// Push is the direction a mistake cannot be taken back in: it PUBLISHES to a tracker
// other people read, and deleting the local task does not retract the issue. So the
// registry has to be exactly as trustworthy about which kinds can do it as about which
// kinds exist at all.

const instanceOf = (kind: (typeof TASK_SOURCE_KINDS)[number]) =>
  TaskSourceInstanceSchema.parse({ id: "s1", kind, repoRoot: "/repo" });

// The two halves of `canPush` live in different files on purpose - the browser reads the
// declaration, the daemon holds the implementation - and nothing but this test makes them
// agree. `true` with no `push` is a button that fails when pressed; `push` with `false` is
// a capability no operator can ever reach.
test("a kind says canPush exactly when its implementation can push", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const declared = TASK_SOURCE_KIND_INFO[kind].canPush;
    assert.equal(
      TASK_SOURCES[kind].push !== null,
      declared,
      `${kind} declares canPush=${declared} and implements the opposite`,
    );
    // The registry mirrors the declaration rather than keeping a second opinion, and
    // `canPushTo` is the only spelling a call site outside the registry may use.
    assert.equal(TASK_SOURCES[kind].canPush, declared);
    assert.equal(canPushTo(instanceOf(kind)), declared);
  }
});

// "Nothing happened, all fine" is the one answer this call may never give: the caller
// asked for an item to be published, and a silent success leaves a task looking filed
// upstream when no issue exists.
test("pushing to a kind that cannot receive is an error, never a silent success", async () => {
  const r = await pushToSource(
    instanceOf("jira"),
    { title: "t", intent: "i" },
    { sourceId: "s1", repoRoot: "/repo", signal: new AbortController().signal },
  );
  assert.equal(r.ref, null);
  assert.match(r.error!, /jira cannot receive pushed tasks/);
  // A fact, not a hedge: no subprocess ran, so nothing was published and a caller may
  // safely act on that.
  assert.equal(r.outcomeUnknown, false);
});

// The same boundary parse `sweep` gets, and it matters more here: the implementation is
// entitled to its own schema's output, and a blob an older build wrote must be refused
// BEFORE anything is spawned rather than half-way through building an argv.
test("push parses config at the boundary and refuses an unusable blob as an error", async () => {
  const inst = {
    ...instanceOf("github-issues"),
    // Refused by the schema's own refinement, so this never reaches an implementation -
    // which is what keeps this test from spawning gh against a real repo.
    config: { assignedToMe: true, unassignedOnly: true },
  };
  const r = await pushToSource(
    inst,
    { title: "t", intent: "i" },
    { sourceId: "s1", repoRoot: "/repo", signal: new AbortController().signal },
  );
  assert.equal(r.ref, null);
  assert.match(r.error!, /not valid for github-issues/);
  // Nothing was spawned, so a retry after fixing the config cannot duplicate anything.
  assert.equal(r.outcomeUnknown, false);
});
