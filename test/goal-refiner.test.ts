import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { HookIngest } from "../src/shared/protocol.ts";

// Drives the REAL refiner loop against a fake `claude` binary: a real spawn, a real envelope,
// the real parse ladder, the real registry write. Everything is pinned before importing the
// modules that read it at load time.
const home = mkdtempSync(join(tmpdir(), "fleet-refiner-"));
process.env.HARNESS_HOME = home;
process.env.FLEET_HOME = home;

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
case "$(cat ${modeFile} 2>/dev/null)" in
  broken) echo "not json at all" ;;
  crash)  echo "boom" >&2; exit 1 ;;
  # The model fences its JSON even when told not to (observed on a real probe), so the fake
  # does too - that keeps the parse ladder inside what this test covers rather than mocked.
  *) printf '{"result":"\`\`\`json\\n{\\"goal\\":\\"Ship the Goal feature end to end\\"}\\n\`\`\`"}' ;;
esac
`,
);
chmodSync(fake, 0o755);
const setMode = (m: "good" | "broken" | "crash"): void => writeFileSync(modeFile, m);
setMode("good");

process.env.FLEET_CLAUDE_BIN = fake;
process.env.FLEET_GOAL_POLL_MS = "20";
process.env.FLEET_GOAL_TIMEOUT_MS = "5000";
/**
 * The per-session floor, scaled down from its 60s default so the tests below can cross it
 * without waiting a minute. Real time, not a fake clock: the refiner builds its own
 * `EvaluationDebounce` internally (the floor is policy, not a parameter), so the only honest
 * way to drive it is to make the window small. Kept an order of magnitude above the 20ms poll
 * so "inside the window" and "past the window" can't be confused for a slow tick.
 */
const FLOOR_MS = 300;
process.env.FLEET_GOAL_REFRESH_MS = String(FLOOR_MS);

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
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    startedAt: 0,
    ...over,
  };
}

function evt(p: Partial<HookIngest> & Pick<HookIngest, "event">): HookIngest {
  return { sessionId: null, cwd: null, transcriptPath: null, env: {}, ...p };
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
      tmux: { session: "s", window: "w", windowIndex: 0, paneId: pane },
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
  // for a session that has not changed - the whole fleet, forever.
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
      FLOOR_MS * 6, // the floor applies to the retry too - it is one refresh like any other
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
      FLOOR_MS * 6,
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
