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
  annotateWith,
  canAnnotateTo,
  canPushTo,
  canResolveTo,
  pushToSource,
  resolveWith,
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
  // And what it FILES ships parked, for the same reason the source itself does. A sweep is a
  // machine deciding something upstream is work; the autopilot dispatching it before anyone
  // read a title is a decision nobody made, and one you can only take back by catching each
  // session already running.
  assert.equal(parsed.defaults.enabled, false, "swept tasks arrive parked for review");
});

test("a source whose upstream is curated can default every swept task to enabled", () => {
  const parsed = TaskSourceInstanceSchema.parse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
    defaults: { enabled: true },
  });
  assert.equal(parsed.defaults.enabled, true);
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

// ---- the write-back verbs ----
//
// Two more capability/verb pairs, and the same trap they exist to close: a kind that
// advertises a capability it does not implement is a switch that fails when flipped, and
// a kind that implements one it does not advertise is a feature nobody can reach.
//
// This is also where Jira's shipped `false` is held honest. Phase 1 of the write-back plan
// lands Jira unable to write back, because it genuinely is; Phase 2 flips both booleans in
// the same commit that implements the verbs, and this test is what makes doing one without
// the other impossible to merge.

const NOTICE = {
  signal: "task-completed",
  action: "annotate",
  externalId: "acme/demo#7",
  externalUrl: "https://github.com/acme/demo/issues/7",
  taskTitle: "Fix the parser",
  prUrl: "https://github.com/acme/demo/pull/9",
  repoRoot: "/repo",
  outcome: "opened a pull request",
  observedAt: 1_700_000_000_000,
} as const;

test("a kind says canAnnotate exactly when its implementation can annotate", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const declared = TASK_SOURCE_KIND_INFO[kind].canAnnotate;
    assert.equal(
      TASK_SOURCES[kind].annotate !== null,
      declared,
      `${kind} declares canAnnotate=${declared} and implements the opposite`,
    );
    assert.equal(TASK_SOURCES[kind].canAnnotate, declared);
    assert.equal(canAnnotateTo(instanceOf(kind)), declared);
  }
});

test("a kind says canResolve exactly when its implementation can resolve", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const declared = TASK_SOURCE_KIND_INFO[kind].canResolve;
    assert.equal(
      TASK_SOURCES[kind].resolve !== null,
      declared,
      `${kind} declares canResolve=${declared} and implements the opposite`,
    );
    assert.equal(TASK_SOURCES[kind].canResolve, declared);
    assert.equal(canResolveTo(instanceOf(kind)), declared);
  }
});

// The same rule `pushToSource` is held to, and it matters more on the ledger: a silent
// success marks the delivery row `delivered`, so the panel reports a comment that was
// never written and nobody ever finds out.
test("writing back to a kind that cannot is an error, never a silent success", async () => {
  const ctx = { sourceId: "s1", repoRoot: "/repo", signal: new AbortController().signal };
  const a = await annotateWith(instanceOf("jira"), NOTICE, ctx);
  assert.match(a.error!, /jira cannot write back/);
  assert.equal(a.detail, null);
  // A fact, not a hedge: no subprocess ran, so nothing was said upstream.
  assert.equal(a.outcomeUnknown, false);

  const r = await resolveWith(instanceOf("jira"), { ...NOTICE, action: "resolve" }, ctx);
  assert.match(r.error!, /jira cannot resolve/);
  assert.equal(r.outcomeUnknown, false);
});

// The boundary parse `sweep` and `push` both get. It matters here for the same reason it
// does there - the implementation is entitled to its own schema's output - and it is what
// keeps this test from spawning gh against a real repository.
test("a write-back parses config at the boundary and refuses an unusable blob", async () => {
  const inst = {
    ...instanceOf("github-issues"),
    config: { assignedToMe: true, unassignedOnly: true },
  };
  const ctx = { sourceId: "s1", repoRoot: "/repo", signal: new AbortController().signal };
  const r = await annotateWith(inst, NOTICE, ctx);
  assert.match(r.error!, /not valid for github-issues/);
  assert.equal(r.outcomeUnknown, false);
});

// ---- consent ----
//
// Three switches, and the whole feature's safety rests on what they default to. A source
// stored by a build that predates this must come back with every one of them off, or an
// upgrade starts writing on somebody's tracker without being asked.
test("a source ships with every write-back switch off", () => {
  const parsed = TaskSourceInstanceSchema.parse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
  });
  assert.deepEqual(parsed.writeback, {
    onPrOpened: false,
    onCompleted: false,
    resolve: false,
  });
});

// Refused at the schema rather than stored, because a stored switch that can never fire is
// worse than a rejected one: the panel would show auto-resolve ON while nothing resolved,
// and that is indistinguishable from an upstream that keeps refusing.
test("auto-resolve without the completion trigger is refused, not stored", () => {
  const bad = TaskSourceInstanceSchema.safeParse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
    writeback: { resolve: true },
  });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad), /needs the completion trigger/);

  const good = TaskSourceInstanceSchema.safeParse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
    writeback: { onCompleted: true, resolve: true },
  });
  assert.equal(good.success, true);
});
