import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { HookIngest } from "../src/shared/protocol.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// Drives the REAL refiner loop against a fake `claude` binary: a real spawn, a real envelope,
// the real parse ladder, the real registry write. Everything is pinned before importing the
// modules that read it at load time.
const home = mkdtempSync(join(tmpdir(), "mission-refiner-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;

// ONE fake bin whose behaviour is data, not code. `claude-cli.ts` resolves CLAUDE_BIN at
// module load (deliberately - see foreman-review.test.ts), so a test cannot swap binaries
// afterwards; reassigning the env mid-test silently keeps using the first one, which is
// exactly how an earlier draft of this file "passed" its failure cases against the GOOD bin.
// Switching a file the script reads sidesteps that entirely.
const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
const modeFile = join(bin, "mode");
/**
 * Every prompt the fake has been handed, one run per `RUN_DELIM`-terminated record.
 *
 * The refiner's floor is a statement about how many SUBPROCESSES a burst costs, and this is
 * the only place that count exists: the registry shows the last run's result, which cannot
 * tell one refine from three that overwrote each other. See `runsAsking`.
 */
const runLog = join(bin, "runs");
const RUN_DELIM = "##MISSION-RUN-END##";
const fake = join(bin, "claude.sh");
writeFileSync(
  fake,
  `#!/bin/sh
request=$(cat)
{ printf '%s\\n' "$request"; printf '%s\\n' '${RUN_DELIM}'; } >> ${runLog}
# Every reply is printed as a %s ARGUMENT, never as the printf format. A format string
# processes escapes, and POSIX leaves \\" undefined: bash (macOS /bin/sh) drops the
# backslash while dash (Ubuntu /bin/sh) keeps it, so a formatted reply is valid JSON on
# one CI runner and \\"goal\\" - which parses nowhere - on the other. As an argument the
# payload reaches stdout byte for byte, so the fixture below IS the envelope under test.
case "$(cat ${modeFile} 2>/dev/null)" in
  broken) echo "not json at all" ;;
  crash)  echo "boom" >&2; exit 1 ;;
  # A non-zero exit that lands AFTER the caller has had time to stop, so a test can put a
  # run in flight across a shutdown. Same failure as \`crash\` at the provider boundary.
  slow-crash) sleep 0.4; echo "boom" >&2; exit 1 ;;
  # Well-formed JSON carrying nothing: the shape the schema must reject rather than stamp.
  # Same fenced shape as the good reply below, so it reaches the schema the same way - a
  # malformed fixture here would "pass" the test on a parse error instead of the rejection.
  blank)  printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"steer\\",\\"objective\\":\\"Ship the Goal feature end to end\\",\\"goal\\":\\"   \\",\\"focus\\":\\"Finish the current instruction\\",\\"reason\\":\\"The instruction refines the existing work.\\"}\\n\`\`\`"}' ;;
  amend)  printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"amend\\",\\"objective\\":\\"Ship the Goal feature end to end. Also expose its intent in the Foreman drawer\\",\\"goal\\":\\"Ship the Goal feature and expose intent in the Foreman drawer\\",\\"focus\\":\\"Add the intent section to the drawer\\",\\"reason\\":\\"The instruction adds a required surface to the existing outcome.\\"}\\n\`\`\`"}' ;;
  shrink) printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"amend\\",\\"objective\\":\\"Only expose current intent in the Foreman drawer\\",\\"goal\\":\\"Expose current intent in the Foreman drawer\\",\\"focus\\":\\"Add the intent section to the drawer\\",\\"reason\\":\\"The instruction adds a required surface to the existing outcome.\\"}\\n\`\`\`"}' ;;
  negate) printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"amend\\",\\"objective\\":\\"Ship the Goal feature end to end, but drop its existing test requirement\\",\\"goal\\":\\"Ship the Goal feature without its existing test requirement\\",\\"focus\\":\\"Drop the existing test requirement\\",\\"reason\\":\\"The instruction changes the existing acceptance criteria.\\"}\\n\`\`\`"}' ;;
  rapid)
    case "$request" in
      *"also expose the current intent in the Foreman drawer"*)
        printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"amend\\",\\"objective\\":\\"Ship the Goal feature end to end. Also expose its intent in the Foreman drawer\\",\\"goal\\":\\"Ship the Goal feature and expose intent in the Foreman drawer\\",\\"focus\\":\\"Expose current intent in the drawer\\",\\"reason\\":\\"The instruction adds a required surface to the existing outcome.\\"}\\n\`\`\`"}' ;;
      *)
        # Cross the debounce floor while this exact revision remains unresolved. The refiner
        # must hold one in-flight call per session instead of paying for the same prompt twice.
        sleep 0.4
        printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"steer\\",\\"objective\\":\\"Ship the Goal feature end to end\\",\\"goal\\":\\"Ship the Goal feature end to end\\",\\"focus\\":\\"Finish the current instruction\\",\\"reason\\":\\"The instruction refines the existing work.\\"}\\n\`\`\`"}' ;;
    esac
    ;;
  replace) printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"replace\\",\\"objective\\":\\"Replace the session database with a remote service\\",\\"goal\\":\\"Replace the session database with a remote service\\",\\"focus\\":\\"Design the remote persistence layer\\",\\"reason\\":\\"The user explicitly changed the desired end state.\\"}\\n\`\`\`"}' ;;
  # A genuine schema-valid model verdict of "unclear" - distinct from a parse or transport
  # failure, which never reach the schema at all.
  model-unclear) printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"unclear\\",\\"objective\\":\\"Ship the Goal feature end to end\\",\\"goal\\":\\"Ship the Goal feature end to end\\",\\"focus\\":\\"Finish the current instruction\\",\\"reason\\":\\"The latest instruction could not be reconciled with the existing objective.\\"}\\n\`\`\`"}' ;;
  # The model fences its JSON even when told not to (observed on a real probe), so the fake
  # does too - that keeps the parse ladder inside what this test covers rather than mocked.
  *) printf %s '{"result":"\`\`\`json\\n{\\"relationship\\":\\"steer\\",\\"objective\\":\\"Ship the Goal feature end to end\\",\\"goal\\":\\"Ship the Goal feature end to end\\",\\"focus\\":\\"Finish the current instruction\\",\\"reason\\":\\"The instruction refines the existing work.\\"}\\n\`\`\`"}' ;;
esac
`,
);
chmodSync(fake, 0o755);
const setMode = (
  m:
    | "good"
    | "broken"
    | "crash"
    | "slow-crash"
    | "blank"
    | "amend"
    | "shrink"
    | "negate"
    | "rapid"
    | "replace"
    | "model-unclear",
): void =>
  writeFileSync(modeFile, m);
setMode("good");

process.env.MISSION_CLAUDE_BIN = fake;
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");
process.env.MISSION_GOAL_POLL_MS = "20";
/**
 * The ceiling on ONE `claude -p` run. Named so the deadlines below can be DERIVED from it
 * rather than guessed: a wait that expires sooner than the run it is waiting on turns a
 * momentarily starved machine into a red test, which is what a bare multiple of the floor
 * did here - 1800ms spent waiting on a spawn the refiner is willing to give 5000ms.
 */
const RUN_TIMEOUT_MS = 5000;
process.env.MISSION_GOAL_TIMEOUT_MS = String(RUN_TIMEOUT_MS);
/**
 * The per-session floor, scaled down from its 60s default so the tests below can cross it
 * without waiting a minute. Real time, not a fake clock: the refiner builds its own
 * `EvaluationDebounce` internally (the floor is policy, not a parameter), so the only honest
 * way to drive it is to make the window small. Kept an order of magnitude above the 20ms poll
 * so "inside the window" and "past the window" can't be confused for a slow tick.
 */
const FLOOR_MS = 300;
process.env.MISSION_GOAL_REFRESH_MS = String(FLOOR_MS);

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { startGoalRefiner } = await import("../src/server/goal/refiner.ts");

openDb();
after(() => {
  restoreTransport();
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys1",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    ...over,
  };
}

function evt(p: Partial<HookIngest> & Pick<HookIngest, "event">): HookIngest {
  return { agent: "claude", sessionId: null, cwd: null, transcriptPath: null, env: {}, ...p };
}

/**
 * How many headless runs have asked about one of `prompts`, by reading what the fake was
 * actually handed on stdin.
 *
 * Filtered by the instruction each run carried rather than counted outright: the log spans
 * the whole file, and a run from an earlier test appending late would otherwise show up as
 * this test's second spawn. Every test's prompts are its own, so naming them is exact.
 */
function askedPrompts(): string[] {
  if (!existsSync(runLog)) return [];
  return readFileSync(runLog, "utf8")
    .split(RUN_DELIM)
    .map((run) => run.match(/## The specific unresolved instruction to classify now\n(.*)/)?.[1])
    .filter((ask): ask is string => ask !== undefined);
}

function runsAsking(...prompts: string[]): number {
  return askedPrompts().filter((ask) => prompts.includes(ask)).length;
}

/** Poll until `fn` is true, or fail. Beats a fixed sleep: the loop is async by nature. */
async function until(
  fn: () => boolean,
  what: string,
  ms = FLOOR_MS + RUN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

function withSession(id: string, pane: string, agent: "claude" | "codex" = "claude") {
  const r = new Registry();
  r.applyDiscovery([
    mkDiscovered({
      syntheticId: id,
      agent,
      cwd: `/wt/${id}`,
      terminals: [mkMuxHandle({ paneId: pane })],
    }),
  ]);
  const s = r.snapshot().sessions.find((x) => x.id === id)!;
  return { r, s, env: { tmuxPane: pane } };
}

test("the refiner upgrades a Tier 1 goal to a model sentence", async () => {
  const { r, s, env } = withSession("r1", "%31");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "make the goal thing work please" }));
  assert.equal(r.getGoal(s.id)?.source, "heuristic", "precondition: Tier 1 wrote first");

  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.source === "model", "the goal to be refined");
  } finally {
    stop();
  }
  const g = r.getGoal(s.id);
  assert.equal(g?.text, "Ship the Goal feature end to end");
  // The refiner's input survives, so a later re-run needs no transcript race.
  assert.equal(g?.prompt, "make the goal thing work please");
  // And it reaches the card.
  assert.equal(r.snapshot().sessions.find((x) => x.id === s.id)!.goal?.text, "Ship the Goal feature end to end");
});

