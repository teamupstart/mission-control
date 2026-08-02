import { test } from "node:test";
import assert from "node:assert/strict";
import { reloadOne } from "../src/server/skills/reload.ts";
import type { ReloadDeps } from "../src/server/skills/reload.ts";
import type { InjectResult } from "../src/server/actions.ts";
import type { PaneModeLine } from "../src/server/discovery/pane-mode.ts";
import type { Session } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { HARNESSES } from "../src/server/harness/index.ts";

// What one reload actually DOES, in order. The ordering here is the whole safety
// argument - read the pane, then ack, then type - and an argument no test can see is
// one that quietly stops being true.

const GEN = 4;
const PRIOR = 1;

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    state: "idle",
    cwd: "/repo",
    agentSessionId: "agent-1",
    terminals: [mkMuxHandle({ session: "w", windowName: "w", windowIndex: 0, paneId: "%1" })],
    instrumented: true,
    hooksSeen: true,
    lastActivity: 0,
    firstSeen: 0,
    startedAt: 0,
    ...over,
  } as unknown as Session;
}

const MODE_LINE: PaneModeLine = { text: "manual mode on", mode: "default" };

/** Records every effect, in the order it happened. */
function spy(over: Partial<ReloadDeps> = {}): { deps: ReloadDeps; log: string[] } {
  const log: string[] = [];
  const deps: ReloadDeps = {
    readModeLine: async () => {
      log.push("read");
      return MODE_LINE;
    },
    inject: async () => {
      log.push("inject");
      return { ok: true, pasted: true, submitVerified: true };
    },
    ack: (_key, generation) => log.push(`ack:${generation}`),
    ...over,
  };
  return { deps, log };
}

const injecting = (r: InjectResult) => async (): Promise<InjectResult> => r;

test("the pane is read BEFORE anything else - it is the gate, not a formality", async () => {
  const { deps, log } = spy();
  await reloadOne(mkSession(), GEN, PRIOR, deps);
  assert.deepEqual(log, ["read", `ack:${GEN}`, "inject"]);
});

test("no mode line means no keystroke, and no ack", async () => {
  // THE case. A dialog or menu replaces Claude's footer entirely, and a dialog is a
  // SELECT LIST: the pasted text is swallowed and the Enter answers whichever option
  // is highlighted. This is what stops a dashboard-wide broadcast pressing "Yes, I trust
  // this folder" in every pane at once. No ack either - the session is still behind.
  const { deps, log } = spy({ readModeLine: async () => null });
  const sent = await reloadOne(mkSession(), GEN, PRIOR, deps);
  assert.equal(sent, false);
  assert.deepEqual(log.filter((e) => e !== "read"), []);
});

test("the ack lands BEFORE the keystroke, so a crash costs a reload, not a repeat", async () => {
  const { deps, log } = spy();
  await reloadOne(mkSession(), GEN, PRIOR, deps);
  assert.ok(log.indexOf(`ack:${GEN}`) < log.indexOf("inject"), "ack must precede inject");
});

test("a delivered reload stays acked", async () => {
  const { deps, log } = spy();
  assert.equal(await reloadOne(mkSession(), GEN, PRIOR, deps), true);
  assert.deepEqual(log.filter((e) => e.startsWith("ack")), [`ack:${GEN}`]);
});

test("a paste that never landed rolls the ack back, so the next tick retries", async () => {
  // `pasted: false` is the codebase's one definition of positive evidence that nothing
  // reached the pane - the lock refused, or tmux rejected the target before writing.
  // This is where the reload deliberately parts from the auto-wrapup's "never retry":
  // that rule exists because a shipping instruction pushes, so a retry is a double-push.
  // /reload-skills does not push, does not commit, and re-reading a directory twice
  // reaches the same answer - so a silent miss (the panel claiming a skill is live in
  // a session that never heard) is the worse failure, not the duplicate.
  const { deps, log } = spy({ inject: injecting({ ok: false, error: "busy", pasted: false, submitVerified: false }) });
  assert.equal(await reloadOne(mkSession(), GEN, PRIOR, deps), false);
  assert.deepEqual(log.filter((e) => e.startsWith("ack")), [`ack:${GEN}`, `ack:${PRIOR}`]);
});

