import assert from "node:assert/strict";
import test from "node:test";
import type { StandingInstructionsView } from "../src/shared/protocol.ts";
import {
  DEFAULT_CARD,
  cardsOf,
  dirtyCards,
  draftValue,
  isDirty,
  hasRepositoryEntry,
  keepMine,
  reconcileRefresh,
  reconcileSaved,
  storedValue,
  takeTheirs,
  type StandingInstructionsDraftState,
} from "../src/web/standing-instructions-reconcile.ts";

// The Standing instructions panel's draft machinery, pinned where it is a pure function
// rather than through a rendered hook - the shape `harnesses-reconcile.ts` established.
//
// The bug being guarded is the one `useTaskSources.ts:49-60` records four separate times: a
// poll response overwriting an in-flight optimistic edit, which the next commit then
// persisted. Here it would silently revert a rule an agent obeys, and the operator would
// have no way to know a text they wrote is not the text being sent.

const A = "/ws/alpha";
const B = "/ws/beta";

function viewOf(
  repositories: Record<string, string>,
  etag = "e1",
  def = "",
): StandingInstructionsView {
  return { default: def, repositories, etag };
}

function stateOf(
  view: StandingInstructionsView,
  drafts: Record<string, string> = {},
): StandingInstructionsDraftState {
  return { loaded: view, drafts, staged: [], conflict: null };
}

test("an absent key is not the same value as a key stored empty", () => {
  const view = viewOf({ [A]: "" });
  assert.equal(storedValue(view, A), "", "a stored empty string is a real entry");
  assert.equal(storedValue(view, B), null, "an absent key is absent, not empty");
  assert.equal(hasRepositoryEntry(view, A), true);
  assert.equal(hasRepositoryEntry(view, B), false);
});

test("the default card reads the document's default and is not a repository entry", () => {
  const view = viewOf({}, "e1", "house rules");
  assert.equal(storedValue(view, DEFAULT_CARD), "house rules");
  assert.equal(hasRepositoryEntry(view, DEFAULT_CARD), false);
});

test("clearing an unconfigured box is a dirty change, so an empty entry is reachable", () => {
  // Compare a draft against `stored ?? ""` instead of `stored` and this gesture becomes a
  // silent no-op - and the empty-versus-absent distinction the whole store is built on
  // would have no spelling the operator could actually produce.
  const state = stateOf(viewOf({}, "e1", "house rules"), { [A]: "" });
  assert.equal(isDirty(state, A), true);
  assert.deepEqual(dirtyCards(state), [A]);
});

test("a draft that matches what is stored is not dirty", () => {
  const state = stateOf(viewOf({ [A]: "keep" }), { [A]: "keep" });
  assert.equal(isDirty(state, A), false);
});

test("a card with no draft shows what is stored", () => {
  const state = stateOf(viewOf({ [A]: "stored" }));
  assert.equal(draftValue(state, A), "stored");
  assert.equal(draftValue(state, B), "", "an unconfigured card shows an empty box");
});

test("staged repositories appear as cards without being stored", () => {
  const state = { ...stateOf(viewOf({ [A]: "x" })), staged: [B] };
  assert.deepEqual(cardsOf(state), [A, B]);
  assert.equal(hasRepositoryEntry(state.loaded, B), false);
});

// ---- The poll-versus-edit rule ----

test("a poll landing mid-edit does not revert what the operator typed", () => {
  const state = stateOf(viewOf({ [A]: "old" }), { [A]: "the operator's new text" });
  const next = reconcileRefresh(state, viewOf({ [A]: "old" }, "e2"));
  assert.equal(
    draftValue(next, A),
    "the operator's new text",
    "a poll must never write a draft",
  );
  assert.equal(next.loaded.etag, "e2");
});

test("a poll that arrives with the same ETag changes nothing but the baseline object", () => {
  const state = stateOf(viewOf({ [A]: "old" }), { [A]: "typing" });
  const next = reconcileRefresh(state, viewOf({ [A]: "old" }, "e1"));
  assert.equal(next.conflict, null);
  assert.equal(draftValue(next, A), "typing");
});

