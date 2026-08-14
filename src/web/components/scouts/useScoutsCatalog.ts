import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArchiveDetail,
  ArchiveSearchQuery,
  ArchiveSummary,
} from "@shared/archives.ts";
import { ARCHIVE_SEARCH_LIMITS } from "@shared/archives.ts";
import { api } from "../../lib/api.ts";
import type { ScoutFilters } from "../../workflows/useWorkflowRoute.ts";

/**
 * The Scouts page's data, and the only place that talks to the archive routes.
 *
 * Three rules shape all of it:
 *
 * 1. **A failed read is not an empty library.** Every state below can say "could not ask",
 *    and the page draws that differently from "nothing archived yet". Getting this wrong
 *    would tell an operator their evidence is gone when the daemon merely refused.
 * 2. **The browser never polls.** One `archivesRevision` counter arrives from the existing
 *    event stream - incremented once per reconciled batch and once per reconnect - and a
 *    change refetches the CURRENT window. There is no interval anywhere in this file.
 * 3. **Requests are superseded, not raced.** Every fetch carries an abort signal owned by
 *    this hook, so a keystroke, a filter change or a revision tick cancels the read it
 *    replaces instead of letting two answers land out of order.
 */

/** How the result list is doing, kept apart from "is a request in flight". */
export type ScoutListState =
  /** No window has landed yet. The rail shows a loading state, not an empty one. */
  | "first"
  /** A window is on screen and a newer one is being fetched behind it. */
  | "refreshing"
  | "ready"
  /** The daemon refused or was unreachable. NEVER drawn as an empty history. */
  | "error";

export type ScoutDetailState = "idle" | "loading" | "ready" | "error";

export interface ScoutsCatalog {
  archives: ArchiveSummary[];
  /** Where the library lives on this machine, straight from the list route. */
  libraryPath: string | null;
  listState: ScoutListState;
  listError: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  detail: ArchiveDetail | null;
  detailState: ScoutDetailState;
  detailError: string | null;
  /** Refetch the current window and the open archive, e.g. after a delete. */
  refresh: () => void;
}

/** The filters, in the shape the API takes. One place converts, so no component does. */
function toQuery(filters: ScoutFilters | undefined): Partial<ArchiveSearchQuery> {
  return {
    ...(filters?.q ? { q: filters.q } : {}),
    ...(filters?.producer ? { producer: filters.producer } : {}),
    ...(filters?.repo ? { repo: filters.repo } : {}),
    ...(filters?.agent ? { agent: filters.agent } : {}),
    ...(filters?.status ? { status: filters.status } : {}),
    ...(filters?.from !== undefined ? { from: filters.from } : {}),
    ...(filters?.to !== undefined ? { to: filters.to } : {}),
    limit: ARCHIVE_SEARCH_LIMITS.defaultLimit,
  };
}

/**
 * One stable string per filter set.
 *
 * The effect below depends on THIS rather than on the filters object, because the route
 * hands back a fresh object on every render and an object identity in a dependency array
 * would refetch the whole window on every keystroke anywhere in the app.
 */
/**
 * May a continuation's result be applied to what is on screen?
 *
 * Only when it was not cancelled AND the window it was started for is still the window
 * being shown. Pulled out as a plain function because it is the whole correctness argument
 * for pagination, and worth testing without a DOM: a "Load more" that resolves after the
 * operator changed the search must not append the old search's rows or hand over the old
 * search's cursor.
 */
export function continuationApplies(
  startedInGeneration: number,
  currentGeneration: number,
  aborted: boolean,
): boolean {
  return !aborted && startedInGeneration === currentGeneration;
}

/**
 * Append a continuation's rows, dropping any the window already holds.
 *
 * A bundle reconciled between the two requests can shift the window boundary and repeat a
 * row; React would warn about the duplicate key while the operator simply saw the same
 * archive twice.
 */
export function appendArchives(
  prev: readonly ArchiveSummary[],
  incoming: readonly ArchiveSummary[],
): ArchiveSummary[] {
  const seen = new Set(prev.map((archive) => archive.key));
  return [...prev, ...incoming.filter((archive) => !seen.has(archive.key))];
}

function filterKey(filters: ScoutFilters | undefined): string {
  return JSON.stringify(toQuery(filters));
}