test("a refined goal is not re-refined until a new prompt arrives", async () => {
  // `source` IS the queue. If a refined goal stayed due, every tick would spawn a subprocess
  // for a session that has not changed - every session, forever.
  const { r, s, env } = withSession("r2", "%32");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "first ask" }));
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.source === "model", "the first refine");
    const at = r.getGoal(s.id)!.updatedAt;
    await new Promise((res) => setTimeout(res, 150)); // several poll ticks
    assert.equal(r.getGoal(s.id)?.updatedAt, at, "a settled goal was refined again");
  } finally {
    stop();
  }
});

test("an amendment updates the objective shown on the card and advances its version", async () => {
  const { r, s, env } = withSession("r14", "%44");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "ship the Goal feature" }));
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.resolvedPromptRevision === 1, "the initial objective");
    assert.equal(r.getGoal(s.id)?.objectiveVersion, 1);

    setMode("amend");
    r.applyHook(
      evt({
        event: "UserPromptSubmit",
        env,
        prompt: "also expose what Foreman is considering in its notes drawer",
      }),
    );
    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 2,
      "the amended objective",
      FLOOR_MS + RUN_TIMEOUT_MS,
    );

    const goal = r.getGoal(s.id)!;
    assert.equal(goal.relationship, "amend");
    assert.equal(goal.objectiveVersion, 2);
    assert.equal(
      goal.objective,
      "Ship the Goal feature end to end. Also expose its intent in the Foreman drawer",
    );
    assert.equal(
      r.snapshot().sessions.find((x) => x.id === s.id)?.goal?.text,
      "Ship the Goal feature and expose intent in the Foreman drawer",
    );
  } finally {
    stop();
    setMode("good");
  }
});

