import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS_CATEGORY,
  isSettingsCategory,
  type SettingsCategoryId,
} from "../lib/settings-registry.ts";
import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from "@shared/workflow.ts";

// The one mission router, despite the name it was born with: every full-screen page the
// dashboard has - fleet, Library, Runs, Ensembles, Settings - is a variant of `MissionRoute`
// here, and `App.tsx` renders whichever one the hash names. A second router would be a second
// answer to "which page is showing", and the dirty-draft gate below only guards one of them.
//
// The Workflows page is GONE. It spent one release as a two-tab holding pen for the execution
// surfaces while the Library took the authoring ones, and both of its tabs are now top-level
// pages hung off the Line. Every `#/workflows/*` spelling still parses - permanently, see
// `parseMissionRoute` - but none of them parses into a `workflows` route, because there is no
// longer such a page to parse into.

/**
 * The Library's five shelves, in the order they are read on the page.
 *
 * Append-only, and the strings are the hash segments: a rename is a broken bookmark.
 */
export const LIBRARY_SHELVES = [
  "workflows",
  "personas",
  "actions",
  "ensembles",
  "missions",
] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];

/**
 * The three shelves whose assets are AUTHORED one level deeper, and so the only ones that can
 * appear in a route.
 *
 * Ensembles shelves launchers rather than assets (its cards open Dispatch) and Missions ·
 * Sources links out to surfaces that already own their state, so neither has anything to
 * deep-link into. Typing the route field this narrowly is what stops `#/library/ensembles`
 * from becoming a page that has to be invented later to answer a link.
 */
export const LIBRARY_SURFACES = ["workflows", "personas", "actions"] as const;
export type LibrarySurface = (typeof LIBRARY_SURFACES)[number];

export function isLibrarySurface(value: string): value is LibrarySurface {
  return (LIBRARY_SURFACES as readonly string[]).includes(value);
}

/**
 * The path segment that means "open a blank draft here" rather than an asset id.
 *
 * Reserved, so no asset whose id is literally `new` can be deep-linked - ids are UUIDs or
 * `builtin:`-prefixed, so nothing real collides.
 */
export const LIBRARY_NEW_SEGMENT = "new";

export interface WorkflowRunFilters {
  status?: WorkflowRunStatus;
  workflowId?: string;
  session?: string;
}
export type MissionRoute =
  | { page: "fleet" }
  | {
      page: "library";
      /** Absent on the shelves index; present when an authoring surface is mounted. */
      shelf?: LibrarySurface;
      /** The asset that surface has open. Never set together with `creating`. */
      assetId?: string;
      /** Open the surface on a new draft instead of an existing asset. */
      creating?: true;
    }
  | {
      /** Workflow runs: the rail and its reader, the Line's Review stage one click deeper. */
      page: "runs";
      runId?: string;
      filters?: WorkflowRunFilters;
    }
  | {
      /** Ensemble runs: the list and the full decision dossier. */
      page: "ensembles";
      /** The selected Ensemble run, mirroring `runId` for `runs`. */
      ensembleId?: string;
    }
  | { page: "settings"; category: SettingsCategoryId };

/**
 * The route the page toggle (default `w`) navigates to, or `null` when it must stand down.
 * Pure, so the keydown handler's one navigation chord is testable without a DOM: App feeds it
 * the live guard state and this decides.
 *
 * It toggles Fleet <-> Library, the two homes the topbar segment names. It used to toggle
 * Fleet <-> Workflows, and it moved with the authoring surfaces rather than being re-pointed
 * at a page that is now only watched: the chord's job is "the other home", and the Workflows
 * page is no longer one.
 *
 * It is the one fleet shortcut that fires OFF the fleet too - that is what lets the same key
 * RETURN - and it does nothing on any other page. It stands down while a text field has focus,
 * a session is being renamed, or an overlay owns the screen, so `w` types, renames, or
 * dismisses in those moments rather than navigating.
 */
export function pageToggleRoute(state: {
  /** The pressed chord already equals the resolved page-toggle binding. */
  active: boolean;
  typing: boolean;
  renaming: boolean;
  overlayOpen: boolean;
  page: MissionRoute["page"];
}): MissionRoute | null {
  if (!state.active || state.typing || state.renaming || state.overlayOpen) return null;
  if (state.page === "fleet") return { page: "library" };
  if (state.page === "library") return { page: "fleet" };
  return null;
}

