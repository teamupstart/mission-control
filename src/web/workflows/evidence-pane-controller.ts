/**
 * The Evidence pane's controller: the lifecycle and request orchestration behind its surface.
 *
 * Separate from `run-model.ts` on purpose, and the boundary is worth stating because an earlier
 * revision of this branch got it wrong. `run-model.ts` owns what a RUN MEANS - the record
 * summaries, the parked-run blocking rule, which canonical criterion a claim answers for, which
 * claims cite which frozen image. Those are decisions about durable records, they are pure, and
 * nothing in them knows a browser exists.
 *
 * What lives here is the other half: fetching an image body, owning the object URLs that come
 * back, restoring focus when a dialog closes, and sequencing a request that flips a busy flag.
 * All of it is UI lifecycle. Putting it in the domain model made that model depend on the tour's
 * `FocusBookmark` and take React setters as arguments, which meant a change to preview focus or
 * to image loading had to edit the run model and its tests though no run semantics had moved.
 *
 * Every side effect is injected rather than reached for, so each sequence can be driven through
 * all of its outcomes without a browser - which is what these are here to make possible.
 */
import type { WorkflowEvidenceImage } from "../../shared/workflow.ts";
import type { FocusBookmark } from "../tour/focus-containment.ts";
import { evidenceActionError, restageClientItemId } from "./run-model.ts";

/**
 * The browser seam the loader reaches through, in one place rather than six inline wrappers.
 *
 * `fetch` and `URL.createObjectURL` need their receiver, so they cannot be passed as bare
 * references; each needs a wrapper. Written inline in the pane those wrappers were six closures
 * reallocated on every render. Allocated once here, they are also the seam every case below
 * substitutes: the loader takes its services as arguments, so its four outcomes are reachable
 * without a browser, and the Playwright specs exercise this real object through the
 * authenticated route.
 */
