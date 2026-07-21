import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const fake = join(bin, "claude.sh");
writeFileSync(
  fake,
  `#!/bin/sh
cat > /dev/null
# Every reply is printed as a %s ARGUMENT, never as the printf format. A format string
# processes escapes, and POSIX leaves \\" undefined: bash (macOS /bin/sh) drops the
# backslash while dash (Ubuntu /bin/sh) keeps it, so a formatted reply is valid JSON on
# one CI runner and \\"goal\\" - which parses nowhere - on the other. As an argument the
# payload reaches stdout byte for byte, so the fixture below IS the envelope under test.
case "$(cat ${modeFile} 2>/dev/null)" in
  broken) echo "not json at all" ;;
  crash)  echo "boom" >&2; exit 1 ;;
  # Well-formed JSON carrying nothing: the shape the schema must reject rather than stamp.
  # Same fenced shape as the good reply below, so it reaches the schema the same way - a
  # malformed fixture here would "pass" the test on a parse error instead of the rejection.
  blank)  printf %s '{"result":"\`\`\`json\\n{\\"goal\\":\\"   \\"}\\n\`\`\`"}' ;;
  # The model fences its JSON even when told not to (observed on a real probe), so the fake
  # does too - that keeps the parse ladder inside what this test covers rather than mocked.
  *) printf %s '{"result":"\`\`\`json\\n{\\"goal\\":\\"Ship the Goal feature end to end\\"}\\n\`\`\`"}' ;;
esac
`,
);
chmodSync(fake, 0o755);
const setMode = (m: "good" | "broken" | "crash" | "blank"): void => writeFileSync(modeFile, m);
setMode("good");

process.env.MISSION_CLAUDE_BIN = fake;
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
    nomistakesGated: false,
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

/** Poll until `fn` is true, or fail. Beats a fixed sleep: the loop is async by nature. */
async function until(fn: () => boolean, what: string, ms = 4000): Promise<void> {
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
  } finally {
    stop();
    setMode("good");
  }
});

test("a new prompt gets a fresh attempt after an earlier one failed", async () => {
  // The no-retry rule is keyed on the PROMPT, so what is abandoned is one summary, never the
  // session - otherwise a single blip would freeze a card's goal for its whole life.
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
      () => r.getGoal(s.id)?.source === "model",
      "the new prompt to be refined",
      // The floor applies to the retry too - it is one refresh like any other. Budgeted for
      // the slowest LEGITIMATE path, not the typical one (~350ms): the tick that lands as the
      // wait above ends can still see the OLD prompt, because the first attempt's failure has
      // not necessarily been recorded yet, and a claim spent there makes the retry sit out a
      // SECOND floor before it even spawns. What follows is a real subprocess, so nothing
      // shorter than the refiner's own per-run ceiling can tell "starved" from "broken".
      FLOOR_MS * 2 + RUN_TIMEOUT_MS,
    );
    assert.equal(r.getGoal(s.id)?.text, "Ship the Goal feature end to end");
  } finally {
    stop();
    setMode("good");
  }
});

test("a burst of prompts costs one refinement, not one per prompt", async () => {
  // The cadence floor (Q1). A session answering rapid-fire instructions must not fork a
  // subprocess per prompt - cost is governed by cadence alone, since there is no kill switch.
  const { r, s, env } = withSession("r6", "%36");
  const stop = startGoalRefiner(r);
  try {
    r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "first" }));
    await until(() => r.getGoal(s.id)?.source === "model", "the first refine");

    // Three more instructions, well inside the floor. Tier 1 re-stamps "heuristic" on each,
    // so each one is due - and the floor is the only thing holding them.
    for (const p of ["second", "third", "fourth"]) {
      r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: p }));
    }
    await new Promise((res) => setTimeout(res, FLOOR_MS / 3));
    assert.equal(r.getGoal(s.id)?.source, "heuristic", "a prompt inside the floor was refined");
    assert.equal(r.getGoal(s.id)?.text, "fourth", "the card should still track the latest ask");

    // Past the floor, the LATEST prompt gets summarised - the earlier ones collapsed into it
    // rather than queueing a call each.
    await until(
      () => r.getGoal(s.id)?.source === "model",
      "the burst to collapse into one refine",
      // Same derivation as the retry above: one floor to wait out, then a real spawn. The
      // assertion is that the burst collapses into ONE refine, and that is proved by the
      // `heuristic` check above, never by how tight this ceiling is.
      FLOOR_MS * 2 + RUN_TIMEOUT_MS,
    );
    assert.equal(r.getGoal(s.id)?.prompt, "fourth");
  } finally {
    stop();
  }
});

test("a Codex session is never sent to the model", async () => {
  // It has no hooks, so it has no goal to refine; the card explains itself instead.
  const { r, s } = withSession("r5", "%35", "codex");
  r.upsertGoal(s.id, { prompt: "somehow", text: "somehow", source: "heuristic" });
  const stop = startGoalRefiner(r);
  try {
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(r.getGoal(s.id)?.source, "heuristic", "a Codex goal was sent to the model");
  } finally {
    stop();
  }
});

test("a whitespace-only reply is a failure, not an empty goal", async () => {
  // The gap a pre-transform `min(1)` leaves: "   " passes it, shortens to "", and rides the
  // success path - blanking the card AND stamping `source: "model"`, which takes the session
  // out of the queue so the prompt is never retried. A failure must never be stamped as a
  // judgment, so the schema has to reject this after the shortener, not before it.
  setMode("blank");
  const { r, s, env } = withSession("r6", "%36");
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