/**
 * One path segment as a plain string, or null when no decoder can read it.
 *
 * `decodeURIComponent` THROWS a `URIError` on a lone or truncated escape - `#/settings/%`,
 * `#/workflows/runs/%E0%A4%A` - and every caller of `parseMissionRoute` is somewhere a
 * throw cannot be caught usefully: a `useState` initializer, and a `hashchange` listener.
 * An unreadable segment is the same thing as an unknown one, so it takes the same
 * already-tested fallback rather than leaving the app on no route at all, for a link
 * anyone can paste.
 */
function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function parseMissionRoute(hash: string): MissionRoute {
  const withoutHash = hash.replace(/^#/, "");
  const [rawPath, rawQuery = ""] = withoutHash.split("?", 2);
  const path = rawPath!.replace(/\/+$/, "");
  const params = new URLSearchParams(rawQuery);
  const rawStatus = params.get("status");
  const filters: WorkflowRunFilters = {
    ...(rawStatus && (WORKFLOW_RUN_STATUSES as readonly string[]).includes(rawStatus)
      ? { status: rawStatus as WorkflowRunStatus }
      : {}),
    ...(params.get("workflowId") ? { workflowId: params.get("workflowId")! } : {}),
    ...(params.get("session") ? { session: params.get("session")! } : {}),
  };
  const withFilters = Object.keys(filters).length > 0 ? filters : undefined;
  if (path === "/library") return { page: "library" };
  const library = /^\/library\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (library) {
    const shelf = segment(library[1]!);
    // An unreadable or retired shelf lands on the shelves index rather than on a blank pane,
    // the same rule an unknown settings category takes.
    if (shelf === null || !isLibrarySurface(shelf)) return { page: "library" };
    if (library[2] === undefined) return { page: "library", shelf };
    if (library[2] === LIBRARY_NEW_SEGMENT) return { page: "library", shelf, creating: true };
    // An id nothing can decode names no asset, so it opens the surface on whatever that
    // surface would have opened by itself.
    const assetId = segment(library[2]);
    return assetId ? { page: "library", shelf, assetId } : { page: "library", shelf };
  }
  // `/runs` and `/workflows/runs` are ONE rule, and so are the two ensembles spellings. The
  // legacy prefix is stripped before matching rather than handled by a parallel pair of
  // branches, because a redirect that is a second copy of the parse is a redirect that stops
  // agreeing with it: the day `?status=` grows a sibling, the copy nobody remembered would
  // silently drop it from every kept bookmark. Redirected permanently ON PARSE rather than by
  // a component that would have to mount first - `useWorkflowRoute` then rewrites the address
  // bar to the canonical spelling, so a kept link both lands and stops being legacy.
  const execution = path.startsWith("/workflows/") ? path.slice("/workflows".length) : path;
  if (execution === "/runs") {
    return { page: "runs", ...(withFilters ? { filters: withFilters } : {}) };
  }
  const run = /^\/runs\/([^/]+)$/.exec(execution);
  if (run) {
    // An id nothing can decode names no run, so it lands on the runs list - the same
    // place an id that names a deleted run lands.
    const runId = segment(run[1]!);
    return {
      page: "runs",
      ...(runId ? { runId } : {}),
      ...(withFilters ? { filters: withFilters } : {}),
    };
  }
  if (execution === "/ensembles") return { page: "ensembles" };
  const ensemble = /^\/ensembles\/([^/]+)$/.exec(execution);
  if (ensemble) {
    // Same rule as a run id: an undecodable or deleted-run id lands on the ensembles list
    // rather than on a blank pane, for a link anyone can paste.
    const ensembleId = segment(ensemble[1]!);
    return { page: "ensembles", ...(ensembleId ? { ensembleId } : {}) };
  }
  // The three legacy AUTHORING routes. Below the execution pair because `/workflows` bare is
  // the builder tab's old hash and must not be read as a prefix of anything.
  if (path === "/workflows") return { page: "library" };
  if (path === "/workflows/personas") return { page: "library", shelf: "personas" };
  // `actions`, not `session-actions`: the shelf is called Actions on screen, and the hash a
  // person copies out of the address bar has to be the word they read.
  if (path === "/workflows/actions") return { page: "library", shelf: "actions" };
  // ANYTHING else under the retired page's prefix, and this is a catch-all on purpose.
  //
  // Five spellings ever shipped under `#/workflows` and all five are answered exactly above.
  // Every other one still has to go somewhere better than the fleet: the prefix named ONE
  // page, so a hash carrying it is a link to that page however it is misspelled, mistyped, or
  // half-remembered - and `#/fleet` is the one destination that tells its holder nothing about
  // where the thing they wanted went.
  //
  // The Library, because that is where `#/workflows` bare now lands: an unrecognized sub-path
  // cannot say whether the authoring half or the execution half was meant, so it takes the
  // front door the whole page's front door took. Exactly the rule `#/library/<unknown-shelf>`
  // already follows a few lines up.
  if (path.startsWith("/workflows/")) return { page: "library" };
  if (path === "/settings") return { page: "settings", category: DEFAULT_SETTINGS_CATEGORY };
  const settings = /^\/settings\/([^/]+)$/.exec(path);
  if (settings) {
    // A RUNTIME membership check, which is why the registry is imported for its values
    // rather than its type: these hashes are links people keep, and a category this build
    // no longer has must land on the default panel rather than on a blank pane.
    const id = segment(settings[1]!);
    return {
      page: "settings",
      category: id !== null && isSettingsCategory(id) ? id : DEFAULT_SETTINGS_CATEGORY,
    };
  }
  return { page: "fleet" };
}

export function missionRouteHash(route: MissionRoute): string {
  if (route.page === "fleet") return "#/fleet";
  // Always spelled out with its category, so every settings link is a deep link and
  // back/forward steps between categories rather than collapsing them into one entry.
  if (route.page === "settings") return `#/settings/${route.category}`;
  if (route.page === "library") {
    if (!route.shelf) return "#/library";
    if (route.creating) return `#/library/${route.shelf}/${LIBRARY_NEW_SEGMENT}`;
    return route.assetId
      ? `#/library/${route.shelf}/${encodeURIComponent(route.assetId)}`
      : `#/library/${route.shelf}`;
  }
  if (route.page === "runs") {
    const path = route.runId ? `#/runs/${encodeURIComponent(route.runId)}` : "#/runs";
    const params = new URLSearchParams();
    if (route.filters?.status) params.set("status", route.filters.status);
    if (route.filters?.workflowId) params.set("workflowId", route.filters.workflowId);
    if (route.filters?.session) params.set("session", route.filters.session);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }
  return route.ensembleId
    ? `#/ensembles/${encodeURIComponent(route.ensembleId)}`
    : "#/ensembles";
}

export interface MissionRouter {
  route: MissionRoute;
  /**
   * Ask to move. `false` means the move did NOT happen - either because a dirty draft is
   * now holding it (see `pendingRoute`) or because it was already the current route.
   */
  navigate: (route: MissionRoute) => boolean;
  /**
   * Record a move the operator has ALREADY made inside the page they are on, without a
   * history entry and without the dirty-draft gate.
   *
   * The one caller is a Library authoring surface reporting which asset it has open, so the
   * address bar names it and the link is shareable. It bypasses the gate deliberately and
   * safely: the surface owns that selection, it has already asked its own "discard unsaved
   * changes?" question before switching, and this is called AFTER it switched - so the gate
   * would raise a second dialog about a draft the operator just answered for, on a page they
   * are not leaving. `navigate` remains the only way to change pages.
   */
  replace: (route: MissionRoute) => void;
  /**
   * The route a dirty draft is holding up, or null. App renders the confirm dialog for it;
   * the router does not import a component, so this hook stays testable without a DOM.
   */
  pendingRoute: MissionRoute | null;
  /** Leave anyway: drop the draft and apply the held route. */
  confirmPending: () => void;
  /** Stay put, and forget the held route. */
  cancelPending: () => void;
}

/** Hash routing without a router dependency, with one dirty-draft gate for links and back/forward. */
export function useWorkflowRoute(dirty: boolean): MissionRouter {
  const initial = parseMissionRoute(window.location.hash);
  const [route, setRoute] = useState<MissionRoute>(initial);
  const accepted = useRef(initial);
  const allowHash = useRef<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /**
   * The route the gate is holding, raised as an overlay-hosted dialog instead of the
   * `window.confirm` this replaced.
   *
   * A native dialog answers synchronously, which is what let both branches below read like
   * ordinary control flow - but it is invisible to the overlay registry, so `anyOpen` stayed
   * false and the fleet's global key handler was live behind it: `k` while the browser
   * dialog was up reached the card underneath. The cost of the swap is that the decision is
   * now deferred, so "what to do once they answer" has to be held somewhere, and this is it.
   */
  const [pendingRoute, setPendingRouteState] = useState<MissionRoute | null>(null);
  // Mirrored in a ref so `confirmPending` can read what is held without navigating from
  // inside a state updater - React may call an updater twice, and "set the location" is
  // not a thing to do twice.
  const pendingRef = useRef<MissionRoute | null>(null);
  const setPendingRoute = useCallback((next: MissionRoute | null): void => {
    pendingRef.current = next;
    setPendingRouteState(next);
  }, []);

  const applyRoute = useCallback((next: MissionRoute): void => {
    const hash = missionRouteHash(next);
    allowHash.current = hash;
    window.location.hash = hash;
  }, []);

  const navigate = useCallback((next: MissionRoute): boolean => {
    const hash = missionRouteHash(next);
    if (hash === missionRouteHash(accepted.current)) return true;
    if (dirtyRef.current) {
      setPendingRoute(next);
      return false;
    }
    applyRoute(next);
    return true;
  }, [applyRoute, setPendingRoute]);

  const replace = useCallback((next: MissionRoute): void => {
    const hash = missionRouteHash(next);
    if (hash === missionRouteHash(accepted.current)) return;
    // `replaceState`, not `location.hash`: selecting your way down a Persona list must not
    // build a history entry per click, or Back stops meaning "the page I came from".
    history.replaceState(null, "", hash);
    accepted.current = next;
    setRoute(next);
  }, []);

  // A legacy hash lands on its new route (see `parseMissionRoute`), and the address bar is
  // rewritten to say so. Without this the redirect is invisible: the page would be the
  // Library while the URL still read `#/workflows/personas`, and the next copy of that link
  // would keep the old spelling alive forever. `replaceState` fires no `hashchange`, so this
  // cannot loop through the listener below.
  useEffect(() => {
    const current = window.location.hash;
    if (!current) return;
    const canonical = missionRouteHash(parseMissionRoute(current));
    if (canonical !== current) history.replaceState(null, "", canonical);
  }, []);

  useEffect(() => {
    const onHash = (): void => {
      const hash = window.location.hash || "#/fleet";
      const next = parseMissionRoute(hash);
      if (allowHash.current === hash) {
        allowHash.current = null;
      } else if (
        dirtyRef.current &&
        missionRouteHash(next) !== missionRouteHash(accepted.current)
      ) {
        // Back/forward has ALREADY moved the address bar, so the URL is put back before
        // the question is asked rather than after it is answered: a dialog floating over
        // the page you were on, above an address bar naming the page you were leaving, is
        // two answers to "where am I" while the one that matters is still undecided.
        history.replaceState(null, "", missionRouteHash(accepted.current));
        setPendingRoute(next);
        return;
      }
      accepted.current = next;
      setRoute(next);
      // Same canonicalization the mount effect does, for a legacy link followed mid-session
      // (a bookmark opened into this tab, or Back onto one).
      const canonical = missionRouteHash(next);
      if (canonical !== hash) history.replaceState(null, "", canonical);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // `setPendingRoute` is stable; the listener is still subscribed exactly once.
  }, [setPendingRoute]);

  const confirmPending = useCallback((): void => {
    const held = pendingRef.current;
    setPendingRoute(null);
    if (held) applyRoute(held);
  }, [applyRoute, setPendingRoute]);

  const cancelPending = useCallback((): void => setPendingRoute(null), [setPendingRoute]);

  return { route, navigate, replace, pendingRoute, confirmPending, cancelPending };
}
