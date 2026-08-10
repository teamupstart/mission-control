import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import { forgetInjections, recordInjection } from "../src/server/injections.ts";
import {
  createRetroCorrectionScanner,
  retroSummary,
  startRetroWorthinessPoller,
} from "../src/server/retro-worthiness.ts";
// Type only: importing the Registry as a VALUE opens the database, which the test runner's
// isolation guard refuses outside an isolated MISSION_HOME.
import type { Registry } from "../src/server/registry.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// Whether a session is worth retrospecting, which is the whole condition on the offer.
//
// The two halves are tested apart because they fail apart. `retroSummary` is arithmetic over
// two inputs; the scanner is a stateful reader of an append-only file, and every case below
// is one of the ways that read can be wrong in a way the arithmetic cannot see.

test("neither reason holding is an absent summary, not an empty one", () => {
  // ABSENT is what `Session.retro` is documented to mean by "no offer", and it is what keeps
  // the field off the wire for the overwhelming majority of sessions. A `{ reasons: [] }`
  // would be an object every card pays for to say nothing.
  assert.equal(retroSummary({ corrections: false, resolvedFindings: 0 }), null);
});

test("each reason stands alone, and both together keep a stable order", () => {
  assert.deepEqual(
    retroSummary({ corrections: true, resolvedFindings: 0 }),
    { reasons: ["corrections"] },
  );
  assert.deepEqual(
    retroSummary({ corrections: false, resolvedFindings: 2 }),
    { reasons: ["findings"] },
  );
  // Corrections first, always. The tooltip reads these back as a sentence, so an order that
  // depended on which arrived first would rewrite the same sentence between two cards.
  assert.deepEqual(
    retroSummary({ corrections: true, resolvedFindings: 2 }),
    { reasons: ["corrections", "findings"] },
  );
});

test("findings that were raised but never resolved are not a reason", () => {
  // The plan's condition is findings "that were then resolved" - the fixing is the thing
  // worth cataloguing. A session still carrying open findings has not finished, and offering
  // it a retrospective would interrupt the work rather than close it.
  assert.equal(retroSummary({ corrections: false, resolvedFindings: 0 }), null);
});

// ---- the transcript scan ---------------------------------------------------------------

function transcriptFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mc-retro-"));
  const path = join(dir, "conversation.jsonl");
  writeFileSync(path, "");
  return { path, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}

/**
 * One JSONL record in the shape Claude Code writes, appended the way the CLI appends.
 *
 * `at` is a parameter rather than a fixed constant, and that is load-bearing rather than
 * flexibility for its own sake: with one hardcoded timestamp for every synthetic message, no
 * case here can tell a fingerprint keyed on text from one keyed on text-plus-time, because
 * the time never varies. The resend case needs a real clock difference to mean anything,
 * and it was green against a build with the defect until this argument existed.
 */
