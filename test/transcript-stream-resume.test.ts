import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Session, TranscriptStreamMsg } from "../src/shared/types.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// What is at stake: whether a dropped connection costs the reader their place.
//
// The conversation panel opens on a bounded window anchored at the CURRENT end of the
// transcript. Re-sending that window on every reconnect is the obvious thing to do and it
// is wrong: the anchor has moved by whatever the agent wrote meanwhile, so the pages the
// reader scrolled back to no longer join onto it and have to be discarded. On a session
// that is working - the only kind anyone watches - that is every reconnect, over a gap
// that hid nothing.
//
// `?from=` is the fix: the reader says how far it already has, and the stream continues
// from there. These pin the two halves that make it safe. It must CONTINUE when it can
// cover the gap exactly, and it must REFUSE - falling back to a fresh window - when it
// cannot, because a continuation with a hole in it is indistinguishable to the reader
// from one without.

const home = mkdtempSync(join(tmpdir(), "mission-stream-resume-"));
process.env.HARNESS_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");

const dir = mkdtempSync(join(tmpdir(), "mission-stream-resume-tx-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const path = join(dir, "session.jsonl");

function turn(id: string, text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: id,
    timestamp: new Date(1000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  })}\n`;
}

writeFileSync(path, turn("a", "FIRST") + turn("b", "SECOND"));

const session: Session = { ...mkSession(), id: "s1", agent: "claude", transcriptPath: path };
const registry = {
  getSession: (id: string) => (id === "s1" ? session : undefined),
  // A session Mission Control did not launch has no launch marker, which is what every
  // fixture here is. Answered explicitly rather than left off the fake: the stream asks this
  // per frame, and a fake that threw would be testing the seam's error guard instead of the
  // byte offsets this file is about.
  launchTurnFor: () => null,
} as unknown as Registry;

const app = buildApp({
  registry,
  reviews: {} as unknown as ReviewManager,
  tasks: {} as unknown as TaskManager,
  queues: {} as unknown as QueueManager,
});

/**
 * Open the stream and read its FIRST frame, then hang up.
 *
 * The handler polls forever, so the body is cancelled as soon as the opening frame has
 * been read - that frame is the whole subject here.
 */
async function firstFrame(query = ""): Promise<TranscriptStreamMsg> {
  const res = await app.request(`/api/sessions/s1/transcript/stream${query}`, {
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before sending a frame");
      buffered += decoder.decode(value, { stream: true });
      const line = buffered.split("\n").find((l) => l.startsWith("data: ") && l.length > 6);
      if (line) return JSON.parse(line.slice(6)) as TranscriptStreamMsg;
    }
  } finally {
    await reader.cancel();
  }
}

test("no offset opens a fresh window and says where it may be resumed", async () => {
  const frame = await firstFrame();
  assert.equal(frame.type, "init");
  if (frame.type !== "init") return;
  assert.deepEqual(frame.messages.map((m) => m.text), ["FIRST", "SECOND"]);
  assert.equal(frame.pos, statSync(path).size, "the reader is told exactly how far it now has");
  assert.equal(frame.atStart, true);
});

test("an offset the file still covers resumes instead of re-anchoring", async () => {
  // The reader holds everything; nothing was written while it was away. The point is that
  // it gets a `resume` at all - an `init` here would re-state the window and, on a longer
  // session, move the anchor its scrollback hangs from.
  const size = statSync(path).size;
  const frame = await firstFrame(`?from=${size}`);
  assert.equal(frame.type, "resume");
  if (frame.type !== "resume") return;
  assert.deepEqual(frame.messages, [], "nothing was missed, so nothing is re-sent");
  assert.equal(frame.pos, size);
});

test("a resume carries exactly the turns written while the reader was away", async () => {
  const before = statSync(path).size;
  appendFileSync(path, turn("c", "THIRD"));
  const frame = await firstFrame(`?from=${before}`);
  assert.equal(frame.type, "resume");
  if (frame.type !== "resume") return;
  assert.deepEqual(
    frame.messages.map((m) => m.text),
    ["THIRD"],
    "only the new turn - the reader already has the rest, and a replay it cannot de-dupe would double it",
  );
  assert.equal(frame.pos, statSync(path).size);
});

test("an offset past the end of the file re-seeds rather than guessing", async () => {
  // What a cleared or rotated transcript looks like to a reconnect: the anchor names a
  // byte that no longer exists, so continuing from it would invent adjacency.
  const frame = await firstFrame(`?from=${statSync(path).size + 5_000}`);
  assert.equal(frame.type, "init", "the reader is told to start over, honestly");
});

test("a gap too wide to call a reconnect re-seeds rather than replaying megabytes", async () => {
  // Past the resume ceiling this is no longer "I missed a moment". Re-seeding is both
  // cheaper and more honest than one enormous catch-up frame.
  const fat = join(dir, "fat.jsonl");
  writeFileSync(fat, turn("a", "FIRST"));
  const from = statSync(fat).size;
  appendFileSync(fat, `${JSON.stringify({
    type: "assistant",
    uuid: "big",
    timestamp: new Date(2000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }] },
  })}\n`);
  const fatSession: Session = { ...mkSession(), id: "s2", agent: "claude", transcriptPath: fat };
  const fatApp = buildApp({
    registry: {
      getSession: (id: string) => (id === "s2" ? fatSession : undefined),
      launchTurnFor: () => null,
    } as unknown as Registry,
    reviews: {} as unknown as ReviewManager,
    tasks: {} as unknown as TaskManager,
    queues: {} as unknown as QueueManager,
  });
  const res = await fatApp.request(`/api/sessions/s2/transcript/stream?from=${from}`, {
    headers: { host: "127.0.0.1:7317" },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before sending a frame");
      buffered += decoder.decode(value, { stream: true });
      const line = buffered.split("\n").find((l) => l.startsWith("data: ") && l.length > 6);
      if (line) {
        const frame = JSON.parse(line.slice(6)) as TranscriptStreamMsg;
        assert.equal(frame.type, "init");
        return;
      }
    }
  } finally {
    await reader.cancel();
  }
});

test("a malformed offset is ignored rather than trusted", async () => {
  // Query strings are user input even when only our own panel writes them. Each of these
  // must fall back to a fresh window, never reach a filesystem read as-is.
  for (const bad of ["", "abc", "-1", "1.5", "9e99"]) {
    const frame = await firstFrame(`?from=${encodeURIComponent(bad)}`);
    assert.equal(frame.type, "init", `from=${bad} should re-seed`);
  }
});

test("a byte resume after a missed text-only receipt refreshes existing words and then resumes normally", async t => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  const db = await import("../src/server/db.ts");
  const { noteKeyFor } = await import("../src/server/registry.ts");
  const { sessionMessages } = await import("../src/server/harness/index.ts");
  const { reserveSpokenHandoff } = await import("../src/server/delivery-ledgers.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const key = noteKeyFor(session);
  const words = "inspect the build";
  const payload = words + "\n\nWhen you have finished this, post a report.";
  const now = Date.now();
  const queued = db.createPendingTurn({ id: "stream-receipt", noteKey: key, spokenWords: words, text: words, now });
  const claim = db.claimNextPendingTurn(key, now, queued, () => payload)!;
  const reservation = reserveSpokenHandoff({ key, session, transcript: sessionMessages(session) }, claim, words, false, 0, now)!;
  appendFileSync(path, JSON.stringify({ type: "user", uuid: "early-user", timestamp: new Date(now).toISOString(),
    message: { role: "user", content: payload } }) + "\n");
  const early = await firstFrame();
  assert.ok(early.type === "init");
  assert.equal(early.messages.at(-1)?.text, payload);
  assert.equal(early.messages.at(-1)?.presentation, undefined);
  assert.equal(early.spokenReceipt, null);
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, reservation.id));
  db.closeDb();
  const refreshed = await firstFrame("?from=" + early.pos);
  assert.ok(refreshed.type === "init" && refreshed.refreshSpoken);
  assert.deepEqual(refreshed.messages.at(-1)?.presentation, { kind: "spoken", displayText: words, received: payload });
  assert.equal(refreshed.spokenReceipt, db.spokenTranscriptState(key)?.receipt);
  const cursorQuery = "?from=" + early.pos + "&spokenReceipt=" + refreshed.spokenReceipt + "&spokenCursor=" + refreshed.spokenCursor;
  const current = await firstFrame(cursorQuery);
  assert.ok(current.type === "resume");
  assert.deepEqual(current.messages, []);
  appendFileSync(path, turn("tail", "APPENDED"));
  const appended = await firstFrame(cursorQuery);
  assert.ok(appended.type === "resume");
  assert.deepEqual(appended.messages.map(m => m.text), ["APPENDED"]);
  // A rewrite accompanied by an append still has a larger size. Its earlier bytes
  // must prove they match the resume cursor before the new bytes can be appended.
  writeFileSync(path, readFileSync(path, "utf8").replace("FIRST", "OTHER") + turn("tail-2", "APPENDED AGAIN"));
  const rewritten = await firstFrame(cursorQuery);
  assert.ok(rewritten.type === "init" && rewritten.refreshSpoken);
  assert.equal(rewritten.messages[0]?.text, "OTHER");
  writeFileSync(path, turn("replacement", "SHORTER"));
  const truncated = await firstFrame(cursorQuery);
  assert.ok(truncated.type === "init" && truncated.refreshSpoken);
  assert.deepEqual(truncated.messages.map(m => m.text), ["SHORTER"]);
});

test("a fresh spoken stream and its resume advance while the native file grows during every proof", async t => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  const { sessionMessages } = await import("../src/server/harness/index.ts");
  const { noteKeyFor } = await import("../src/server/registry.ts");
  const db = await import("../src/server/db.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const read = sessionMessages(session)!.read;
  const snapshot = read.snapshot;
  assert.ok(snapshot);
  const key = noteKeyFor(session);
  const now = Date.now();
  const words = "keep watching the build";
  const queued = db.createPendingTurn({ id: "growing-stream", noteKey: key, spokenWords: words, text: words, now });
  const claim = db.claimNextPendingTurn(key, now, queued, () => words)!;
  const { reserveSpokenHandoff } = await import("../src/server/delivery-ledgers.ts");
  const receipt = reserveSpokenHandoff({ key, session, transcript: sessionMessages(session) }, claim, words, true, 0, now)!;
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, receipt.id));
  writeFileSync(path, turn("opening", "OPENING"));
  let sequence = 0;
  t.mock.method(read as { snapshot: typeof snapshot }, "snapshot", (file: string) => {
    const captured = snapshot(file);
    appendFileSync(file, turn("active-" + ++sequence, "OUTPUT " + sequence));
    return captured;
  });
  const opening = await firstFrame();
  assert.ok(opening.type === "init" && opening.spokenCursor);
  assert.equal(opening.messages[0]?.text, "OPENING");
  const query = new URLSearchParams({ from: String(opening.pos), spokenCursor: opening.spokenCursor });
  if (opening.spokenReceipt) query.set("spokenReceipt", opening.spokenReceipt);
  const continuation = await firstFrame("?" + query);
  assert.ok(continuation.type === "resume");
  assert.ok(continuation.pos > opening.pos && continuation.messages.length > 0);
  assert.ok(continuation.messages.every(message => message.text.startsWith("OUTPUT ")));
});
