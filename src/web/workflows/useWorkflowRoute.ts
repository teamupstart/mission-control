import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS_CATEGORY,
  isSettingsCategory,
  type SettingsCategoryId,
} from "../lib/settings-registry.ts";
import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from "@shared/workflow.ts";

// The one mission router, despite the name it was born with: every full-screen page the
// dashboard has - fleet, Workflows, Settings - is a variant of `MissionRoute` here, and
// `App.tsx` renders whichever one the hash names. A second router would be a second answer
// to "which page is showing", and the dirty-draft gate below only guards one of them.

export type WorkflowTab = "workflows" | "personas" | "runs" | "ensembles";
export interface WorkflowRunFilters {
  status?: WorkflowRunStatus;
  workflowId?: string;
  session?: string;
}
export type MissionRoute =
  | { page: "fleet" }
  | {
      page: "workflows";
      tab: WorkflowTab;
      runId?: string;
      /** The selected Ensemble run on the `ensembles` tab, mirroring `runId` for `runs`. */
      ensembleId?: string;
      filters?: WorkflowRunFilters;
    }
  | { page: "settings"; category: SettingsCategoryId };

/**
 * The route the Workflows toggle (default `w`) navigates to, or `null` when it must stand
 * down. Pure, so the keydown handler's one navigation chord is testable without a DOM: App
 * feeds it the live guard state and this decides.
 *
 * It is the one fleet shortcut that fires OFF the fleet too - that is what lets the same key
 * RETURN - so it toggles Fleet <-> Workflows and does nothing on any other page. It stands
 * down while a text field has focus, a session is being renamed, or an overlay owns the
 * screen, so `w` types, renames, or dismisses in those moments rather than navigating.
 */
export function workflowsToggleRoute(state: {
  /** The pressed chord already equals the resolved Workflows binding. */
  active: boolean;
  typing: boolean;
  renaming: boolean;
  overlayOpen: boolean;
  page: MissionRoute["page"];
}): MissionRoute | null {
  if (!state.active || state.typing || state.renaming || state.overlayOpen) return null;
  if (state.page === "fleet") return { page: "workflows", tab: "workflows" };
  if (state.page === "workflows") return { page: "fleet" };
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
  if (path === "/workflows") {
    return { page: "workflows", tab: "workflows" };
  }
  if (path === "/workflows/runs") {
    return { page: "workflows", tab: "runs", ...(withFilters ? { filters: withFilters } : {}) };
  }
  const run = /^\/workflows\/runs\/([^/]+)$/.exec(path);
  if (run) {
    // An id nothing can decode names no run, so it lands on the runs list - the same
    // place an id that names a deleted run lands.
    const runId = segment(run[1]!);
    return runId
      ? {
          page: "workflows",
          tab: "runs",
          runId,
          ...(withFilters ? { filters: withFilters } : {}),
        }
      : { page: "workflows", tab: "runs", ...(withFilters ? { filters: withFilters } : {}) };
  }
  if (path === "/workflows/ensembles") return { page: "workflows", tab: "ensembles" };
  const ensemble = /^\/workflows\/ensembles\/([^/]+)$/.exec(path);
  if (ensemble) {
    // Same rule as a run id: an undecodable or deleted-run id lands on the ensembles list
    // rather than on a blank pane, for a link anyone can paste.
    const ensembleId = segment(ensemble[1]!);
    return ensembleId
      ? { page: "workflows", tab: "ensembles", ensembleId }
      : { page: "workflows", tab: "ensembles" };
  }
  if (path === "/workflows/personas") return { page: "workflows", tab: "personas" };
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
  if (route.tab === "runs") {
    const path = route.runId
      ? `#/workflows/runs/${encodeURIComponent(route.runId)}`
      : "#/workflows/runs";
    const params = new URLSearchParams();
    if (route.filters?.status) params.set("status", route.filters.status);
    if (route.filters?.workflowId) params.set("workflowId", route.filters.workflowId);
    if (route.filters?.session) params.set("session", route.filters.session);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }
  if (route.tab === "ensembles") {
    return route.ensembleId
      ? `#/workflows/ensembles/${encodeURIComponent(route.ensembleId)}`
      : "#/workflows/ensembles";
  }
  return route.tab === "workflows" ? "#/workflows" : `#/workflows/${route.tab}`;
}

/** Hash routing without a router dependency, with one dirty-draft gate for links and back/forward. */
export function useWorkflowRoute(dirty: boolean): {
  route: MissionRoute;
  navigate: (route: MissionRoute) => boolean;
} {
  const initial = parseMissionRoute(window.location.hash);
  const [route, setRoute] = useState<MissionRoute>(initial);
  const accepted = useRef(initial);
  const allowHash = useRef<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const navigate = useCallback((next: MissionRoute): boolean => {
    const hash = missionRouteHash(next);
    if (hash === missionRouteHash(accepted.current)) return true;
    if (dirtyRef.current && !window.confirm("Discard unsaved workflow or Persona changes?")) return false;
    allowHash.current = hash;
    window.location.hash = hash;
    return true;
  }, []);

  useEffect(() => {
    const onHash = (): void => {
      const hash = window.location.hash || "#/fleet";
      const next = parseMissionRoute(hash);
      if (allowHash.current === hash) {
        allowHash.current = null;
      } else if (
        dirtyRef.current &&
        missionRouteHash(next) !== missionRouteHash(accepted.current) &&
        !window.confirm("Discard unsaved workflow or Persona changes?")
      ) {
        history.replaceState(null, "", missionRouteHash(accepted.current));
        return;
      }
      accepted.current = next;
      setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return { route, navigate };
}