function turn(
  path: string,
  role: "user" | "assistant",
  text: string,
  uuid: string,
  at = 1_700_000_000_000,
): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      type: role,
      uuid,
      timestamp: new Date(at).toISOString(),
      message: { role, content: text },
    })}\n`,
  );
}

function scanned(path: string, over: Partial<Session> = {}): Session {
  // `transcriptPath` first, which is what `resolveTranscriptPath` prefers - so the fixture
  // needs no fake home and no cwd mangling.
  return mkSession({ id: "retro-session", transcriptPath: path, ...over });
}

test("the opening brief alone is not a correction", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    turn(path, "assistant", "On it.", "a1");
    const scanner = createRetroCorrectionScanner();
    // The single most important negative here. Every dispatched session opens with exactly
    // one human turn, so a scanner that counted "any human turn" would light the offer on
    // the entire fleet and the conditioning would mean nothing.
    assert.equal(scanner.advance(scanned(path)), false);
  } finally {
    cleanup();
  }
});

test("a second human turn is the correction, and it is found on a later pass", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    turn(path, "assistant", "On it.", "a1");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), false);

    // Appended AFTER the first pass, which is the ordinary shape: the offer is decided long
    // after the session opened, and the read that decides it is incremental.
    turn(path, "user", "No - reproduce it in docker first, it never fails on the Mac", "u2");
    assert.equal(scanner.advance(session), true);
  } finally {
    cleanup();
  }
});

test("a turn the daemon typed is not a human correction", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    const packet = "/retro\n\nRun a retrospective over this session.";
    turn(path, "user", "Fix the flaky pane test", "u1");
    turn(path, "user", packet, "u2");
    // Exactly what `runRetro` records once delivery lands, under the same origin.
    recordInjection("retro-session", packet, "harness");

    const scanner = createRetroCorrectionScanner();
    // Without attribution this is the self-fulfilling case: delivering a retro would make
    // the session it was delivered to retro-worthy, so the offer would reappear the moment
    // it was taken and never go away.
    assert.equal(scanner.advance(scanned(path)), false);
  } finally {
    forgetInjections("retro-session");
    cleanup();
  }
});

test("the same human turn read twice is still one turn", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), false);

    // `size` is read before the window is, and the window reads to the file's CURRENT end,
    // so a turn written in that gap comes back from this pass AND the next. Rewriting the
    // file with the identical record is that overlap, made deterministic: counting it twice
    // would turn one opening brief into a correction nobody made. Note the record is
    // byte-identical, timestamp included - which is why this case alone could not catch a
    // fingerprint that keyed on the clock. The resend case below is the one that does.
    writeFileSync(path, "");
    turn(path, "user", "Fix the flaky pane test", "u1");
    assert.equal(scanner.advance(session), false);
  } finally {
    cleanup();
  }
});

test("resending the same instruction later is a nudge, not a correction", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), false);

    // A REAL resend: a distinct record, a distinct uuid, and - the part that matters - a
    // later wall-clock time, because the human waited before nudging. A fingerprint carrying
    // the timestamp reads this as new text and lights the offer on a session nobody
    // corrected, which is what shipped first and what this pins.
    turn(path, "user", "Fix the flaky pane test", "u2", 1_700_000_600_000);
    assert.equal(
      scanner.advance(session),
      false,
      "repeating an instruction verbatim is not the correction this looks for",
    );

    // And the session is not made permanently un-offerable by it: genuinely new guidance
    // still flips, so the dedup narrows what counts rather than muting the signal.
    turn(path, "user", "Reproduce it in docker - it never fails on the Mac", "u3", 1_700_000_900_000);
    assert.equal(scanner.advance(session), true);
  } finally {
    cleanup();
  }
});

test("a correction is not lost under a burst that overflows one incremental read", () => {
  // The permanent-loss case, and the reason the incremental read is `appended` rather than
  // `since`. `since` is TAIL-anchored: past 48 turns it returns only the newest slice and
  // drops the prefix. A scan that then advanced its offset to the file size would step over
  // the dropped turns for good - they are behind the offset on every later pass too.
  //
  // So the correction goes FIRST in the burst and is buried under more turns than one
  // `since` window can carry. Nothing about this is exotic: it is one busy session between
  // two ten-second ticks.
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), false);

    turn(path, "user", "Actually - use command grep, the wrapper misses protocol.ts", "u2");
    // Comfortably past SINCE_MAX_TURNS (48), so the correction above sits in the prefix a
    // tail-anchored read discards.
    for (let i = 0; i < 60; i += 1) {
      turn(path, "assistant", `working ${i}`, `a${i}`);
    }

    assert.equal(
      scanner.advance(session),
      true,
      "a correction buried under a burst must still be read, not stepped over",
    );
  } finally {
    cleanup();
  }
});

test("a record still being written is re-read rather than skipped", () => {
  // The second half of the same defect. Advancing to the file SIZE also stepped over a
  // partial trailing line, because a bounded reader drops it and the offset moved past it
  // anyway. `appended` reports the last complete line boundary instead, so the turn is
  // picked up once the writer finishes it.
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), false);

    // A half-written record: valid JSON never arrives, and no newline terminates it.
    const partial = JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: new Date(1_700_000_000_000).toISOString(),
      message: { role: "user", content: "reproduce it in docker first" },
    });
    appendFileSync(path, partial.slice(0, partial.length - 12));
    assert.equal(scanner.advance(session), false, "an unterminated record is not a turn yet");

    // The writer finishes it.
    appendFileSync(path, `${partial.slice(partial.length - 12)}\n`);
    assert.equal(scanner.advance(session), true, "the completed record has to be read");
  } finally {
    cleanup();
  }
});

test("a correction stays found once the transcript is gone", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    turn(path, "user", "Use command grep - the wrapper misses protocol.ts", "u2");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), true);

    // Stickiness is what makes the steady-state cost zero: a flipped session is never read
    // again, not even stat'd. It is also the honest answer - a correction that happened
    // cannot un-happen because the file it was recorded in was cleared.
    rmSync(path, { force: true });
    assert.equal(scanner.advance(session), true);
  } finally {
    cleanup();
  }
});

test("a session with no readable transcript reports nothing rather than guessing", () => {
  const scanner = createRetroCorrectionScanner();
  // Neither a transcript path nor an agent session id to derive one from. `false` here means
  // "not as far as this has read", and it is the safe direction: the offer spends a session's
  // turn, so an unknown must not light it.
  assert.equal(
    scanner.advance(mkSession({ transcriptPath: null, agentSessionId: null })),
    false,
  );
});

test("scan state is dropped for sessions that are gone", () => {
  const { path, cleanup } = transcriptFixture();
  try {
    turn(path, "user", "Fix the flaky pane test", "u1");
    const scanner = createRetroCorrectionScanner();
    const session = scanned(path);
    assert.equal(scanner.advance(session), false);

    // A long-lived daemon sees hundreds of sessions. Retaining only the live ones is what
    // keeps the scanner from accreting one entry per session it has ever watched - and the
    // registry, not this, is what remembers the ANSWER for a session that has exited.
    scanner.retain(new Set());
    // The opening brief is re-learned from scratch, so the second turn is what flips it -
    // exactly as on a cold daemon.
    turn(path, "user", "Use command grep instead", "u2");
    assert.equal(scanner.advance(session), true);
  } finally {
    cleanup();
  }
});

// ---- the exit transition ----------------------------------------------------------------
//
// The registry half - that eviction actually emits `session_exit` while the row still
// exists - needs a real Registry and therefore an isolated MISSION_HOME, so it lives in
// `test/session-exit-signal.test.ts`. What is asserted here is the poller's own wiring:
// which sessions reach the scanner, and what it does with a yes.

/** A registry stand-in exposing only the three members the poller touches. */
function pollerHost(): {
  host: Registry;
  exit: (session: Session) => void;
  recorded: string[];
} {
  const listeners = new Set<(s: Session) => void>();
  const recorded: string[] = [];
  const host = {
    liveSessions: () => [],
    recordRetroCorrections: (id: string) => { recorded.push(id); },
    onSessionExit: (fn: (s: Session) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Registry;
  return {
    host,
    exit: (session) => { for (const fn of [...listeners]) fn(session); },
    recorded,
  };
}

test("a correction that lands just before the session exits is still read", () => {
  // The window this closes: `liveSessions()` excludes anything already `exited`, and the row
  // is deleted EXIT_LINGER_MS (8s) later - shorter than this poller's own default interval.
  // A one-shot dispatch whose LAST human message was the correction leaves the live set
  // before the next tick and is gone before any later one, so a tick-only scan reads that
  // correction never, and the session silently loses the reason it was most worth a retro
  // for. The session below is never live: the transition is the only way it is ever seen.
  const { host, exit, recorded } = pollerHost();
  const seen: string[] = [];
  const stop = startRetroWorthinessPoller(host, {
    advance: (session) => { seen.push(session.id); return session.id === "exiting"; },
    retain: () => {},
  });
  try {
    exit(mkSession({ id: "exiting" }));
    assert.deepEqual(seen, ["exiting"], "the exit transition has to reach the scanner");
    assert.deepEqual(recorded, ["exiting"], "a correction found on exit must reach the registry");
  } finally {
    stop();
  }
});

test("an exit scan that finds nothing records nothing", () => {
  // The offer is conditioned, so the hook must not become a way for every session that ever
  // ended to acquire a corrections reason on its way out.
  const { host, exit, recorded } = pollerHost();
  const stop = startRetroWorthinessPoller(host, { advance: () => false, retain: () => {} });
  try {
    exit(mkSession({ id: "quiet" }));
    // Length, not `deepEqual(recorded, [])` - that narrows the array to `never[]` for
    // anything after it. See the note in session-exit-signal.test.ts.
    assert.equal(recorded.length, 0);
  } finally {
    stop();
  }
});

test("the exit hook is released when the poller stops", () => {
  // A daemon shutdown that left this subscribed would keep a dead poller reading transcripts
  // for every session the registry evicts afterwards.
  const { host, exit } = pollerHost();
  let calls = 0;
  const stop = startRetroWorthinessPoller(host, {
    advance: () => { calls += 1; return false; },
    retain: () => {},
  });
  exit(mkSession({ id: "a" }));
  assert.equal(calls, 1);
  stop();
  exit(mkSession({ id: "b" }));
  assert.equal(calls, 1, "a stopped poller must not go on scanning");
});
