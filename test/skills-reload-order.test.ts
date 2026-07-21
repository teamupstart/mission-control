import { test } from "node:test";
import assert from "node:assert/strict";
import { reloadOne } from "../src/server/skills/reload.ts";
import type { ReloadDeps } from "../src/server/skills/reload.ts";
import type { InjectResult } from "../src/server/actions.ts";
import type { PaneModeLine } from "../src/server/discovery/pane-mode.ts";
import type { Session } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What one reload actually DOES, in order. The ordering here is the whole safety
// argument - read the pane, then ack, then type - and an argument no test can see is
// one that quietly stops being true.

const GEN = 4;
const PRIOR = 1;

function mkSession(): Session {
  return {
    id: "s1",
    agent: "claude",
    state: "idle",
    agentSessionId: "agent-1",
    terminals: [mkMuxHandle({ session: "w", windowName: "w", windowIndex: 0, paneId: "%1" })],
    instrumented: true,
    lastActivity: 0,
    firstSeen: 0,
    startedAt: 0,
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
  // that rule exists because /no-mistakes PUSHES, so a retry IS a double-push.
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
