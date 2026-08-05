import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodeOutcome } from "../src/shared/foreman.ts";
import { formDelivered } from "../src/server/actions.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { FormOutcome } from "../src/shared/protocol.ts";

// Retiring a Foreman note when the human answered the ask themselves.
//
// A note that reads "needs your decision" is a claim on someone's attention, and answering
// the question through any other channel spends it: the decision is made, the child is
// unblocked, and the suggested answer is about a question that is closed. Nothing said so,
// so the note stayed pinned with a live Approve on it until a human clicked Dismiss.
//
// Measured on a real 30-day database before the fix: two notes still `escalated` against
// reviews their human had resolved hours earlier, and a third whose `dialog:` marker the
// operator had finally cleared by hand - `resolved_by: "you"`, `last_action: "dismissed by
// you"`, three minutes after answering the question it was about.
//
// What these pin is the pair of rules that has to hold together. It must retire the note for
// the ask that was answered, and it must NOT retire one raised about anything else: a note is
// the only surface an escalation has, so a retire that fires too widely silently throws away
// a decision the human still owes, which is strictly worse than the stale note it clears.

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "mission-note-retire-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { episodesFor } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

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
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

const MARKER = "dialog:ab58f3a2cb56";

/**
 * A session carrying the note Foreman writes when it escalates, and the episode behind it.
 *
 * Both, because they are the two halves the retire has to keep consistent and they are
 * written by different calls: the note is what pins in the dashboard, the episode is the
 * record that outlives it. A fixture with only the note would let a regression that forgot
 * to stamp the record pass.
 */
function escalatedSession(id: string, marker = MARKER): { registry: InstanceType<typeof Registry>; sessionId: string } {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: id, cwd: `/wt/${id}` })]);
  registry.recordEpisode(
    id,
    {
      marker,
      situation: "structured-request",
      surface: "terminal",
      question: "running AskUserQuestion",
      recommendation: 'Choose "Push and PR, but no tasks yet".',
      brief: "It is a scope-and-delivery call, not an engineering one.",
      disposition: "escalated",
    },
    1000,
  );
  registry.upsertNote(
    id,
    {
      purpose: "Whether to publish the plan artifacts now.",
      brief: "It is a scope-and-delivery call, not an engineering one.",
      recommendation: 'Choose "Push and PR, but no tasks yet".',
      disposition: "escalated",
      lastAction: "escalated for your decision",
      handledMarker: marker,
    },
    1000,
  );
  return { registry, sessionId: id };
}

test("answering the ask yourself retires the note pinned on it", () => {
  const { registry, sessionId } = escalatedSession("r-hit");

  assert.equal(registry.retireNoteAnsweredByYou(sessionId, MARKER, 2000), true);

  const note = registry.getNote(sessionId)!;
  assert.equal(note.disposition, "skipped", "skipped owns no pin, so the strip unmounts");
  assert.equal(note.lastAction, "you answered this yourself");
  // The suggestion and the reasoning are no longer live - there is nothing left to answer.
  assert.equal(note.recommendation, null);
  assert.equal(note.brief, null);
});

test("the retired note reaches the card, which is what makes the strip go", () => {
  // Through the SESSION, not the note store. The strip renders `session.note` off an SSE
  // frame, so a retire that wrote the row without re-denormalizing would clear the database
  // and leave the pinned banner exactly where it was - the bug, with a tidier table.
  const { registry, sessionId } = escalatedSession("r-sync");
  registry.retireNoteAnsweredByYou(sessionId, MARKER, 2000);

  const card = registry.snapshot().sessions.find((s) => s.id === sessionId)!;
  assert.equal(card.note?.disposition, "skipped");
  assert.equal(card.note?.recommendation, null);
});

test("the record says you closed it without Foreman's answer being used", () => {
  const { registry, sessionId } = escalatedSession("r-record");
  registry.retireNoteAnsweredByYou(sessionId, MARKER, 2000);

  const ep = episodesFor(registry.getNote(sessionId)!.noteKey)[0]!;
  assert.equal(ep.disposition, "skipped");
  assert.equal(ep.resolvedAt, 2000);
  assert.equal(ep.resolvedBy, "you");
  assert.equal(ep.sentText, null, "nothing was delivered on Foreman's behalf");
  assert.equal(ep.sentBy, null, "so there is no author to name");
  // The evidence survives the note that stopped showing it: this is the whole reason the
  // episode is a separate table, and the retire must not be the write that erases it.
  assert.equal(ep.recommendation, 'Choose "Push and PR, but no tasks yet".');
  // Identical in the ledger to the Dismiss a human used to have to click - which is the
  // point. The outcome was always this; all that changes is who does the clicking.
  assert.equal(episodeOutcome(ep), "dismissed");
});

