import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewItem, ServerEvent } from "../src/shared/types.ts";

// `sessionStorage` is a browser global; give the module one before it loads so the
// reload path is exercised the way a tab exercises it.
const backing = new Map<string, string>();
// Flipped by the storage-failure tests: every operation throws, as a full quota or a
// locked-down store does.
let storageFails = false;
function guard(): void {
  if (storageFails) throw new DOMException("quota exceeded", "QuotaExceededError");
}
(globalThis as { sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).sessionStorage = {
  getItem: (k) => (guard(), backing.get(k) ?? null),
  setItem: (k, v) => (guard(), void backing.set(k, v)),
  removeItem: (k) => (guard(), void backing.delete(k)),
};

const {
  EMPTY_REVIEW_DRAFT,
  clearReviewDraft,
  readReviewDraft,
  reloadReviewDraftsFromStorage,
  resetReviewDrafts,
  settleReviewDrafts,
  subscribeReviewDraft,
  updateReviewDraft,
  useReviewDraft,
  writeReviewDraft,
} = await import("../src/web/lib/review-drafts.ts");

beforeEach(() => {
  storageFails = false;
  resetReviewDrafts();
});

const typed = {
  answer: "three retries",
  note: "",
  decisions: { store: { selected: ["disk"], other: "sqlite", note: "cap at 200" } },
  approveFuture: true,
};

test("a review draft outlives the card that wrote it", () => {
  writeReviewDraft("r1", typed);
  assert.deepEqual(readReviewDraft("r1"), typed);
  assert.equal(readReviewDraft("r2"), EMPTY_REVIEW_DRAFT);
});

test("a review draft survives a page reload through sessionStorage", () => {
  writeReviewDraft("r1", typed);
  reloadReviewDraftsFromStorage();
  assert.deepEqual(readReviewDraft("r1"), typed);
});

test("an emptied draft is forgotten rather than stored", () => {
  writeReviewDraft("r1", typed);
  writeReviewDraft("r1", { ...EMPTY_REVIEW_DRAFT, decisions: { store: { selected: [], other: "", note: "" } } });
  assert.equal(readReviewDraft("r1"), EMPTY_REVIEW_DRAFT);
  assert.equal(backing.get("mission.reviewDrafts"), undefined);
});

test("clearing one review's draft leaves the others", () => {
  writeReviewDraft("r1", typed);
  writeReviewDraft("r2", { ...EMPTY_REVIEW_DRAFT, note: "keep me" });
  clearReviewDraft("r1");
  reloadReviewDraftsFromStorage();
  assert.equal(readReviewDraft("r1"), EMPTY_REVIEW_DRAFT);
  assert.equal(readReviewDraft("r2").note, "keep me");
});

test("a malformed stored entry is dropped instead of crashing a card", () => {
  backing.set(
    "mission.reviewDrafts",
    JSON.stringify({
      bad: "not an object",
      partial: { answer: 7, decisions: { q: { selected: ["a", 3], other: null } } },
    }),
  );
  reloadReviewDraftsFromStorage();
  assert.equal(readReviewDraft("bad"), EMPTY_REVIEW_DRAFT);
  assert.deepEqual(readReviewDraft("partial"), {
    answer: "",
    note: "",
    decisions: { q: { selected: ["a"], other: "", note: "" } },
    approveFuture: false,
  });

  backing.set("mission.reviewDrafts", "{not json");
  reloadReviewDraftsFromStorage();
  assert.equal(readReviewDraft("partial"), EMPTY_REVIEW_DRAFT);
});

// ---- resolved elsewhere ----

function review(id: string, status: ReviewItem["status"]): ReviewItem {
  return { id, status } as ReviewItem;
}

test("a review the daemon reports resolved takes its draft with it", () => {
  writeReviewDraft("answered", typed);
  writeReviewDraft("still-open", typed);
  settleReviewDrafts({ type: "review_upsert", review: review("answered", "answered") } as ServerEvent);
  settleReviewDrafts({ type: "review_upsert", review: review("still-open", "pending") } as ServerEvent);
  reloadReviewDraftsFromStorage();
  assert.equal(readReviewDraft("answered"), EMPTY_REVIEW_DRAFT);
  assert.deepEqual(readReviewDraft("still-open"), typed);
});

test("a removed review takes its draft with it", () => {
  writeReviewDraft("gone", typed);
  settleReviewDrafts({ type: "review_remove", id: "gone" } as ServerEvent);
  assert.equal(readReviewDraft("gone"), EMPTY_REVIEW_DRAFT);
});

test("a reconnect snapshot clears drafts for reviews resolved while away, and only those", () => {
  writeReviewDraft("dismissed", typed);
  writeReviewDraft("pending", typed);
  writeReviewDraft("absent", typed);
  settleReviewDrafts({
    type: "snapshot",
    reviews: [review("dismissed", "dismissed"), review("pending", "pending")],
  } as unknown as ServerEvent);
  assert.equal(readReviewDraft("dismissed"), EMPTY_REVIEW_DRAFT);
  assert.deepEqual(readReviewDraft("pending"), typed);
  // Absence is not evidence: a list rebuilding after a reconnect is briefly missing reviews.
  assert.deepEqual(readReviewDraft("absent"), typed);
});

test("an event about something else leaves every draft alone", () => {
  writeReviewDraft("r1", typed);
  settleReviewDrafts({ type: "session_remove", id: "r1" } as ServerEvent);
  assert.deepEqual(readReviewDraft("r1"), typed);
});

// ---- storage failure ----

/** What a freshly mounted card reads on its first render. */
function mountedAnswer(reviewId: string): string {
  function Probe() {
    const [draft] = useReviewDraft(reviewId);
    return createElement("span", null, draft.answer);
  }
  return renderToStaticMarkup(createElement(Probe));
}

test("a throwing sessionStorage still keeps the draft for the next card mount", () => {
  storageFails = true;
  assert.doesNotThrow(() => writeReviewDraft("r1", typed));
  assert.equal(mountedAnswer("r1"), "<span>three retries</span>");
  assert.doesNotThrow(() => clearReviewDraft("r1"));
  assert.equal(mountedAnswer("r1"), "<span></span>");
});

test("a sessionStorage that throws on read loads as empty instead of breaking the page", () => {
  writeReviewDraft("r1", typed);
  storageFails = true;
  assert.doesNotThrow(() => reloadReviewDraftsFromStorage());
  assert.equal(readReviewDraft("r1"), EMPTY_REVIEW_DRAFT);
});

// ---- two cards on one review ----
//
// One review can be drawn by more than one card at once (the modal, the attention inbox, an
// Ensemble member). They must share ONE live value: an edit on either is heard by both, and
// neither can write a stale picture back over the other.

test("every card subscribed to a review hears an edit made on any of them", () => {
  const heard: string[] = [];
  const offModal = subscribeReviewDraft("r1", () => heard.push("modal"));
  const offInbox = subscribeReviewDraft("r1", () => heard.push("inbox"));
  const offOther = subscribeReviewDraft("r2", () => heard.push("other review"));

  updateReviewDraft("r1", (d) => ({ ...d, answer: "typed in the modal" }));
  assert.deepEqual(heard.sort(), ["inbox", "modal"]);
  // What each card re-renders with is the one stored value, not a private copy.
  assert.equal(readReviewDraft("r1").answer, "typed in the modal");

  heard.length = 0;
  offInbox();
  clearReviewDraft("r1");
  assert.deepEqual(heard, ["modal"]);
  offModal();
  offOther();
});

test("an edit from a second card builds on the first card's edit instead of overwriting it", () => {
  // Card A types an answer; card B, mounted earlier and never re-rendered, then ticks a box.
  // Applied to B's stale picture, the tick would erase A's answer.
  updateReviewDraft("r1", (d) => ({ ...d, answer: "from the modal" }));
  updateReviewDraft("r1", (d) => ({ ...d, approveFuture: true }));
  assert.equal(readReviewDraft("r1").answer, "from the modal");
  assert.equal(readReviewDraft("r1").approveFuture, true);
});

test("a card mounted after another card's edit renders that edit", () => {
  function Card() {
    const [draft, update] = useReviewDraft("r1");
    return createElement("span", { "data-update": typeof update }, draft.answer);
  }
  updateReviewDraft("r1", (d) => ({ ...d, answer: "already typed" }));
  assert.equal(
    renderToStaticMarkup(createElement(Card)),
    '<span data-update="function">already typed</span>',
  );
});

test("an unsubscribed listener is not called and leaves nothing behind", () => {
  let calls = 0;
  const off = subscribeReviewDraft("r1", () => calls++);
  off();
  updateReviewDraft("r1", (d) => ({ ...d, note: "x" }));
  assert.equal(calls, 0);
});

test("a question moved to chat is a draft worth keeping across a reload", () => {
  writeReviewDraft("r-chat", {
    ...EMPTY_REVIEW_DRAFT,
    decisions: { q: { selected: [], other: "", note: "", chat: true } },
  });
  reloadReviewDraftsFromStorage();
  assert.deepEqual(readReviewDraft("r-chat").decisions, { q: { selected: [], other: "", note: "", chat: true } });
});
