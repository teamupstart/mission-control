import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
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
  const { prepareSpokenTranscript, reserveSpokenHandoff } = await import("../src/server/delivery-ledgers.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const key = noteKeyFor(session);
  const words = "inspect the build";
  const payload = words + "\n\nWhen you have finished this, post a report.";
  const now = Date.now();
  const queued = db.createPendingTurn({ id: "stream-receipt", noteKey: key, spokenWords: words, text: words, now });
  const claim = db.claimNextPendingTurn(key, now, queued, () => payload)!;
  const transcript = sessionMessages(session)!;
  const prepared = await prepareSpokenTranscript(key, transcript, claim.text);
  const reservation = reserveSpokenHandoff({ key, session, transcript }, claim, words, false, 0, now, prepared)!;
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

test("a live spoken cursor bounds append I/O and recovers rewritten history", { timeout: 25_000 }, async t => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  const { sessionMessages } = await import("../src/server/harness/index.ts");
  const { noteKeyFor } = await import("../src/server/registry.ts");
  const { prepareSpokenTranscript, reserveSpokenHandoff } = await import("../src/server/delivery-ledgers.ts");
  const db = await import("../src/server/db.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const key = noteKeyFor(session);
  const words = "watch the long transcript";
  const now = Date.now();
  const queued = db.createPendingTurn({ id: "stream-append-cost", noteKey: key, spokenWords: words, text: words, now });
  const claim = db.claimNextPendingTurn(key, now, queued, () => words)!;
  const receipt = reserveSpokenHandoff({ key, session, transcript: sessionMessages(session) }, claim, words, true, 0, now)!;
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, receipt.id));

  // The byte cursor and an independently unbound text receipt share this live feed.
  const native = sessionMessages(session)!;
  const missing = "an instruction the runtime has not written";
  const outbox = db.createPendingTurn({ id: "stream-unmatched-terminal", noteKey: key, spokenWords: missing, text: missing, now });
  const textClaim = db.claimNextPendingTurn(key, now, outbox, s => s)!;
  const prepared = await prepareSpokenTranscript(key, native, textClaim.text);
  const waiting = reserveSpokenHandoff({ key, session, transcript: native }, textClaim, missing, false, 0, now, prepared)!;
  assert.ok(db.retireDeliveredPendingTurn(textClaim.id, textClaim.revision, now, waiting.id));

  const padding = JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }) + "\n";
  writeFileSync(path, padding + turn("original", "ORIGINAL"));
  const res = await app.request("/api/sessions/s1/transcript/stream", { headers: { host: "127.0.0.1:7317" } });
  const reader = res.body!.getReader();
  t.after(() => reader.cancel());
  const nextFrame = async () => {
    // Keep the worker alive while the daemon's unref'd poll timer is the only other handle.
    const deadline = setTimeout(() => void reader.cancel(), 15_000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        assert.ok(!done, "SSE stream ended before the expected frame");
        const line = new TextDecoder().decode(value).split("\n").find(s => s.startsWith("data: {"));
        if (line) return JSON.parse(line.slice(6)) as TranscriptStreamMsg;
      }
    } finally {
      clearTimeout(deadline);
    }
  };
  const checkProof = (frame: TranscriptStreamMsg) => {
    assert.ok(frame.type === "init" || frame.type === "append");
    const stat = statSync(path, { bigint: true });
    const expected = createHash("sha256").update([stat.dev, stat.ino, stat.birthtimeNs].join(":") + "\n")
      .update(readFileSync(path).subarray(0, frame.pos)).digest("hex");
    assert.equal(frame.spokenCursor, expected);
  };
  const opening = await nextFrame();
  assert.ok(opening.type === "init");
  checkProof(opening);
  const handle = await open(path, "r");
  const prototype: FileHandle = Object.getPrototypeOf(handle);
  await handle.close();
  const reads = t.mock.method(prototype, "read");
  const scans = t.mock.method(native.read, "after");
  const second = turn("two", "SECOND");
  const writes = [turn("one", "FIRST") + second.slice(0, -2), second.slice(-2), turn("three", "THIRD")];
  for (const [i, write] of writes.entries()) {
    appendFileSync(path, write);
    const frame = await nextFrame();
    assert.ok(frame.type === "append");
    assert.deepEqual(frame.messages.map(m => m.text), [["FIRST"], ["SECOND"], ["THIRD"]][i]);
    checkProof(frame);
  }
  const bytesRead = (await Promise.all(reads.mock.calls.map(call => call.result))).reduce((n, r) => n + r!.bytesRead, 0);
  t.diagnostic(`Historical transcript ${opening.pos} bytes; three appends ${writes.join("").length} bytes; cursor file reads ${bytesRead} bytes`);
  assert.equal(scans.mock.callCount(), 0, "the unmatched spoken receipt starts no suffix scans on append frames");
  assert.ok(bytesRead < 64 * 1024, "three small appends have a bounded cursor read budget");

  // An unchanged length with a new revision and a larger replacement inode both reseed immediately.
  writeFileSync(path, turn("edited", "AFTER TRUNCATION"));
  assert.equal((await nextFrame()).type, "init");
  writeFileSync(path, turn("edited", "SAME SIZE CHANGE"));
  const edited = await nextFrame();
  assert.ok(edited.type === "init" && edited.refreshSpoken);
  checkProof(edited);
  const olderPages = JSON.stringify({ padding: "x".repeat(512 * 1024) }) + "\n";
  writeFileSync(path + ".next", olderPages + readFileSync(path, "utf8") + turn("rotated", "REPLACED"));
  renameSync(path + ".next", path);
  const replaced = await nextFrame();
  assert.ok(replaced.type === "init" && replaced.refreshSpoken);
  checkProof(replaced);

  // A same-inode rewrite can be coalesced with growth between polls. Even on a quiet
  // connection the already displayed words must be corrected without a reconnect.
  writeFileSync(path, readFileSync(path, "utf8").replace("SAME SIZE CHANGE", "EDITED WHILE BIG") + turn("more", "NEW"));
  const progress = await nextFrame();
  assert.ok(progress.type === "append");
  assert.deepEqual(progress.messages.map(m => m.text), ["NEW"]);
  const corrected = await nextFrame();
  assert.ok(corrected.type === "init" && corrected.refreshSpoken);
  assert.equal(corrected.messages[0]?.text, "EDITED WHILE BIG");
  checkProof(corrected);
});