test("a schema-valid amendment that drops the current objective fails closed", async () => {
  const { r, s, env } = withSession("r18", "%48");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "ship the Goal feature" }));
  const stop = startGoalRefiner(r);
  const amendment = "also expose the current intent in the Foreman drawer, but keep the larger goal";
  try {
    await until(() => r.getGoal(s.id)?.resolvedPromptRevision === 1, "the initial objective");
    const prior = r.getGoal(s.id)!;
    setMode("shrink");
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: amendment }));

    await until(
      () =>
        r.getGoal(s.id)?.relationship === "unclear" &&
        r.getGoal(s.id)?.rationale?.includes("did not explicitly preserve") === true,
      "the shrinking amendment to be rejected",
      FLOOR_MS + RUN_TIMEOUT_MS,
    );
    // Cross another complete debounce window. A rejected contract stays parked instead of
    // consuming model calls or resolving itself on the next poll.
    await new Promise((resolve) => setTimeout(resolve, FLOOR_MS + 50));

    const goal = r.getGoal(s.id)!;
    assert.equal(goal.objective, prior.objective, "the larger completion contract was replaced");
    assert.equal(goal.text, prior.text, "the card adopted the model's smaller objective");
    assert.equal(goal.objectiveVersion, 1, "a rejected amendment advanced the objective version");
    assert.equal(goal.resolvedPromptRevision, 1, "a rejected amendment was marked resolved");
    assert.equal(goal.promptRevision, 2);
    assert.equal(goal.relationship, "unclear");
    assert.deepEqual(goal.pendingPrompts, [{ revision: 2, prompt: amendment }]);
    assert.equal(runsAsking(amendment), 1, "the rejected amendment retried without new context");
    assert.equal(
      r.snapshot().sessions.find((x) => x.id === s.id)?.goal?.text,
      prior.text,
      "the session card stopped showing the larger objective",
    );
  } finally {
    stop();
    setMode("good");
  }
});

