/**
 * What is at stake: the Evidence pane's lifecycle, which no other layer can check.
 *
 * These are the sequences behind the pane's surface - fetching an image body, owning the object
 * URLs that come back, restoring focus when a dialog closes, and flipping a busy flag around a
 * request. Every one used to be an arrow inline in the pane's JSX, where `renderToStaticMarkup`
 * never runs it and a coverage report calls it `anonymous_N`: the rules inside them were real
 * and unexaminable at the same time.
 *
 * They are checked here rather than in `test/workflow-runs-model.test.ts` because they are not
 * run semantics. The model answers what a run MEANS; this answers what the pane DOES, and the
 * two move for different reasons.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closePreview,
  frozenImageBodiesLifecycle,
  frozenImageBodyPath,
  loadFrozenImageBody,
  openPreview,
  restageErrorFor,
  restagePress,
  runReadinessAction,
  runRestage,
  startFrozenImageLoads,
  withRestageBusy,
  withRestageFailure,
} from "../src/web/workflows/evidence-pane-controller.ts";
import type { FocusBookmark } from "../src/web/tour/focus-containment.ts";
import type { WorkflowEvidenceImage } from "../src/shared/workflow.ts";

/** One retained frozen image, which is the only kind a re-stage is ever offered for. */
const RETAINED: WorkflowEvidenceImage = {
  id: "image-a",
  ordinal: 0,
  displayName: "pane.png",
  caption: "The Evidence pane strip",
  repositoryScope: "repo-01",
  mimeType: "image/png",
  bytes: 64,
  sha256: "c".repeat(64),
  availability: "retained",
  prunedAt: null,
  createdAt: 3,
};

test("an image body is read from the run's authenticated route, with both ids encoded", () => {
  assert.equal(
    frozenImageBodyPath("run-1", "image-a"),
    "/api/workflow-runs/run-1/images/image-a",
  );
  // Ids reach this from durable records, so neither is trusted to be path-safe.
  assert.equal(
    frozenImageBodyPath("run/1", "image?a"),
    "/api/workflow-runs/run%2F1/images/image%3Fa",
  );
});

test("each retained body is requested once, however often the pane re-renders", () => {
  const started = new Set<string>();
  const asked: string[] = [];
  const deps = {
    runId: "run-1",
    started,
    fetchImpl: async (path: string) => {
      asked.push(path);
      return { ok: true, status: 200, json: async () => null, blob: async () => ({} as Blob) };
    },
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
    isAlive: () => true,
    keepUrl: () => {},
    onLoaded: () => {},
    onFailed: () => {},
  };
  startFrozenImageLoads({ ...deps, retained: ["a", "b"] });
  assert.deepEqual(asked, [
    "/api/workflow-runs/run-1/images/a",
    "/api/workflow-runs/run-1/images/b",
  ]);
  // A second render with the same images must not re-request bodies already in flight.
  startFrozenImageLoads({ ...deps, retained: ["a", "b"] });
  assert.equal(asked.length, 2);
  // A newly frozen image is picked up without disturbing them.
  startFrozenImageLoads({ ...deps, retained: ["a", "b", "c"] });
  assert.deepEqual(asked.at(-1), "/api/workflow-runs/run-1/images/c");
  assert.deepEqual([...started].sort(), ["a", "b", "c"]);
});

test("the pane releases every object URL it created when it goes", () => {
  const alive = { current: false };
  const urls = { current: ["blob:one", "blob:two"] };
  const started = { current: new Set(["a", "b"]) };
  const revoked: string[] = [];
  const teardown = frozenImageBodiesLifecycle({
    alive,
    urls,
    started,
    revokeObjectURL: (url) => revoked.push(url),
  });
  // Alive on the way in, so a body landing mid-flight is still drawn.
  assert.equal(alive.current, true);
  teardown();
  assert.equal(alive.current, false);
  assert.deepEqual(revoked, ["blob:one", "blob:two"]);
  // The tray is emptied so a remount requests afresh rather than believing stale work is live.
  assert.deepEqual(urls.current, []);
  assert.equal(started.current.size, 0);
});

test("the preview remembers what had focus and gives it back exactly once", () => {
  const bookmark: { current: FocusBookmark | null } = { current: null };
  const shown: string[] = [];
  const mark: FocusBookmark = { element: null, id: "card", ariaLabel: null };
  openPreview({
    imageId: "image-a",
    bookmark,
    capture: () => mark,
    show: (id) => shown.push(id),
  });
  assert.equal(bookmark.current, mark);
  assert.deepEqual(shown, ["image-a"]);

  const restored: FocusBookmark[] = [];
  let hidden = 0;
  assert.equal(closePreview({
    bookmark,
    hide: () => { hidden += 1; },
    restore: (b) => { restored.push(b); return true; },
  }), true);
  assert.equal(hidden, 1);
  assert.deepEqual(restored, [mark]);
  // Spent as it is used, so a second close cannot restore a stale bookmark.
  assert.equal(bookmark.current, null);
  assert.equal(closePreview({
    bookmark,
    hide: () => { hidden += 1; },
    restore: (b) => { restored.push(b); return true; },
  }), false);
  assert.equal(hidden, 2);
  assert.equal(restored.length, 1);
});