test("a paste that LANDED but failed to submit keeps its ack - a retry would mangle the prompt", async () => {
  // The text is sitting in the pane unsubmitted. Re-delivering pastes a second copy
  // after the first. Absence of evidence is not evidence.
  const { deps, log } = spy({ inject: injecting({ ok: false, error: "enter failed", pasted: true, submitVerified: false }) });
  assert.equal(await reloadOne(mkSession(), GEN, PRIOR, deps), false);
  assert.deepEqual(log.filter((e) => e.startsWith("ack")), [`ack:${GEN}`]);
});

test("the rollback restores the PRIOR generation, not zero", async () => {
  // Rolling back to 0 would re-offer every generation this session already acked, and
  // the pane read plus a keystroke would happen again for changes it already has.
  const { deps, log } = spy({ inject: injecting({ ok: false, pasted: false, submitVerified: false }) });
  await reloadOne(mkSession(), 9, 7, deps);
  assert.deepEqual(log.filter((e) => e.startsWith("ack")), ["ack:9", "ack:7"]);
});

test("exactly one command is typed, and it is the literal /reload-skills", async () => {
  // Fire-and-forget: the response is NOT parsed. On a removal the count correctly
  // dropped while the label still read "(no changes)" - the unload is real, the
  // message isn't trustworthy.
  const typed: string[] = [];
  const { deps } = spy({
    inject: async (_s, text) => {
      typed.push(text);
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  await reloadOne(mkSession(), GEN, PRIOR, deps);
  assert.deepEqual(typed, ["/reload-skills"]);
});

test("an embedded session reloads without a pane read, because there is no pane to read", async () => {
  // The gate above is a PANE read, and it answers null for every session that has no pane.
  // Left in force, it refuses embedded sessions for ever - the panel says a skill is on and
  // one of the machine's runtimes silently never hears about it, which is exactly the
  // "toggle that silently no-ops" failure the rollback above exists to avoid.
  const { deps, log } = spy();
  const sent = await reloadOne(mkSession({ runtime: "sdk", terminals: [] }), GEN, PRIOR, deps);
  assert.equal(sent, true);
  assert.deepEqual(log, [`ack:${GEN}`, "inject"], "no pane read, and the ack still precedes the send");
});

test("an embedded session parked on a request is not typed at either", async () => {
  // The pane read's QUESTION - is anything waiting on a human? - is answered from better
  // evidence here: a driver reports what it is blocked on as structured data. The stakes are
  // lower (a `send()` is a turn, not an Enter into whatever is highlighted), but sending a
  // slash command in front of a pending ask is still not a thing to do unprompted.
  const { deps, log } = spy();
  const parked = mkSession({
    runtime: "sdk",
    terminals: [],
    paneDialog: {
      options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }],
      highlighted: 0,
      source: "driver",
      requestId: "req-1",
      kind: "permission",
    },
  });
  assert.equal(await reloadOne(parked, GEN, PRIOR, deps), false);
  assert.deepEqual(log, [], "nothing acked and nothing typed");
});

test("a pane-backed session still pays for its pane read", async () => {
  // The driver arm is a REPLACEMENT scoped to the runtime, not a loosening of the gate. A
  // session with a pane must still prove no dialog is up before an Enter is pressed - and a
  // dialog on ITS screen is invisible to `paneDialog` when the parser could not read it,
  // which is the whole reason the read is still the last gate there.
  let reads = 0;
  const { deps, log } = spy({
    readModeLine: async () => {
      reads++;
      return null;
    },
  });
  assert.equal(await reloadOne(mkSession({ paneDialog: null }), GEN, PRIOR, deps), false);
  assert.equal(reads, 1, "the pane read still runs for a session that has a pane");
  assert.deepEqual(log, [], "and it refused: nothing acked, nothing typed");
});

test("pi reloads from a current passive binding without a mode-line read", async () => {
  const transcript = HARNESSES.pi.transcript!;
  const locate = transcript.locate;
  transcript.locate = () => "/tmp/pi-bound.jsonl";
  const typed: string[] = [];
  const { deps, log } = spy();
  deps.inject = async (_s, text) => {
    typed.push(text);
    log.push("inject");
    return { ok: true, pasted: true, submitVerified: true };
  };
  try {
    const sent = await reloadOne(
      mkSession({ agent: "pi", hooksSeen: false, instrumented: false }),
      GEN,
      PRIOR,
      deps,
    );
    assert.equal(sent, true);
    assert.deepEqual(log, [`ack:${GEN}`, "inject"]);
    assert.deepEqual(typed, ["/reload"]);
  } finally {
    transcript.locate = locate;
  }
});