test("an amendment cannot preserve by prefix and then retract a requirement", async () => {
  const { r, s, env } = withSession("r19", "%49");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "ship the Goal feature" }));
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.resolvedPromptRevision === 1, "the initial objective");
    const prior = r.getGoal(s.id)!;
    setMode("negate");
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "drop the existing test requirement" }));
    await until(
      () => r.getGoal(s.id)?.relationship === "unclear",
      "the retracting amendment to be rejected",
      FLOOR_MS + RUN_TIMEOUT_MS,
    );
    const goal = r.getGoal(s.id)!;
    assert.equal(goal.objective, prior.objective);
    assert.equal(goal.objectiveVersion, prior.objectiveVersion);
    assert.equal(goal.resolvedPromptRevision, prior.resolvedPromptRevision);
    assert.deepEqual(goal.pendingPrompts, [
      { revision: 2, prompt: "drop the existing test requirement" },
    ]);
  } finally {
    stop();
    setMode("good");
  }
});

test("a rapid amendment followed by steering preserves and applies both transitions in order", async () => {
  const { r, s, env } = withSession("r17", "%47");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "ship the Goal feature" }));
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.resolvedPromptRevision === 1, "the initial objective");
    setMode("rapid");

    // Both arrive before the debounce floor can admit another model call. The amendment must
    // remain the queue head even though the latest captured prompt is tactical steering.
    r.applyHook(
      evt({
        event: "UserPromptSubmit",
        env,
        prompt: "also expose the current intent in the Foreman drawer",
      }),
    );
    r.applyHook(
      evt({
        event: "UserPromptSubmit",
        env,
        prompt: "then add one focused regression test before running the full suite",
      }),
    );
    // The fake steering call deliberately lasts longer than the debounce floor. That makes
    // duplicate admission deterministic instead of depending on suite contention.
    assert.deepEqual(r.getGoal(s.id)?.pendingPrompts, [
      { revision: 2, prompt: "also expose the current intent in the Foreman drawer" },
      {
        revision: 3,
        prompt: "then add one focused regression test before running the full suite",
      },
    ]);

    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 3,
      "both rapid instructions to reconcile",
      FLOOR_MS * 3 + RUN_TIMEOUT_MS,
    );
    const goal = r.getGoal(s.id)!;
    assert.equal(goal.objectiveVersion, 2);
    assert.equal(
      goal.objective,
      "Ship the Goal feature end to end. Also expose its intent in the Foreman drawer",
      "the later steering instruction erased the earlier amendment",
    );
    assert.equal(goal.relationship, "steer");
    assert.deepEqual(goal.pendingPrompts, []);
    assert.equal(
      runsAsking("also expose the current intent in the Foreman drawer"),
      1,
      "the amendment was not reconciled exactly once",
    );
    assert.equal(
      runsAsking("then add one focused regression test before running the full suite"),
      1,
      "the steering instruction was not reconciled exactly once",
    );
    assert.deepEqual(
      askedPrompts().filter(
        (ask) =>
          ask === "also expose the current intent in the Foreman drawer" ||
          ask === "then add one focused regression test before running the full suite",
      ),
      [
        "also expose the current intent in the Foreman drawer",
        "then add one focused regression test before running the full suite",
      ],
      "the rapid instructions were not reconciled in capture order",
    );
  } finally {
    stop();
    setMode("good");
  }
});

