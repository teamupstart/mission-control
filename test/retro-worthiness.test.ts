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
} from "../src/server/retro-worthiness.ts";
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

/** One JSONL record in the shape Claude Code writes, appended the way the CLI appends. */
function turn(path: string, role: "user" | "assistant", text: string, uuid: string): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      type: role,
      uuid,
      timestamp: new Date(1_700_000_000_000).toISOString(),
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
    // would turn one opening brief into a correction nobody made.
    writeFileSync(path, "");
    turn(path, "user", "Fix the flaky pane test", "u1");
    assert.equal(scanner.advance(session), false);
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
