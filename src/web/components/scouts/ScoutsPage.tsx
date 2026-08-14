import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScoutArchiveSummary, ScoutIndexStatus } from "@shared/scouts.ts";
import { SCOUT_INDEX_STATUSES } from "@shared/scouts.ts";
import type { MissionRoute, ScoutFilters } from "../../workflows/useWorkflowRoute.ts";
import { formatBytes } from "../../lib/format.ts";
import { useScoutsCatalog } from "./useScoutsCatalog.ts";
import { ScoutDeleteModal, type ScoutDeleteTarget } from "./ScoutDeleteModal.tsx";
import { ScoutReader } from "./ScoutReader.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { SCOUT_STATUS_WORD, scoutLabel } from "./scout-labels.ts";

/**
 * The Scouts page: search rail, report reader, evidence spine.
 *
 * The page answers three questions in order, and its three panes are those questions -
 * what did we investigate, what did we conclude, and what evidence survived. It exists so
 * an operator can recover an old answer WITHOUT reopening the agent that found it, long
 * after the task, session, transcript and worktree are gone.
 */

/** Day headings in the rail, in the operator's own locale. */
function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The time an archive sorts and groups by, matching the daemon's own `sort_at`. */
function sortAt(archive: ScoutArchiveSummary): number {
  return archive.completedAt ?? archive.createdAt ?? archive.indexedAt;
}

/** The second line of a rail row: honest about a partial or unreadable record. */
function railDetail(archive: ScoutArchiveSummary): string {
  if (archive.status === "unreadable") {
    return archive.error ? `unreadable · ${archive.error}` : "unreadable";
  }
  const files = `${archive.artifactCount} file${archive.artifactCount === 1 ? "" : "s"}`;
  const size = formatBytes(archive.bytes);
  if (archive.status === "partial") {
    return `partial · ${archive.hasPrimaryReport ? "evidence missing" : "report missing"}`;
  }
  return `${files} · ${size}`;
}

