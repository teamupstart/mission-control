import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS_CATEGORY,
  isSettingsCategory,
  type SettingsCategoryId,
} from "../lib/settings-registry.ts";

// The one mission router, despite the name it was born with: every full-screen page the
// dashboard has - fleet, Workflows, Settings - is a variant of `MissionRoute` here, and
// `App.tsx` renders whichever one the hash names. A second router would be a second answer
// to "which page is showing", and the dirty-draft gate below only guards one of them.

export type WorkflowTab = "workflows" | "personas" | "runs";
export type MissionRoute =
  | { page: "fleet" }
  | { page: "workflows"; tab: WorkflowTab; runId?: string }
  | { page: "settings"; category: SettingsCategoryId };

export function parseMissionRoute(hash: string): MissionRoute {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "");
  if (path === "/workflows") {
    return { page: "workflows", tab: "workflows" };
  }
  if (path === "/workflows/runs") return { page: "workflows", tab: "runs" };
  const run = /^\/workflows\/runs\/([^/]+)$/.exec(path);
  if (run) return { page: "workflows", tab: "runs", runId: decodeURIComponent(run[1]!) };
  if (path === "/workflows/personas") return { page: "workflows", tab: "personas" };
  if (path === "/settings") return { page: "settings", category: DEFAULT_SETTINGS_CATEGORY };
  const settings = /^\/settings\/([^/]+)$/.exec(path);
  if (settings) {
    // A RUNTIME membership check, which is why the registry is imported for its values
    // rather than its type: these hashes are links people keep, and a category this build
    // no longer has must land on the default panel rather than on a blank pane.
    const id = decodeURIComponent(settings[1]!);
    return {
      page: "settings",
      category: isSettingsCategory(id) ? id : DEFAULT_SETTINGS_CATEGORY,
    };
  }
  return { page: "fleet" };
}

export function missionRouteHash(route: MissionRoute): string {
  if (route.page === "fleet") return "#/fleet";
  // Always spelled out with its category, so every settings link is a deep link and
  // back/forward steps between categories rather than collapsing them into one entry.
  if (route.page === "settings") return `#/settings/${route.category}`;
  if (route.tab === "runs" && route.runId) return `#/workflows/runs/${encodeURIComponent(route.runId)}`;
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