test("fetching a frozen image body answers in one of four ways, and leaks nothing", async () => {
  const blob = { size: 3 } as unknown as Blob;
  const ok = { ok: true, status: 200, json: async () => null, blob: async () => blob };
  const base = {
    runId: "run-1",
    imageId: "image-a",
    createObjectURL: () => "blob:image-a",
    revokeObjectURL: () => {},
    isAlive: () => true,
    keepUrl: () => {},
    onLoaded: () => {},
    onFailed: () => {},
  };

  // Loaded. The URL is kept so the pane can revoke it later, and handed to the frame.
  let path = "";
  const kept: string[] = [];
  const loaded: [string, string][] = [];
  await loadFrozenImageBody({
    ...base,
    fetchImpl: async (p) => { path = p; return ok; },
    keepUrl: (url) => kept.push(url),
    onLoaded: (id, url) => loaded.push([id, url]),
  });
  assert.equal(path, "/api/workflow-runs/run-1/images/image-a");
  assert.deepEqual(kept, ["blob:image-a"]);
  assert.deepEqual(loaded, [["image-a", "blob:image-a"]]);

  // Refused, with the daemon's own reason rather than a status code.
  let failed: [string, string] | null = null;
  await loadFrozenImageBody({
    ...base,
    fetchImpl: async () => ({
      ok: false,
      status: 410,
      json: async () => ({ error: "Workflow evidence image has been pruned" }),
      blob: async () => blob,
    }),
    onFailed: (id, message) => { failed = [id, message]; },
  });
  assert.deepEqual(failed, ["image-a", "Workflow evidence image has been pruned"]);

  // Refused with no readable body: the status is the only thing left that is true.
  await loadFrozenImageBody({
    ...base,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
      blob: async () => blob,
    }),
    onFailed: (id, message) => { failed = [id, message]; },
  });
  assert.deepEqual(failed, ["image-a", "Image body could not be loaded (500)"]);

  // The teardown race: the body lands after the pane has gone. The URL belongs to nobody, and
  // the list it would have been parked in has already been drained, so it is revoked on the
  // spot rather than leaked - and nothing is handed to a frame that no longer exists.
  const revoked: string[] = [];
  let drew = false;
  await loadFrozenImageBody({
    ...base,
    fetchImpl: async () => ok,
    isAlive: () => false,
    revokeObjectURL: (url) => revoked.push(url),
    keepUrl: () => { drew = true; },
    onLoaded: () => { drew = true; },
  });
  assert.deepEqual(revoked, ["blob:image-a"]);
  assert.equal(drew, false);

  // A failure after teardown reports to nobody either.
  let reported = false;
  await loadFrozenImageBody({
    ...base,
    fetchImpl: async () => { throw new Error("gone"); },
    isAlive: () => false,
    onFailed: () => { reported = true; },
  });
  assert.equal(reported, false);
});

test("a re-stage sends the minted id, and a refusal records the reason without settling", async () => {
  const minted = new Map<string, string>();
  const calls: string[] = [];
  let sent = "";
  let busy: (string | null)[] = [];
  let error: (string | null)[] = [];
  const settled: string[] = [];
  await runRestage({
    imageId: "image-a",
    minted,
    stage: async (clientItemId) => { sent = clientItemId; calls.push("stage"); },
    setBusy: (id) => busy.push(id),
    setError: (message) => error.push(message),
    settle: (id) => settled.push(id),
  });
  assert.match(sent, /^history-/);
  // Busy on the way in, released on the way out; the error cleared BEFORE the attempt, so a
  // previous failure does not sit under a fresh press.
  assert.deepEqual(busy, ["image-a", null]);
  assert.deepEqual(error, [null]);
  assert.deepEqual(settled, ["image-a"]);

  // A refusal: the daemon's own reason, the control NOT settled - "Ready for next review" is a
  // claim about the daemon - and the busy flag released so it can be pressed again.
  busy = [];
  error = [];
  settled.length = 0;
  await runRestage({
    imageId: "image-a",
    minted,
    stage: async () => { throw new Error("Retained bytes could not be staged"); },
    setBusy: (id) => busy.push(id),
    setError: (message) => error.push(message),
    settle: (id) => settled.push(id),
  });
  assert.deepEqual(busy, ["image-a", null]);
  assert.deepEqual(error, [null, "Retained bytes could not be staged"]);
  assert.deepEqual(settled, []);
  // The same id both times: one image, one staged row.
  assert.equal(minted.size, 1);

  // A rejection with nothing readable still says something true.
  error = [];
  await runRestage({
    imageId: "image-b",
    minted,
    stage: async () => { throw "boom"; },
    setBusy: () => {},
    setError: (message) => error.push(message),
    settle: () => {},
  });
  assert.deepEqual(error, [null, "Could not stage retained image"]);
});