export function ScoutsPage({
  route,
  navigate,
  replace,
  revision,
}: {
  route: Extract<MissionRoute, { page: "scouts" }>;
  navigate: (route: MissionRoute) => boolean;
  replace: (route: MissionRoute) => void;
  revision: number;
}): React.JSX.Element {
  const filters = route.filters;
  const selectedKey = route.archiveKey ?? null;
  const catalog = useScoutsCatalog({ filters, archiveKey: selectedKey, revision });
  const [deleting, setDeleting] = useState<ScoutDeleteTarget | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** The control that opened the modal, so focus can go back to it. */
  const invoker = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  // The search box is LOCAL while it is being typed and the route is updated behind it, so
  // every keystroke is not a history entry and the field never fights the address bar. The
  // route stays the source of truth: a pasted link, the palette, or Back all reset this.
  const [draftQuery, setDraftQuery] = useState(filters?.q ?? "");
  const routeQuery = filters?.q ?? "";
  useEffect(() => setDraftQuery(routeQuery), [routeQuery]);

  const setFilters = useCallback(
    (next: ScoutFilters, viaHistory = true): void => {
      const cleaned = Object.fromEntries(
        Object.entries(next).filter(([, value]) => value !== undefined && value !== ""),
      ) as ScoutFilters;
      const target: MissionRoute = {
        page: "scouts",
        ...(selectedKey ? { archiveKey: selectedKey } : {}),
        ...(Object.keys(cleaned).length > 0 ? { filters: cleaned } : {}),
      };
      // `replace` for typing, `navigate` for a deliberate filter change: a search refined
      // letter by letter must not leave twenty entries for Back to walk out of.
      if (viaHistory) navigate(target);
      else replace(target);
    },
    [navigate, replace, selectedKey],
  );

  useEffect(() => {
    if (draftQuery === routeQuery) return;
    const timer = setTimeout(() => {
      setFilters({ ...filters, q: draftQuery || undefined }, false);
    }, 220);
    return () => clearTimeout(timer);
  }, [draftQuery, routeQuery, filters, setFilters]);

  const select = useCallback(
    (key: string | null): void => {
      navigate({
        page: "scouts",
        ...(key ? { archiveKey: key } : {}),
        ...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
      });
    },
    [filters, navigate],
  );

  // Nothing selected but results present: open the newest, through the normal route so the
  // address bar names it and the link is shareable. `replace`, because landing on a list
  // and being moved to its first row is not a step Back should have to undo.
  useEffect(() => {
    if (selectedKey || catalog.listState !== "ready") return;
    const first = catalog.archives[0];
    if (!first) return;
    replace({
      page: "scouts",
      archiveKey: first.key,
      ...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
    });
  }, [selectedKey, catalog.listState, catalog.archives, filters, replace]);

  const groups = useMemo(() => {
    const out: { day: string; rows: ScoutArchiveSummary[] }[] = [];
    for (const archive of catalog.archives) {
      const day = dayLabel(sortAt(archive));
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(archive);
      else out.push({ day, rows: [archive] });
    }
    return out;
  }, [catalog.archives]);

  const onDeleted = useCallback(
    (key: string): void => {
      // The next visible row, or the previous one when the deleted archive was last. Only
      // after the daemon confirmed - nothing here removes a row on optimism.
      const index = catalog.archives.findIndex((archive) => archive.key === key);
      const remaining = catalog.archives.filter((archive) => archive.key !== key);
      const next = remaining[index] ?? remaining[index - 1] ?? null;
      setDeleting(null);
      setStatus("Scout deleted");
      select(next ? next.key : null);
      catalog.refresh();
      invoker.current?.focus();
    },
    [catalog, select],
  );

  const detail = catalog.detail;
  const activeFilters = filters ?? {};
  const filterCount = Object.keys(activeFilters).filter((k) => k !== "q").length;

  return (
    <main className="scouts-page" aria-label="Scouts">
      <aside className="scouts-rail" aria-label="Scout archives" ref={railRef}>
        <div className="scouts-search">
          <label className="scouts-search-label" htmlFor="scouts-search-input">
            Search archive
          </label>
          <input
            id="scouts-search-input"
            className="field-input scouts-search-input"
            type="search"
            value={draftQuery}
            placeholder="Search questions, findings, reports, files..."
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraftQuery(event.target.value)}
          />
          <div className="scouts-filters">
            <label className="scouts-filter">
              <span className="scouts-filter-label">State</span>
              <Tooltip label="Show only complete, partial, or unreadable archives">
                <select
                  className="scouts-filter-select"
                  value={activeFilters.status ?? ""}
                  onChange={(event) =>
                    setFilters({
                      ...activeFilters,
                      status: (event.target.value || undefined) as ScoutIndexStatus | undefined,
                    })
                  }
                >
                  <option value="">Any state</option>
                  {SCOUT_INDEX_STATUSES.map((value) => (
                    <option key={value} value={value}>{SCOUT_STATUS_WORD[value]}</option>
                  ))}
                </select>
              </Tooltip>
            </label>
            {filterCount > 0 ? (
              <Tooltip label="Drop every filter and keep the words you searched for">
                <button
                  type="button"
                  className="btn btn-ghost scouts-clear"
                  // The query survives a filter clear: the words are what the operator is
                  // hunting for, and the filters are only how they narrowed it.
                  onClick={() => setFilters(activeFilters.q ? { q: activeFilters.q } : {})}
                >
                  Clear filters
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="scouts-results">
          {catalog.listState === "error" ? (
            // NEVER an empty history. A refused read and an empty library are different
            // facts and the operator is told which one this is.
            <div className="scouts-empty" role="alert">
              <p className="empty-title">The scout archive is unavailable</p>
              <p className="empty-sub">{catalog.listError}</p>
              <Tooltip label="Ask the daemon for the archive catalog again">
                <button type="button" className="btn" onClick={catalog.refresh}>Try again</button>
              </Tooltip>
            </div>
          ) : catalog.listState === "first" ? (
            <p className="scouts-loading" role="status">Reading the archive…</p>
          ) : catalog.archives.length === 0 ? (
            <div className="scouts-empty">
              <p className="empty-title">
                {routeQuery || filterCount > 0 ? "No scout matches" : "No scouts archived yet"}
              </p>
              <p className="empty-sub">
                {routeQuery || filterCount > 0
                  ? "Try fewer words, or clear the filters."
                  : "A scout task archives its report here when it completes."}
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.day} className="scouts-group">
                <h2 className="scouts-day">{group.day}</h2>
                <ul className="scouts-rows">
                  {group.rows.map((archive) => (
                    <li key={archive.key}>
                      <div
                        className={`scouts-row tone-${archive.status}${
                          archive.key === selectedKey ? " is-selected" : ""
                        }`}
                      >
                        <Tooltip label={`Read ${scoutLabel(archive)}${
                          archive.question ? ` - ${archive.question}` : ""
                        }`}>
                        <button
                          type="button"
                          className="scouts-row-open"
                          aria-current={archive.key === selectedKey ? "true" : undefined}
                          onClick={() => select(archive.key)}
                        >
                          <span className="scouts-row-head">
                            <span className={`dot scouts-dot-${archive.status}`} aria-hidden />
                            <span className="scouts-row-title">{scoutLabel(archive)}</span>
                          </span>
                          <span className="scouts-row-meta">
                            <span className="mono">{clockLabel(sortAt(archive))}</span>
                            <span className="mono">{railDetail(archive)}</span>
                          </span>
                          {archive.snippet ? (
                            // Why this row matched, in the daemon's own words. Plain data
                            // through normal React escaping - the snippet comes out of an
                            // archived report and is never trusted as markup.
                            <span className="scouts-row-snippet">
                              <span className="mono scouts-snippet-kind">
                                {archive.snippet.kind.replace(/_/g, " ")}
                              </span>
                              {archive.snippet.text}
                            </span>
                          ) : null}
                        </button>
                        </Tooltip>
                        <Tooltip label={`Delete ${scoutLabel(archive)}`}>
                          <button
                            type="button"
                            className="btn btn-ghost scouts-row-more"
                            aria-label={`Delete the scout archive ${scoutLabel(archive)}`}
                            onClick={(event) => {
                              invoker.current = event.currentTarget;
                              setDeleting({
                                key: archive.key,
                                title: scoutLabel(archive),
                                producerLabel: archive.producerLabel,
                                bytes: archive.bytes,
                              });
                            }}
                          >
                            ⋯
                          </button>
                        </Tooltip>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {catalog.hasMore ? (
          <div className="scouts-rail-foot">
            <Tooltip label="Fetch the next window of older archives">
              <button
                type="button"
                className="btn"
                onClick={catalog.loadMore}
                disabled={catalog.loadingMore}
              >
                {catalog.loadingMore ? "Loading…" : "Load more"}
              </button>
            </Tooltip>
          </div>
        ) : null}
      </aside>

      <ScoutReader
        detail={detail}
        state={catalog.detailState}
        error={catalog.detailError}
        libraryPath={catalog.libraryPath}
        onDelete={(target, from) => {
          invoker.current = from;
          setDeleting(target);
        }}
        /*
         * Narrow-width Back. The panes STACK rather than replace one another, so the rail is
         * still on the page and "back" means "take me up to it" - not "clear the selection",
         * which is what this used to do and which did nothing useful: clearing the key let
         * the newest-result effect immediately reselect a DIFFERENT scout, so the control
         * either appeared inert or silently moved the reader to another archive.
         */
        onBack={() => {
          const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          railRef.current?.scrollIntoView({
            behavior: reduced ? "auto" : "smooth",
            block: "start",
          });
          railRef.current?.querySelector<HTMLElement>(".scouts-row-open")?.focus();
        }}
      />

      {/* Politely announced, and focus stays where it was. */}
      <p className="sr-only" role="status" aria-live="polite">{status ?? ""}</p>

      {deleting ? (
        <ScoutDeleteModal
          target={deleting}
          onClose={() => {
            setDeleting(null);
            invoker.current?.focus();
          }}
          onDeleted={onDeleted}
        />
      ) : null}
    </main>
  );
}

