import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS_CATEGORY,
  isSettingsCategory,
  type SettingsCategoryId,
} from "../lib/settings-registry.ts";
import {
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunStatus,
} from "@shared/workflow.ts";
import {
  SCOUT_INDEX_STATUSES,
  parseScoutArchiveKey,
  type ScoutIndexStatus,
} from "@shared/scouts.ts";

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
 * The Library's six shelves, in the order they are read on the page.
 *
 * Their strings are hash segments, so their names stay stable for saved bookmarks. Reading
 * order is deliberately separate from that URL contract and may change when the Library's
 * organization needs to become clearer.
 */
export const LIBRARY_SHELVES = [
  "missions",
  "workflows",
  "commands",
  "personas",
  "actions",
  "ensembles",
] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];

/**
 * The four shelves whose assets are AUTHORED one level deeper, and so the only ones that can
 * appear in a route.
 *
 * Ensembles shelves launchers rather than assets (its cards open Dispatch) and Missions ·
 * Sources links out to surfaces that already own their state, so neither has anything to
 * deep-link into. Typing the route field this narrowly is what stops `#/library/ensembles`
 * from becoming a page that has to be invented later to answer a link.
 */
export const LIBRARY_SURFACES = ["workflows", "personas", "actions", "commands"] as const;
export type LibrarySurface = (typeof LIBRARY_SURFACES)[number];

export function isLibrarySurface(value: string): value is LibrarySurface {
  return (LIBRARY_SURFACES as readonly string[]).includes(value);
}

/**
 * The one surface whose asset ids are a CLOSED set that ships with the build.
 *
 * Every other Library surface deep-links to a row an operator created, so its id is opaque
 * here and the surface resolves it. Commands has four fixed slots and no way to make a
 * fifth, so an id that is not one of them names nothing that could ever exist - it takes the
 * surface's default rather than being carried into the address bar as a link to nowhere. The
 * same rule makes `/new` inexpressible: there is no blank Command to draft.
 */