test("cold transcript views verify multiple visible spoken handoff offsets off-thread, including after file replacement", async t => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  const { sessionMessages } = await import("../src/server/harness/index.ts");
  const { noteKeyFor } = await import("../src/server/registry.ts");
  const { prepareSpokenTranscript, reserveSpokenHandoff, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const db = await import("../src/server/db.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const key = noteKeyFor(session);
  const native = sessionMessages(session)!;
  const offsets: number[] = [];
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ padding: "p".repeat(2 * 1024 * 1024) }) + "\n");
  for (const id of ["visible-first", "visible-second"]) {
    const queued = db.createPendingTurn({ id, noteKey: key, spokenWords: id, text: id, now });
    const claim = db.claimNextPendingTurn(key, now, queued, text => text)!;
    const prepared = await prepareSpokenTranscript(key, native, claim.text);
    const row = reserveSpokenHandoff({ key, session, transcript: native }, claim, id, false, 0, now, prepared)!;
    offsets.push(row.transcriptOffset!);
    assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, row.id));
    appendFileSync(path, JSON.stringify({ type: "user", uuid: "native-" + id, timestamp: new Date(now).toISOString(),
      message: { role: "user", content: id } }) + "\n");
  }
  spokenLedger.bindLanded(key, native, now);
  spokenLedger.forgetCaches();
  const reader = native.read as Required<Pick<typeof native.read, "boundary" | "prepareHandoffBoundaries">>;
  const sync = t.mock.method(reader, "boundary");
  let appendDuringVerification = false;
  let rewritePrefix = false;
  const prepare = reader.prepareHandoffBoundaries.bind(reader);
  const worker = t.mock.method(reader, "prepareHandoffBoundaries", async (...args: Parameters<typeof prepare>) => {
    const result = await prepare(...args);
    if (appendDuringVerification) {
      if (rewritePrefix) {
        rewritePrefix = false;
        writeFileSync(path, readFileSync(path, "utf8").replace("pppp", "edit"));
      }
      appendFileSync(path, turn("during-verification", "appended while reading history"));
    }
    return result;
  });
  const spokenIds = (messages: import("../src/shared/types.ts").TranscriptMessage[]) =>
    messages.filter(m => m.presentation?.kind === "spoken").map(m => m.id);
  const opened = await firstFrame();
  assert.ok(opened.type === "init");
  assert.deepEqual(spokenIds(opened.messages), ["native-visible-first", "native-visible-second"]);
  assert.deepEqual(worker.mock.calls[0]?.arguments, [path, [...offsets, opened.pos], false]);
  appendFileSync(path, turn("advance-revision", "more output"));
  appendDuringVerification = true;
  const end = statSync(path).size;
  const historyPage = () => app.request("/api/sessions/s1/transcript?before=" + end, { headers: { host: "127.0.0.1:7317" } });
  const history = await historyPage();
  assert.equal(history.status, 200);
  assert.deepEqual(spokenIds((await history.json()).messages), ["native-visible-first", "native-visible-second"]);
  for (const call of worker.mock.calls.slice(1)) assert.deepEqual(call.arguments, [path, [...offsets, end], false]);
  assert.equal(worker.mock.callCount(), 3, "both worker passes tolerated growth beyond the captured page");
  rewritePrefix = true;
  const rewritten = await historyPage();
  assert.equal(rewritten.status, 200);
  assert.deepEqual(spokenIds((await rewritten.json()).messages), [], "changing earlier bytes during growth invalidates both disclosures");
  appendDuringVerification = false;
  writeFileSync(path + ".new", readFileSync(path));
  renameSync(path + ".new", path);
  const replacement = await firstFrame();
  assert.ok(replacement.type === "init");
  assert.deepEqual(spokenIds(replacement.messages), []);
  assert.equal(sync.mock.callCount(), 0);
  t.diagnostic(`Four projections of ${statSync(path).size} bytes verified ${offsets.length} handoff offsets per worker batch, with zero synchronous boundary reads`);
});