test("a neighbour's edit is adopted rather than made into this card's conflict", () => {
  // The point of the shared ETag over N+1 documents: a save carries ONE repository's key,
  // so a concurrent change to a different repository cannot make this save wrong. Refusing
  // to adopt here would force the operator to clear a conflict about a card nobody touched.
  const state = stateOf(viewOf({ [A]: "a", [B]: "b" }), { [A]: "mine" });
  const next = reconcileRefresh(state, viewOf({ [A]: "a", [B]: "theirs" }, "e2"));
  assert.equal(next.conflict, null, "B moving is not A's conflict");
  assert.equal(next.loaded.etag, "e2", "the newer ETag is adopted so A's save can proceed");
  assert.equal(draftValue(next, A), "mine");
  assert.equal(draftValue(next, B), "theirs", "a card with no draft follows the daemon");
});

test("a move under the card being edited freezes the baseline and asks", () => {
  const state = stateOf(viewOf({ [A]: "a" }), { [A]: "mine" });
  const next = reconcileRefresh(state, viewOf({ [A]: "theirs" }, "e2"));
  assert.deepEqual(next.conflict?.cards, [A]);
  assert.equal(
    next.loaded.etag,
    "e1",
    "the baseline must not advance: it is what Revert restores and what the save CASes against",
  );
  assert.equal(draftValue(next, A), "mine", "the draft survives a conflict too");
});

test("keep mine adopts the newer document and keeps the text", () => {
  const state = reconcileRefresh(
    stateOf(viewOf({ [A]: "a" }), { [A]: "mine" }),
    viewOf({ [A]: "theirs" }, "e2"),
  );
  const kept = keepMine(state);
  assert.equal(kept.conflict, null);
  assert.equal(kept.loaded.etag, "e2");
  assert.equal(draftValue(kept, A), "mine");
  assert.equal(isDirty(kept, A), true, "still a pending decision, not silently saved");
});

test("take theirs drops only the drafts that were actually in conflict", () => {
  const state = reconcileRefresh(
    stateOf(viewOf({ [A]: "a", [B]: "b" }), { [A]: "mine", [B]: "also mine" }),
    viewOf({ [A]: "theirs", [B]: "b" }, "e2"),
  );
  const taken = takeTheirs(state);
  assert.equal(draftValue(taken, A), "theirs");
  assert.equal(
    draftValue(taken, B),
    "also mine",
    "B was never in conflict, so taking theirs must not throw B's text away",
  );
});

// ---- Saving one repository writes only that repository ----

test("saving A leaves B's stored value, B's draft, and B's Revert target alone", () => {
  // The assertion that fails if the panel ever PUTs its whole draft map: that path leaves
  // B's draft and B's baseline agreeing with each other AND wrong, so nothing on screen
  // says a rule was written that the operator never committed to.
  const state = stateOf(viewOf({ [A]: "a", [B]: "b" }), { [A]: "A new", [B]: "B in progress" });
  const saved = reconcileSaved(state, viewOf({ [A]: "A new", [B]: "b" }, "e2"), { [A]: "A new" });

  assert.equal(storedValue(saved.loaded, B), "b", "B's stored value is untouched");
  assert.equal(draftValue(saved, B), "B in progress", "B's draft survives the save");
  assert.equal(isDirty(saved, B), true, "B is still pending, not silently committed");

  const reverted = { ...saved, drafts: (() => {
    const d = { ...saved.drafts };
    delete d[B];
    return d;
  })() };
  assert.equal(
    draftValue(reverted, B),
    "b",
    "Revert on B restores what is genuinely stored, not the draft that was never sent",
  );
});

test("a save goes clean only if the draft still holds what was sent", () => {
  const state = stateOf(viewOf({ [A]: "old" }), { [A]: "sent" });
  const clean = reconcileSaved(state, viewOf({ [A]: "sent" }, "e2"), { [A]: "sent" });
  assert.equal(isDirty(clean, A), false);

  // The operator kept typing while the PUT was in flight. Their newer text is theirs.
  const stillTyping = stateOf(viewOf({ [A]: "old" }), { [A]: "sent, then typed more" });
  const dirtyAfter = reconcileSaved(
    stillTyping,
    viewOf({ [A]: "sent" }, "e2"),
    { [A]: "sent" },
  );
  assert.equal(draftValue(dirtyAfter, A), "sent, then typed more");
  assert.equal(isDirty(dirtyAfter, A), true);
});

test("removing a repository entry always goes clean", () => {
  const state = stateOf(viewOf({ [A]: "a" }, "e1", "house"), { [A]: "a" });
  const saved = reconcileSaved(state, viewOf({}, "e2", "house"), { [A]: null });
  assert.equal(hasRepositoryEntry(saved.loaded, A), false);
  assert.equal(isDirty(saved, A), false);
});