export const BROWSER_IMAGE_SERVICES = {
  fetchImpl: (path: string) => fetch(path),
  createObjectURL: (blob: Blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
};

/**
 * Fetching one frozen image body, as a sequence rather than as a chain inside an effect.
 *
 * This is the pane's other piece of real runtime behaviour and it had no test at all: the
 * request, the daemon's own refusal message, the object URL, and the teardown race where a body
 * lands after the pane has gone. That last one is the reason this is worth pinning - a URL
 * created after unmount belongs to nobody, and parking it in a list the cleanup has already
 * drained leaks it, so it is revoked on the spot instead.
 *
 * Every side effect is injected, so a test can drive all four outcomes without a browser.
 */
export async function loadFrozenImageBody(input: {
  runId: string;
  imageId: string;
  fetchImpl: (path: string) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    blob: () => Promise<Blob>;
  }>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** False once the pane has gone. Checked after the await, never before it. */
  isAlive: () => boolean;
  keepUrl: (url: string) => void;
  onLoaded: (imageId: string, url: string) => void;
  onFailed: (imageId: string, message: string) => void;
}): Promise<void> {
  try {
    const response = await input.fetchImpl(frozenImageBodyPath(input.runId, input.imageId));
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Image body could not be loaded (${response.status})`);
    }
    const url = input.createObjectURL(await response.blob());
    if (!input.isAlive()) {
      // Nothing will ever draw it, and the unmount cleanup has already drained the list it
      // would have been parked in. Released here rather than leaked on the way out.
      input.revokeObjectURL(url);
      return;
    }
    input.keepUrl(url);
    input.onLoaded(input.imageId, url);
  } catch (caught) {
    if (!input.isAlive()) return;
    input.onFailed(input.imageId, evidenceActionError(caught, "Image body could not be loaded"));
  }
}

/**
 * Start the requests one pane needs, once each.
 *
 * The "once each" is the whole rule and it lived inside a `useEffect` closure, where nothing
 * could reach it: a second render with the same images must not re-request bodies already in
 * flight, and a newly frozen image must be picked up without disturbing them.
 */
export function startFrozenImageLoads(input: {
  runId: string;
  /** Ids of the retained images this submission holds. Pruned ones ask the daemon for nothing. */
  retained: readonly string[];
  started: Set<string>;
  fetchImpl: Parameters<typeof loadFrozenImageBody>[0]["fetchImpl"];
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  isAlive: () => boolean;
  keepUrl: (url: string) => void;
  onLoaded: (imageId: string, url: string) => void;
  onFailed: (imageId: string, message: string) => void;
}): void {
  for (const imageId of input.retained) {
    if (input.started.has(imageId)) continue;
    input.started.add(imageId);
    void loadFrozenImageBody({ ...input, imageId });
  }
}

/**
 * The pane's hold on the object URLs it created, and how it lets go.
 *
 * Returns the teardown rather than performing it, because the owner is the mount: every URL the
 * pane created is released in the same commit that destroys everything drawing them, and the
 * started set is cleared so a remount requests afresh rather than believing stale work is in
 * flight.
 */
export function frozenImageBodiesLifecycle(input: {
  alive: { current: boolean };
  urls: { current: string[] };
  started: { current: Set<string> };
  revokeObjectURL: (url: string) => void;
}): () => void {
  input.alive.current = true;
  const created = input.urls.current;
  return () => {
    input.alive.current = false;
    for (const url of created) input.revokeObjectURL(url);
    created.length = 0;
    input.started.current.clear();
  };
}

/**
 * Opening and closing the preview, with the focus bookmark the round trip depends on.
 *
 * Without the bookmark the dialog takes focus for its close button and hands it to nothing on
 * the way out, dropping a keyboard reader at the top of the document. It is captured before the
 * dialog exists and cleared as it is spent, so a second close cannot restore a stale one.
 */
export function openPreview(input: {
  imageId: string;
  bookmark: { current: FocusBookmark | null };
  capture: () => FocusBookmark;
  show: (imageId: string) => void;
}): void {
  input.bookmark.current = input.capture();
  input.show(input.imageId);
}

export function closePreview(input: {
  bookmark: { current: FocusBookmark | null };
  hide: () => void;
  restore: (bookmark: FocusBookmark) => boolean;
}): boolean {
  input.hide();
  const bookmark = input.bookmark.current;
  input.bookmark.current = null;
  if (!bookmark) return false;
  return input.restore(bookmark);
}

/**
 * Staging retained bytes again, as a sequence rather than as a closure inside JSX.
 *
 * The orchestration is the part worth pinning: which id is sent, that the error is cleared
 * before the attempt rather than after it, that a refusal records the daemon's reason and does
 * NOT settle the control, and that the busy flag is released either way. Left inline in the
 * pane this was an arrow inside an object literal inside a component - `anonymous_N` to any
 * coverage report, and reachable only by clicking it in a browser.
 */
export async function runRestage(input: {
  imageId: string;
  /** Client item ids already minted this session, so a second press reuses the first. */
  minted: Map<string, string>;
  stage: (clientItemId: string) => Promise<void>;
  setBusy: (imageId: string | null) => void;
  setError: (message: string | null) => void;
  settle: (imageId: string) => void;
}): Promise<void> {
  const clientItemId = restageClientItemId(input.minted, input.imageId);
  input.setBusy(input.imageId);
  input.setError(null);
  try {
    await input.stage(clientItemId);
    input.settle(input.imageId);
  } catch (caught) {
    // Not settled: "Ready for next review" is a claim about the daemon, and the daemon refused.
    input.setError(evidenceActionError(caught, "Could not stage retained image"));
  } finally {
    input.setBusy(null);
  }
}

/**
 * Why staging THIS image was refused, or null.
 *
 * Keyed by image because a submission may freeze eight of them and each is staged on its own. A
 * single pane-wide value cannot express that: a press on one image would clear the recorded
 * failure of another whose bytes were never staged and which nothing retried, quietly removing
 * the only mark saying so.
 */
export function restageErrorFor(
  failures: ReadonlyMap<string, string>,
  imageId: string | null,
): string | null {
  if (imageId === null) return null;
  return failures.get(imageId) ?? null;
}

/**
 * The recorded failures with one image's outcome applied, as a new map.
 *
 * A press clears its OWN previous failure before it attempts anything, which is why the clearing
 * case takes the image rather than emptying the collection. `runRestage` reports the start of
 * every attempt as `null`, and a request outlives the dialog it was pressed in, so the pane can
 * be holding one image's refusal while another is mid-flight.
 */
export function withRestageFailure(
  failures: ReadonlyMap<string, string>,
  imageId: string,
  message: string | null,
): ReadonlyMap<string, string> {
  const next = new Map(failures);
  if (message === null) next.delete(imageId);
  else next.set(imageId, message);
  return next;
}

/**
 * The in-flight image ids with one image's state applied, as a new set.
 *
 * Also per image, and for the same reason read from the other end: two staging requests can
 * overlap, and the first to settle would otherwise clear a flag the second is still relying on -
 * taking "Staging…" off a card whose request has not resolved.
 */
export function withRestageBusy(
  busy: ReadonlySet<string>,
  imageId: string,
  inFlight: boolean,
): ReadonlySet<string> {
  const next = new Set(busy);
  if (inFlight) next.add(imageId);
  else next.delete(imageId);
  return next;
}

/**
 * What pressing "Use in next review" does, including deciding that it does nothing.
 *
 * The guard is the reason this is a function rather than two lines in the pane. A run record
 * rendered without a re-stage handler - history a session no longer owns - still draws every
 * frozen image, and the press has to be a no-op there rather than a call on an absent handler.
 * Left in the pane, that guard sat inside the callback the button reaches, so the only way to
 * reach it was to press a button that is never drawn without a handler. Here it is a case.
 */
export function restagePress(input: {
  image: WorkflowEvidenceImage;
  minted: Map<string, string>;
  /** Absent on a record the operator cannot stage from; the press is then a no-op. */
  onRestage: ((image: WorkflowEvidenceImage, clientItemId: string) => Promise<void>) | undefined;
  setBusy: (imageId: string | null) => void;
  setError: (message: string | null) => void;
  settle: (imageId: string) => void;
}): void {
  // Read once into a local so the closure below captures a handler TypeScript has narrowed,
  // and so the decision is made here rather than in a ternary inside the pane's JSX - where it
  // sat inside the very callback the button reaches, unreachable except by pressing a button
  // that is not drawn without a handler.
  const onRestage = input.onRestage;
  if (!onRestage) return;
  void runRestage({
    imageId: input.image.id,
    minted: input.minted,
    stage: (clientItemId) => onRestage(input.image, clientItemId),
    setBusy: input.setBusy,
    setError: input.setError,
    settle: input.settle,
  });
}

/**
 * Retry or override, with the busy flag released however the request ends.
 *
 * A `finally` rather than a `then`, because a refused retry - the daemon answers 409 when the
 * evidence has not changed - must give the button back rather than leaving it disabled with the
 * run still parked.
 */
export async function runReadinessAction(
  action: "retry" | "override",
  request: () => Promise<void>,
  setBusy: (action: "retry" | "override" | null) => void,
): Promise<void> {
  setBusy(action);
  try {
    await request();
  } finally {
    setBusy(null);
  }
}

/** The authenticated route one frozen image body is read from. */
export function frozenImageBodyPath(runId: string, imageId: string): string {
  return `/api/workflow-runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageId)}`;
}