test("a note about a DIFFERENT ask is left alone", () => {
  // The safety half. This note is an escalation the human still owes an answer to; it simply
  // is not about the question that was just answered. Keying the retire on "this session has
  // a note" rather than on the marker would drop it silently, and an escalation has no other
  // surface - there would be nothing left to say a decision had been asked for.
  const { registry, sessionId } = escalatedSession("r-other", "state:awaiting_input:41");

  assert.equal(registry.retireNoteAnsweredByYou(sessionId, MARKER, 2000), false);

  const note = registry.getNote(sessionId)!;
  assert.equal(note.disposition, "escalated", "still yours to decide");
  assert.equal(note.recommendation, 'Choose "Push and PR, but no tasks yet".');
});

test("a note that owes nothing is not rewritten", () => {
  // `answered` and `skipped` are terminal. Re-stamping one would overwrite a decision that
  // was already reached - and would re-file its episode as a dismissal, crediting the human
  // with throwing away an answer Foreman had in fact delivered.
  for (const disposition of ["answered", "skipped"] as const) {
    const { registry, sessionId } = escalatedSession(`r-done-${disposition}`);
    registry.upsertNote(sessionId, { disposition, lastAction: "sent for you" }, 1500);

    assert.equal(registry.retireNoteAnsweredByYou(sessionId, MARKER, 2000), false);
    assert.equal(registry.getNote(sessionId)!.lastAction, "sent for you");
  }
});

test("a drafted reply awaiting your OK is retired too", () => {
  // `pending` is the other half of `noteAwaitsYou`: Foreman wrote a reply and is waiting for
  // an Approve. Once the question is answered that draft is as spent as an escalation, and
  // its Approve button is the more dangerous of the two - on the driver surface it would
  // inject the draft into a session that already had its answer.
  const { registry, sessionId } = escalatedSession("r-draft");
  registry.upsertNote(sessionId, { disposition: "pending" }, 1500);

  assert.equal(registry.retireNoteAnsweredByYou(sessionId, MARKER, 2000), true);
  assert.equal(registry.getNote(sessionId)!.disposition, "skipped");
});

// ---- what counts as an answer on a pane form -----------------------------------------
//
// The retire has a second precondition beyond the marker, and missing it was a real defect
// caught in review: `/submit-options` gated on `ok`, and a pane form reports `ok` for two
// states that delivered nothing. On the first screen of a multi-question `AskUserQuestion`
// the ticks stand and the walk advances - but a form's answers reach the agent only when its
// Submit tab is confirmed - so the note was retired while the agent was still blocked on the
// very ask it named. That is the same class of failure the marker check exists to prevent,
// arriving through the outcome instead.

test("only a submitted form counts as delivered", () => {
  assert.equal(formDelivered({ ok: true, outcome: "submitted" }), true);
});

test("every other form outcome is undelivered, so nothing may be retired on it", () => {
  // Enumerated from the type's own vocabulary rather than spot-checked, so a NEW partial
  // outcome is covered the day it is added: `formDelivered` allowlists `submitted` alone, and
  // this asserts the complement stays false without needing to be told about each new member.
  const partial: Exclude<FormOutcome, "submitted">[] = ["next-question", "unanswered"];
  for (const outcome of partial) {
    assert.equal(formDelivered({ ok: true, outcome }), false, `${outcome} sent the child nothing`);
  }
});

test("an ok with no outcome at all is not delivery either", () => {
  // The safe default. A caller that grows a new `ok` path without saying what happened must
  // not have it read as an answer.
  assert.equal(formDelivered({ ok: true }), false);
  assert.equal(formDelivered({ ok: false, error: "no menu on screen" }), false);
});

test("a session with no note, and an unknown session, are quiet no-ops", () => {
  // Every answer route calls this and almost none of them have a note to clear, so the
  // common path has to be silent rather than merely harmless.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "r-bare", cwd: "/wt/bare" })]);
  assert.equal(registry.retireNoteAnsweredByYou("r-bare", MARKER, 2000), false);
  assert.equal(registry.getNote("r-bare"), null);
  assert.equal(registry.retireNoteAnsweredByYou("r-ghost", MARKER, 2000), false);
});
