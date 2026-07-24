import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRolloutIdentity } from "../src/server/discovery/codex-rollouts.ts";

const dir = mkdtempSync(join(tmpdir(), "mission-rollout-identity-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const CWD = "/repo/pooled-slot-11";
const SESSION = "019f8f60-b3ed-73c1-8b7c-d8a8a6bf4414";

/**
 * A rollout head line shaped like the real ones. `id` is the FILE's identity and `session_id`
 * the session it belongs to - a forked rollout carries a fresh `id` and the original
 * `session_id`, which is exactly why the two must not be conflated.
 */
function rollout(
  name: string,
  over: { id?: string; sessionId?: string; cwd?: string; subagent?: boolean; mtime?: number } = {},
): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    timestamp: "2026-07-23T10:28:27.000Z",
    type: "session_meta",
    payload: {
      id: over.id ?? SESSION,
      session_id: over.sessionId ?? SESSION,
      cwd: over.cwd ?? CWD,
      timestamp: "2026-07-23T10:28:27.000Z",
      ...(over.subagent ? { thread_source: "subagent" } : {}),
    },
  })}\n`);
  if (over.mtime !== undefined) utimesSync(path, over.mtime, over.mtime);
  // The selector reports realpaths, and the temp dir sits behind a symlink on macOS.
  return realpathSync(path);
}

test("a lone rollout still resolves the identity", () => {
  const path = rollout("solo");
  assert.deepEqual(selectRolloutIdentity([path], CWD), { path, sessionId: SESSION });
});

test("a forked rollout does not silence the identity it agrees on", () => {
  // The real shape: same session, two files, the fork carrying its own `id`.
  const first = rollout("primary", { mtime: 1000 });
  const forked = rollout("forked", { id: "019f8f60-b43f-7163-8311-35f7e19fad67", mtime: 2000 });

  const identity = selectRolloutIdentity([first, forked], CWD);
  assert.equal(identity?.sessionId, SESSION, "two rollouts naming one session must resolve it");
  // The newest file is the one still being appended to.
  assert.equal(identity?.path, forked);
});

test("subagent rollouts are filtered even when they are not alone", () => {
  // The filter used to be unreachable whenever more than one rollout was open.
  const main = rollout("main", { mtime: 1000 });
  const sub = rollout("subagent", { sessionId: "some-other-session", subagent: true, mtime: 2000 });

  assert.deepEqual(selectRolloutIdentity([main, sub], CWD), { path: main, sessionId: SESSION });
});

test("a rollout for another checkout is filtered even when it is not alone", () => {
  const main = rollout("mine", { mtime: 1000 });
  const other = rollout("theirs", { sessionId: "elsewhere", cwd: "/repo/other-slot", mtime: 2000 });

  assert.deepEqual(selectRolloutIdentity([main, other], CWD), { path: main, sessionId: SESSION });
});

test("genuine disagreement stays silent rather than guessing", () => {
  const a = rollout("a", { sessionId: "session-a", mtime: 1000 });
  const b = rollout("b", { sessionId: "session-b", mtime: 2000 });

  assert.equal(selectRolloutIdentity([a, b], CWD), null);
});

test("no readable rollout resolves to nothing", () => {
  assert.equal(selectRolloutIdentity([], CWD), null);
  assert.equal(selectRolloutIdentity([join(dir, "missing.jsonl")], CWD), null);
});