test("a replacement establishes a new objective without special command vocabulary", async () => {
  const { r, s, env } = withSession("r15", "%45");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "ship the Goal feature" }));
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.resolvedPromptRevision === 1, "the initial objective");
    setMode("replace");
    r.applyHook(
      evt({
        event: "UserPromptSubmit",
        env,
        prompt: "new information changes the plan; use a remote service instead of SQLite",
      }),
    );
    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 2,
      "the replacement objective",
      FLOOR_MS + RUN_TIMEOUT_MS,
    );

    const goal = r.getGoal(s.id)!;
    assert.equal(goal.relationship, "replace");
    assert.equal(goal.objectiveVersion, 2);
    assert.equal(goal.objective, "Replace the session database with a remote service");
  } finally {
    stop();
    setMode("good");
  }
});

test("a failed refinement leaves the Tier 1 goal up and does not retry that prompt", async () => {
  // Q3's silent fallback. The card keeps the human's own words; nobody sees an error. And it
  // must not retry: `source` stays "heuristic" on failure, so without the per-prompt memory
  // every tick would re-offer this session and spawn a doomed subprocess forever.
  setMode("broken");
  const { r, s, env } = withSession("r3", "%33");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "a prompt the model chokes on" }));
  const stop = startGoalRefiner(r);
  try {
    await new Promise((res) => setTimeout(res, 400)); // many poll ticks
    const g = r.getGoal(s.id);
    assert.equal(g?.source, "heuristic", "a failure must not stamp the goal as refined");
    assert.equal(g?.text, "a prompt the model chokes on", "the Tier 1 goal was lost");
    assert.equal(g?.resolvedPromptRevision, 0, "a failed transition was marked resolved");
    assert.deepEqual(g?.pendingPrompts, [
      { revision: 1, prompt: "a prompt the model chokes on" },
    ]);
  } finally {
    stop();
    setMode("good");
  }
});

test("a new prompt retries a failed queue head before reconciling the newer instruction", async () => {
  // New context earns the blocked head one retry, but the newer instruction cannot leapfrog it.
  setMode("crash");
  const { r, s, env } = withSession("r4", "%34");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "the doomed ask" }));
  const stop = startGoalRefiner(r);
  try {
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.getGoal(s.id)?.source, "heuristic", "precondition: the first attempt failed");

    setMode("good");
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "a brand new ask" }));
    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 2,
      "both the retried head and new prompt to be refined",
      // The floor applies to the retry too - it is one refresh like any other. Budgeted for
      // the slowest LEGITIMATE path, not the typical one (~350ms): the tick that lands as the
      // wait above ends can still see the OLD prompt, because the first attempt's failure has
      // not necessarily been recorded yet, and a claim spent there makes the retry sit out a
      // SECOND floor before it even spawns. What follows is a real subprocess, so nothing
      // shorter than the refiner's own per-run ceiling can tell "starved" from "broken".
      FLOOR_MS * 2 + RUN_TIMEOUT_MS,
    );
    const goal = r.getGoal(s.id);
    assert.equal(goal?.text, "Ship the Goal feature end to end");
    assert.equal(goal?.relationship, "steer");
    assert.equal(goal?.focus, "Finish the current instruction");
    assert.deepEqual(goal?.pendingPrompts, []);
  } finally {
    stop();
    setMode("good");
  }
});

test("a burst of prompts is reconciled once per revision in capture order", async () => {
  // The cadence floor limits spawn rate, not correctness. Every instruction remains durable
  // and later steering cannot stand in for an earlier objective transition.
  const { r, s, env } = withSession("r6", "%36");
  const stop = startGoalRefiner(r);
  try {
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "first" }));
    await until(() => r.getGoal(s.id)?.source === "model", "the first refine");
    assert.equal(runsAsking("first"), 1, "precondition: the first ask cost exactly one run");

    // Three more instructions, in one turn so no poll tick can interleave. Each advances the
    // prompt revision while leaving the durable objective standing.
    for (const p of ["second", "third", "fourth"]) {
      r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: p }));
    }
    assert.equal(
      r.getGoal(s.id)?.text,
      "Ship the Goal feature end to end",
      "a steering burst replaced the durable objective",
    );
    assert.ok(
      r.getGoal(s.id)!.resolvedPromptRevision < r.getGoal(s.id)!.promptRevision,
      "the burst did not leave intent reconciliation pending",
    );

    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 4,
      "every prompt in the burst to reconcile",
      FLOOR_MS * 4 + RUN_TIMEOUT_MS,
    );
    for (const prompt of ["second", "third", "fourth"]) {
      assert.equal(runsAsking(prompt), 1, `${prompt} was not reconciled exactly once`);
    }
    assert.equal(r.getGoal(s.id)?.prompt, "fourth");
    assert.deepEqual(r.getGoal(s.id)?.pendingPrompts, []);
  } finally {
    stop();
  }
});