function isFixedLibraryAsset(shelf: LibrarySurface, assetId: string): boolean {
  return shelf !== "commands" || (WORKFLOW_CHECK_SLOTS as readonly string[]).includes(assetId);
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

/**
 * The Scouts page's bounded search, as the address bar carries it.
 *
 * These are the SAME names `ScoutSearchQuerySchema` validates on the way into
 * `GET /api/scouts`, `status` included. The approved plan wrote that one filter as `state`
 * in both its route sketch and its route table, but phase 1 shipped `status`, and one
 * spelling in the hash with another on the wire would mean a translation step in the page
 * whose only job is to keep two names for one filter agreeing forever.
 *
 * `cursor` and `limit` are deliberately NOT here: a cursor continues the current result
 * window rather than naming a destination, so it must not survive a copied link - pasting
 * page three of a search into a fresh tab would otherwise open on a window with no first
 * page above it.
 */
export interface ScoutFilters {
  /** Literal substring search, server-side, over every indexed segment. */
  q?: string;
  producer?: string;
  repo?: string;
  agent?: string;
  status?: ScoutIndexStatus;
  /** Epoch ms, inclusive, bounding the archive's sort time. */
  from?: number;
  to?: number;
}

/** Reads one epoch-ms bound, or undefined when it is not a value the API would accept. */
function scoutBound(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  // Matches the server's `z.coerce.number().int().nonnegative()`. A bound the route accepts
  // but the route's own API would refuse is a link that lands on a 400 instead of a page.
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
  | {
      /**
       * The Ship log: the Inspector's adoption ledger read as a cross-repo record of what
       * the fleet landed.
       *
       * Stateless, and deliberately so. Its range and its repository filter are both
       * answers to "what am I looking at right now" rather than to "where am I", and
       * neither survives a reload in the address bar - the same call `runs` made the other
       * way for its status filter, which IS in the hash because notifications and the
       * Line link INTO a filtered run list. Nothing links into a filtered ship log.
       */
      page: "shipped";
    }
  | {
      /**
       * The scout archive: a searchable history of what the fleet investigated, read long
       * after the agent, task, transcript and worktree that produced it are gone.
       *
       * Its filters ARE in the hash, unlike the Ship log's, because this page's whole job
       * is recovering one old answer and handing the link to someone else. Nothing about
       * a task or session appears here - a bundle outlives both, so joining a route to
       * either would make a permanent record addressable only while a transient one lives.
       */
      page: "scouts";
      /** The selected archive, as its portable `<producerId>~<archiveId>` key. */
      archiveKey?: string;
      filters?: ScoutFilters;
    }
  | { page: "settings"; category: SettingsCategoryId };

/**
 * The route a direct page shortcut navigates to, or `null` when it must stand down.
 *
 * Fleet, Library, Runs and Scouts each own a chord. None doubles as a toggle, so the key means
 * the same destination from every page. The common guards stay pure and shared with App's
 * global keydown handler: a letter types, renames, or leaves an overlay in control instead of
 * navigating behind it.
 *
 * Scouts navigates to the BARE page, dropping any filters the operator last had. A shortcut
 * is "take me to that page", and a chord that reopened someone's stale search would be the
 * one page whose key does not mean the same thing twice.
 */
export function pageShortcutRoute(state: {
  /** The page whose resolved shortcut matched, or null when no page chord matched. */
  target: "fleet" | "library" | "runs" | "scouts" | null;
  typing: boolean;
  renaming: boolean;
  overlayOpen: boolean;
}): MissionRoute | null {
  if (!state.target || state.typing || state.renaming || state.overlayOpen) return null;
  return { page: state.target };
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
  // Query parameters belong to the route that declares them - three to `runs` here, seven to
  // `scouts` in its own branch below - and every other one is dropped. A `MissionRoute` is a
  // typed value rather than a URL: it is serialized back out of its own fields by
  // `missionRouteHash`, so a parameter with no field to land in cannot survive the round trip
  // and never has - `#/runs?source=x` loses it exactly as `#/workflows/runs?source=x` does.
  // That is worth saying here because the legacy redirects make it look like a property of
  // REDIRECTING, and it is not; carrying an arbitrary query through would mean parking an
  // opaque bag on every route and printing meaningless parameters in the address bar forever.
  //
  // The three below are read unconditionally because `runs` has two spellings to reach; the
  // scouts filters are read inside the scouts branch, where `status` means something else
  // entirely and must not be confused with a workflow run status.
  const rawStatus = params.get("status");
  const filters: WorkflowRunFilters = {
    ...(rawStatus && (WORKFLOW_RUN_STATUSES as readonly string[]).includes(rawStatus)
      ? { status: rawStatus as WorkflowRunStatus }
      : {}),
    ...(params.get("workflowId") ? { workflowId: params.get("workflowId")! } : {}),
    ...(params.get("session") ? { session: params.get("session")! } : {}),
  };
  const withFilters = Object.keys(filters).length > 0 ? filters : undefined;
  if (path === "/scouts" || path.startsWith("/scouts/")) {
    const rawStatusFilter = params.get("status");
    const rawFrom = scoutBound(params.get("from"));
    const rawTo = scoutBound(params.get("to"));
    const scoutFilters: ScoutFilters = {
      ...(params.get("q") ? { q: params.get("q")! } : {}),
      ...(params.get("producer") ? { producer: params.get("producer")! } : {}),
      ...(params.get("repo") ? { repo: params.get("repo")! } : {}),
      ...(params.get("agent") ? { agent: params.get("agent")! } : {}),
      // An unknown status is DROPPED rather than carried, exactly as an unknown run status
      // is: the page would have to refuse it at the API anyway, and a filter chip naming a
      // state this build does not have is a control nothing can clear.
      ...(rawStatusFilter && (SCOUT_INDEX_STATUSES as readonly string[]).includes(rawStatusFilter)
        ? { status: rawStatusFilter as ScoutIndexStatus }
        : {}),
      ...(rawFrom !== undefined ? { from: rawFrom } : {}),
      ...(rawTo !== undefined ? { to: rawTo } : {}),
    };
    const withScoutFilters =
      Object.keys(scoutFilters).length > 0 ? scoutFilters : undefined;
    if (path === "/scouts") {
      return { page: "scouts", ...(withScoutFilters ? { filters: withScoutFilters } : {}) };
    }
    const scout = /^\/scouts\/([^/]+)$/.exec(path);
    // A key nothing can decode, a key that is not a well-formed `<producerId>~<archiveId>`
    // pair, and a deeper path all name no archive, so they land on the filtered list rather
    // than on a blank reader - the same rule a bad run id takes. Validating the SHAPE here
    // keeps a malformed key from reaching a route that would ask the daemon about it.
    const archiveKey = scout ? segment(scout[1]!) : null;
    return {
      page: "scouts",
      ...(archiveKey && parseScoutArchiveKey(archiveKey) ? { archiveKey } : {}),
      ...(withScoutFilters ? { filters: withScoutFilters } : {}),
    };
  }
  if (path === "/library") return { page: "library" };
  const library = /^\/library\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (library) {
    const shelf = segment(library[1]!);
    // An unreadable or retired shelf lands on the shelves index rather than on a blank pane,
    // the same rule an unknown settings category takes.
    if (shelf === null || !isLibrarySurface(shelf)) return { page: "library" };
    if (library[2] === undefined) return { page: "library", shelf };
    if (library[2] === LIBRARY_NEW_SEGMENT) {
      // A fixed catalog has nothing to draft, so `/new` is not "open a blank one" there - it
      // is an id naming no slot, and takes the same fallback every other unusable id takes.
      return shelf === "commands"
        ? { page: "library", shelf }
        : { page: "library", shelf, creating: true };
    }
    // An id nothing can decode names no asset, so it opens the surface on whatever that
    // surface would have opened by itself.
    const assetId = segment(library[2]);
    return assetId && isFixedLibraryAsset(shelf, assetId)
      ? { page: "library", shelf, assetId }
      : { page: "library", shelf };
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
  // On `path` rather than on `execution`, exactly as `/settings` below is. The Ship log
  // never lived under the retired `#/workflows` prefix, so reading it off the stripped
  // spelling would invent `#/workflows/shipped` as a second address for a page that has
  // never had one - and the catch-all above has already sent that hash to the Library,
  // which is where every unrecognized legacy sub-path goes.
  if (path === "/shipped") return { page: "shipped" };
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
    // The `creating` guard is the parser's rule stated on the way out too. `parseMissionRoute`
    // cannot produce a creating Commands route, but a hand-built one would otherwise serialize
    // to a hash that parses back to something else - and a codec that does not round-trip is
    // how the address bar starts disagreeing with the page.
    if (route.creating && route.shelf !== "commands") {
      return `#/library/${route.shelf}/${LIBRARY_NEW_SEGMENT}`;
    }
    return route.assetId && isFixedLibraryAsset(route.shelf, route.assetId)
      ? `#/library/${route.shelf}/${encodeURIComponent(route.assetId)}`
      : `#/library/${route.shelf}`;
  }
  // BEFORE the ensembles tail, which is unguarded: this function ends in a return rather
  // than in a switch, so a page member that never names its own hash does not fail to
  // compile - it silently serializes to `#/ensembles`, and `navigate({page:"shipped"})`
  // lands on the wrong page with no error anywhere.
  if (route.page === "shipped") return "#/shipped";
  if (route.page === "scouts") {
    // The key is emitted only when it is well formed, mirroring the parser. A hand-built
    // route carrying a malformed key would otherwise serialize to a hash that parses back
    // without it, and a codec that does not round-trip is how the address bar starts
    // disagreeing with the page.
    const path =
      route.archiveKey && parseScoutArchiveKey(route.archiveKey)
        ? `#/scouts/${encodeURIComponent(route.archiveKey)}`
        : "#/scouts";
    const params = new URLSearchParams();
    // Fixed order, so the same filter set always produces the same bytes and two links to
    // one search compare equal.
    if (route.filters?.q) params.set("q", route.filters.q);
    if (route.filters?.producer) params.set("producer", route.filters.producer);
    if (route.filters?.repo) params.set("repo", route.filters.repo);
    if (route.filters?.agent) params.set("agent", route.filters.agent);
    if (route.filters?.status) params.set("status", route.filters.status);
    if (route.filters?.from !== undefined) params.set("from", String(route.filters.from));
    if (route.filters?.to !== undefined) params.set("to", String(route.filters.to));
    const query = params.toString();
    return query ? `${path}?${query}` : path;
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