test("re-stage state is per image, so one press cannot rewrite another's outcome", () => {
  const refused = withRestageFailure(new Map(), "image-a", "Retained bytes could not be staged");
  assert.equal(restageErrorFor(refused, "image-a"), "Retained bytes could not be staged");
  // Another image's card and preview say nothing about it.
  assert.equal(restageErrorFor(refused, "image-b"), null);
  assert.equal(restageErrorFor(refused, null), null);
  assert.equal(restageErrorFor(new Map(), "image-a"), null);

  /*
   * A PRESS ON B DOES NOT CLEAR A. `runRestage` reports the start of every attempt as a null
   * error, which a single pane-wide value would read as "nothing has failed" - wiping the only
   * mark saying A's bytes were refused and never staged, while nothing retried them.
   */
  const bStarted = withRestageFailure(refused, "image-b", null);
  assert.equal(restageErrorFor(bStarted, "image-a"), "Retained bytes could not be staged");
  assert.equal(restageErrorFor(bStarted, "image-b"), null);
  // A press on A does clear A's own, because that attempt supersedes the one before it.
  assert.equal(restageErrorFor(withRestageFailure(refused, "image-a", null), "image-a"), null);

  // The same from the other end for the in-flight set: two requests overlap, and the first to
  // settle must not take "Staging…" off a card whose request has not resolved.
  const both = withRestageBusy(withRestageBusy(new Set(), "image-a", true), "image-b", true);
  assert.deepEqual([...both].sort(), ["image-a", "image-b"]);
  const aSettled = withRestageBusy(both, "image-a", false);
  assert.equal(aSettled.has("image-a"), false);
  assert.equal(aSettled.has("image-b"), true);
  // Every update is a fresh collection, so React sees the change.
  assert.notEqual(aSettled, both);
  assert.notEqual(bStarted, refused);
});

test("a press with no handler behind it stages nothing and says nothing", async () => {
  const minted = new Map<string, string>();
  const touched: string[] = [];
  // History a session no longer owns still draws every frozen image, and the pane offers no
  // button there - so the press must be a no-op rather than a call on an absent handler, and
  // must not flash a busy flag or an error at a reader who pressed nothing.
  restagePress({
    image: RETAINED,
    minted,
    onRestage: undefined,
    setBusy: () => touched.push("busy"),
    setError: () => touched.push("error"),
    settle: () => touched.push("settle"),
  });
  assert.deepEqual(touched, []);
  assert.equal(minted.size, 0);

  // And with a handler, the same sequence `runRestage` has its own cases for, reached through
  // the press the button actually performs.
  const busy: (string | null)[] = [];
  let sent = "";
  let staged = "";
  const settled: string[] = [];
  restagePress({
    image: RETAINED,
    minted,
    // The image itself reaches the handler, which is what the binding composer stages from.
    onRestage: async (image, clientItemId) => { staged = image.id; sent = clientItemId; },
    setBusy: (id) => busy.push(id),
    setError: () => {},
    settle: (id) => settled.push(id),
  });
  // Synchronous up to the request, so the button is already busy when the press returns.
  assert.deepEqual(busy, ["image-a"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.match(sent, /^history-/);
  assert.equal(staged, "image-a");
  assert.deepEqual(settled, ["image-a"]);
  assert.deepEqual(busy, ["image-a", null]);
});

test("a readiness action gives its button back however the request ends", async () => {
  const busy: ("retry" | "override" | null)[] = [];
  await runReadinessAction("retry", async () => {}, (state) => busy.push(state));
  assert.deepEqual(busy, ["retry", null]);

  // A refused retry - the daemon answers 409 when the evidence has not changed - must give the
  // button back rather than leaving it disabled with the run still parked.
  const refused: ("retry" | "override" | null)[] = [];
  await assert.rejects(
    runReadinessAction("retry", async () => { throw new Error("workflow_unchanged_evidence"); },
      (state) => refused.push(state)),
    /workflow_unchanged_evidence/,
  );
  assert.deepEqual(refused, ["retry", null]);

  const override: ("retry" | "override" | null)[] = [];
  await runReadinessAction("override", async () => {}, (state) => override.push(state));
  assert.deepEqual(override, ["override", null]);
});