test("a Codex session goal is refined through the configured background provider", async () => {
  // Goal refinement is provider-independent: once the Codex hook/transcript path supplies
  // a Tier 1 goal, the configured background provider should refine it like any other session.
  const { r, s } = withSession("r5", "%35", "codex");
  r.upsertGoal(s.id, {
    prompt: "somehow",
    text: "somehow",
    source: "heuristic",
    objective: "somehow",
    focus: "somehow",
    objectiveVersion: 1,
    promptRevision: 1,
    pendingPrompts: [{ revision: 1, prompt: "somehow" }],
  });
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.source === "model", "the Codex goal to be refined");
    assert.equal(r.getGoal(s.id)?.text, "Ship the Goal feature end to end");
  } finally {
    stop();
  }
});

test("a transport failure retries on its own, without stamping unclear or needing a new prompt", async () => {
  // "crash" is a non-zero exit - a transport failure, not a model verdict. It must be
  // retried rather than latched, and it must never be recorded as relationship "unclear",
  // since that value is a claim about the human's instruction, not about the process.
  const ask = "a prompt whose classifier call keeps crashing";
  setMode("crash");
  const { r, s, env } = withSession("r20", "%50");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: ask }));
  const stop = startGoalRefiner(r);
  try {
    // Wait for proof that the provider process started, then outlast its immediate exit.
    // `source` begins as "heuristic", so it cannot establish this precondition by itself.
    await until(
      () => runsAsking(ask) === 1,
      "the first transport attempt to run",
      FLOOR_MS + RUN_TIMEOUT_MS,
    );
    await new Promise((res) => setTimeout(res, 100));
    assert.notEqual(
      r.getGoal(s.id)?.relationship,
      "unclear",
      "a transport blip must never be stamped as an ambiguity verdict",
    );

    setMode("good");
    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 1,
      "the transport failure to resolve on its own retry",
      FLOOR_MS * 2 + RUN_TIMEOUT_MS,
    );
    assert.equal(r.getGoal(s.id)?.relationship, "initial");
  } finally {
    stop();
    setMode("good");
  }
});

test("a run killed by shutdown is neither counted against the retry budget nor persisted", async () => {
  // Daemon shutdown runs `stopGoalRefiner()` and THEN kills live model runs, so a call in
  // flight across those two lines returns a non-zero exit: a transport failure by every
  // signal the provider boundary has, and really a cancellation. It must leave the row
  // untouched so the next daemon re-polls the same revision with a full budget, rather than
  // spending an attempt - or, on the third such restart, persisting "could not be reached"
  // about a machine that was only turned off.
  // Aimed at the LAST attempt on purpose. A cancellation absorbed on attempt one or two is
  // invisible either way, because those return without writing anything; it is the third
  // that persists a rationale, so that is the only attempt where mistaking a shutdown for a
  // transport failure leaves a durable, wrong claim behind.
  const ask = "a prompt whose classifier is killed by shutdown";
  setMode("crash");
  const { r, s, env } = withSession("r23", "%53");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: ask }));
  const stop = startGoalRefiner(r);
  try {
    // Burn the first two attempts on immediate failures.
    await until(() => runsAsking(ask) === 2, "two attempts to be spent", FLOOR_MS * 3 + RUN_TIMEOUT_MS);
    // The third one hangs long enough to still be in flight when the refiner stops, which is
    // the daemon's own shutdown order: `stopGoalRefiner()` first, the child killed after.
    setMode("slow-crash");
    await until(() => runsAsking(ask) === 3, "the final attempt to start", FLOOR_MS * 3 + RUN_TIMEOUT_MS);
    stop();
    // Outlast the in-flight run so its rejection lands post-stop. A fixed wait, not a poll:
    // the assertion is that nothing is ever written, which cannot be polled for.
    await new Promise((res) => setTimeout(res, 600));
    const g = r.getGoal(s.id);
    assert.equal(g?.source, "heuristic");
    assert.equal(g?.relationship, null, "a shutdown must not stamp any relationship");
    assert.equal(
      g?.rationale,
      null,
      "a run killed by shutdown was persisted as though the classifier could not be reached",
    );
    assert.equal(g?.resolvedPromptRevision, 0, "the revision must stay unresolved for the next daemon");
  } finally {
    stop();
    setMode("good");
  }
});