export function useScoutsCatalog({
  filters,
  archiveKey,
  revision,
}: {
  filters: ScoutFilters | undefined;
  archiveKey: string | null;
  /** `archivesRevision` from the event stream: bumps per reconciled batch and per reconnect. */
  revision: number;
}): ScoutsCatalog {
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<ScoutListState>("first");
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [detailState, setDetailState] = useState<ScoutDetailState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Bumped by `refresh()` to re-run the window effect without touching the route. */
  const [manual, setManual] = useState(0);

  const key = filterKey(filters);
  const listAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  /**
   * The continuation in flight, and the window it belongs to.
   *
   * Both are needed, and an earlier version of this file had neither - it built a local
   * `AbortController` that nothing could reach, above a comment claiming the list effect
   * aborted it. It did not. So loading page two of one search and then changing the search
   * before it landed appended the OLD window's rows onto the new one and replaced the
   * cursor with the old window's, which then paged the wrong query. The list showed results
   * the URL did not describe.
   *
   * The generation is belt and braces over the abort: a fetch that has already resolved
   * cannot be aborted, so the resolved handler still has to ask whether the window it was
   * started for is the one on screen.
   */
  const moreAbort = useRef<AbortController | null>(null);
  const windowGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    // A new window supersedes any continuation of the previous one: abort it, retire its
    // generation, and release the control so the operator is not left with a "Loading…"
    // button belonging to a search they have already moved on from.
    moreAbort.current?.abort();
    moreAbort.current = null;
    windowGeneration.current += 1;
    setLoadingMore(false);
    // "first" only while nothing is on screen. Once a window has landed, a refetch is a
    // background refresh and must not blank the rail an operator is reading.
    setListState((prev) => (prev === "ready" || prev === "refreshing" ? "refreshing" : "first"));
    void api.listArchives(toQuery(filters), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setListState("error");
        setListError(result.error);
        return;
      }
      setArchives(result.value.archives);
      setLibraryPath(result.value.libraryPath);
      setCursor(result.value.nextCursor);
      setListError(null);
      setListState("ready");
    });
    return () => {
      controller.abort();
      moreAbort.current?.abort();
    };
    // `key` rather than `filters`: see `filterKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision, manual]);

  useEffect(() => {
    if (!archiveKey) {
      detailAbort.current?.abort();
      setDetail(null);
      setDetailState("idle");
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    detailAbort.current?.abort();
    detailAbort.current = controller;
    setDetailState((prev) => (prev === "ready" ? "ready" : "loading"));
    // Fetched by key alone, never read out of the loaded window. That is what makes a deep
    // link to an archive the current filters exclude open the archive instead of an empty
    // reader - and what keeps it open when reconciliation reorders the list under it.
    void api.archiveDetail(archiveKey, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setDetail(null);
        setDetailState("error");
        setDetailError(result.error);
        return;
      }
      setDetail(result.value);
      setDetailError(null);
      setDetailState("ready");
    });
    return () => controller.abort();
  }, [archiveKey, revision, manual]);

  const loadMore = useCallback((): void => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const controller = new AbortController();
    moreAbort.current?.abort();
    moreAbort.current = controller;
    // The window this continuation belongs to, captured BEFORE the request goes out.
    const generation = windowGeneration.current;
    void api
      .listArchives({ ...toQuery(filters), cursor }, controller.signal)
      .then((result) => {
        // Checked before ANY state is written, `setLoadingMore` included: a continuation
        // that outlived its window must leave the current one exactly as it found it.
        if (!continuationApplies(generation, windowGeneration.current, controller.signal.aborted)) {
          return;
        }
        setLoadingMore(false);
        if (!result.ok) {
          // A failed continuation leaves the rows already on screen alone and keeps the
          // cursor, so the control stays available to try again. Blanking a read window
          // because its next page failed would lose work the operator can still use.
          setListError(result.error);
          return;
        }
        setArchives((prev) => appendArchives(prev, result.value.archives));
        setCursor(result.value.nextCursor);
      });
  }, [cursor, filters, loadingMore]);

  const refresh = useCallback((): void => setManual((n) => n + 1), []);

  return {
    archives,
    libraryPath,
    listState,
    listError,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    detail,
    detailState,
    detailError,
    refresh,
  };
}