async function confirmedTerminalRecord(id: string) {
  const { noteKeyFor } = await import("../src/server/registry.ts");
  const { sessionMessages } = await import("../src/server/harness/index.ts");
  const { prepareSpokenTranscript, reserveSpokenHandoff, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const db = await import("../src/server/db.ts");
  const key = noteKeyFor(session);
  const native = sessionMessages(session)!;
  const now = Date.now();
  writeFileSync(path, turn("intro", "INTRO"));
  const pending = db.createPendingTurn({ id, noteKey: key, spokenWords: id, text: id, now });
  const claim = db.claimNextPendingTurn(key, now, pending, text => text)!;
  const prepared = await prepareSpokenTranscript(key, native, claim.text);
  const receipt = reserveSpokenHandoff({ key, session, transcript: native }, claim, id, false, 0, now, prepared)!;
  assert.ok(db.retireDeliveredPendingTurn(id, claim.revision, now, receipt.id));
  const record = JSON.stringify({ type: "user", uuid: id + "-native", timestamp: new Date(now).toISOString(),
    message: { role: "user", content: id } }) + "\n";
  appendFileSync(path, record);
  spokenLedger.bindLanded(key, native, now);
  spokenLedger.forgetCaches();
  return { read: native.read, record };
}

test("a rewrite after native parsing cannot certify stale spoken history with a cold or cached proof", async t => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  for (const cached of [false, true]) {
    const words = "received-" + cached;
    const { read } = await confirmedTerminalRecord(words);
    const end = statSync(path).size;
    const history = async () => {
      const res = await app.request("/api/sessions/s1/transcript?before=" + end, { headers: { host: "127.0.0.1:7317" } });
      assert.equal(res.status, 200);
      return res.json();
    };
    if (cached) assert.equal((await history()).messages.at(-1).presentation.kind, "spoken");
    const original = read.before.bind(read);
    const mock = t.mock.method(read, "before", (...args: Parameters<typeof original>) => {
      const page = original(...args);
      writeFileSync(path, readFileSync(path, "utf8").replace('"content":"' + words, '"content":"REPLACED-' + cached));
      return page;
    }, { times: 1 });
    const stale = await history();
    assert.equal(stale.spokenDeferred, true);
    assert.equal(stale.messages.at(-1).presentation, undefined);
    mock.mock.restore();
    const current = await history();
    assert.equal(current.messages.at(-1).text, "REPLACED-" + cached);
    assert.equal(current.messages.at(-1).presentation, undefined);
  }
});