test("a transport failure that outlasts the retry budget latches without claiming ambiguity", async () => {
  setMode("crash");
  const { r, s, env } = withSession("r21", "%51");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "a prompt whose classifier never comes back" }));
  const stop = startGoalRefiner(r);
  try {
    // Three attempts, each spaced by the per-session debounce floor, all fail before this
    // latches. Polled rather than slept: the budget is three floors plus three run
    // durations plus up to a poll tick of granularity apiece, so any fixed sleep close
    // enough to be quick is also close enough to fail on a loaded machine.
    await until(
      () => (r.getGoal(s.id)?.rationale ?? "").includes("could not be reached after 3 attempts"),
      "three serialized transport attempts to exhaust the retry budget",
      FLOOR_MS * 4 + RUN_TIMEOUT_MS,
    );
    const g = r.getGoal(s.id);
    assert.equal(g?.source, "heuristic");
    assert.equal(g?.relationship, null, "an exhausted transport failure must not become an ambiguity verdict");
    assert.match(
      g?.rationale ?? "",
      /could not be reached after 3 attempts/,
      "the rationale must name the transport failure, not claim the instruction was unclear",
    );

    // The latch holds once retries are exhausted: further ticks against the SAME queued
    // prompt must not spend another model call even though the provider has recovered.
    setMode("good");
    await new Promise((res) => setTimeout(res, FLOOR_MS * 2));
    assert.equal(
      r.getGoal(s.id)?.source,
      "heuristic",
      "an exhausted transport failure retried again on its own",
    );

    // New human context earns the blocked head one more attempt, exactly like any other
    // latched failure.
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "a brand new ask" }));
    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 2,
      "the retried head and the new prompt to resolve",
      FLOOR_MS * 2 + RUN_TIMEOUT_MS,
    );
  } finally {
    stop();
    setMode("good");
  }
});

test("a genuine model verdict of unclear still latches", async () => {
  // Unlike a transport failure, this is a real classification the MODEL returned - the
  // schema-valid `relationship: "unclear"` reply, never touching a parse or spawn failure
  // at all. It is a durable judgment, not a retryable blip: it resolves the revision (so it
  // is never retried) and still pauses automatic wrap-up, since `resolvedSessionIntent`
  // treats "unclear" as unresolved regardless of the revision gap being closed.
  const { r, s, env } = withSession("r22", "%52");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "ship the Goal feature" }));
  const stop = startGoalRefiner(r);
  try {
    await until(() => r.getGoal(s.id)?.resolvedPromptRevision === 1, "the initial objective");

    setMode("model-unclear");
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "something the model can't reconcile" }));
    await until(
      () => r.getGoal(s.id)?.resolvedPromptRevision === 2,
      "the second revision to resolve",
      FLOOR_MS + RUN_TIMEOUT_MS,
    );

    const g = r.getGoal(s.id)!;
    assert.equal(g.relationship, "unclear");
    assert.equal(g.promptRevision, g.resolvedPromptRevision, "a genuine verdict was left unresolved");
  } finally {
    stop();
    setMode("good");
  }
});

test("a whitespace-only reply is a failure, not an empty goal", async () => {
  // The gap a pre-transform `min(1)` leaves: "   " passes it, shortens to "", and rides the
  // success path - blanking the card AND stamping `source: "model"`, which takes the session
  // out of the queue so the prompt is never retried. A failure must never be stamped as a
  // judgment, so the schema has to reject this after the shortener, not before it.
  setMode("blank");
  const { r, s, env } = withSession("r16", "%46");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "an ask the model answers with air" }));
  const stop = startGoalRefiner(r);
  try {
    await new Promise((res) => setTimeout(res, 400)); // many poll ticks
    const g = r.getGoal(s.id);
    assert.equal(g?.source, "heuristic", "an empty sentence was stamped as refined");
    assert.equal(g?.text, "an ask the model answers with air", "the card lost its Tier 1 goal");
    assert.equal(
      r.snapshot().sessions.find((x) => x.id === s.id)!.goal?.text,
      "an ask the model answers with air",
      "the card went blank",
    );
  } finally {
    stop();
    setMode("good");
  }
});