test("a failed proof leaves native history, opening, resume and live appends readable until disclosure recovers", async t => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const words = "proof-worker-failure";
  const { read, record } = await confirmedTerminalRecord(words);
  let unreadable = false;
  const worker = t.mock.method(read as Required<Pick<typeof read, "prepareHandoffBoundaries">>, "prepareHandoffBoundaries", async () => {
    if (unreadable) return { version: read.snapshot!(path)!.version, eof: null, proofs: new Map(), unreadable: true };
    throw new Error("transient proof worker failure");
  });
  const end = statSync(path).size;
  const page = await app.request("/api/sessions/s1/transcript?before=" + end, { headers: { host: "127.0.0.1:7317" } });
  assert.equal(page.status, 200);
  const history = await page.json();
  assert.equal(history.spokenDeferred, true);
  assert.equal(history.messages.at(-1).text, words);
  assert.equal(history.messages.at(-1).presentation, undefined);
  unreadable = true; // The worker can also report an I/O error with the same stat revision.
  const res = await app.request("/api/sessions/s1/transcript/stream", { headers: { host: "127.0.0.1:7317" } });
  const reader = res.body!.getReader();
  const timer = setTimeout(() => void reader.cancel(), 15_000);
  t.after(() => { clearTimeout(timer); return reader.cancel(); });
  async function next() {
    for (;;) {
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      const line = new TextDecoder().decode(chunk.value).split("\n").find(s => s.startsWith("data: {"));
      if (line) return JSON.parse(line.slice(6)) as TranscriptStreamMsg;
    }
  }
  const init = await next();
  assert.ok(init.type === "init" && init.spokenDeferred && init.spokenCursor && init.spokenReceipt);
  assert.equal(init.messages.at(-1)?.text, words);
  assert.equal(init.messages.at(-1)?.presentation, undefined);
  appendFileSync(path, record.replace(words + "-native", "independent-copy"));
  const copy = await next();
  assert.ok(copy.type === "append" && copy.spokenDeferred && copy.pos > init.pos);
  assert.equal(copy.messages[0]?.presentation, undefined);
  const resume = await firstFrame("?" + new URLSearchParams({ from: String(init.pos),
    spokenCursor: init.spokenCursor, spokenReceipt: init.spokenReceipt }));
  assert.ok(resume.type === "resume" && resume.spokenDeferred && resume.pos === copy.pos);
  appendFileSync(path, turn("later", "New output during worker failure"));
  const progress = await next();
  assert.ok(progress.type === "append" && progress.pos > copy.pos);
  assert.equal(progress.messages[0]?.text, "New output during worker failure");
  worker.mock.restore();
  const recovered = await firstFrame();
  assert.ok(recovered.type === "init" && !recovered.spokenDeferred);
  assert.equal(recovered.messages.find(m => m.id === words + "-native")?.presentation?.kind, "spoken");
});
