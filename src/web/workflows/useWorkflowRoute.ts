import { useCallback, useEffect, useRef, useState } from "react";

export type WorkflowTab = "workflows" | "personas" | "runs";
export type MissionRoute =
  | { page: "fleet" }
  | { page: "workflows"; tab: WorkflowTab; runId?: string };

export function parseMissionRoute(hash: string): MissionRoute {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "");
  if (path === "/workflows") {
    return { page: "workflows", tab: "workflows" };
  }
  if (path === "/workflows/runs") return { page: "workflows", tab: "runs" };
  const run = /^\/workflows\/runs\/([^/]+)$/.exec(path);
  if (run) return { page: "workflows", tab: "runs", runId: decodeURIComponent(run[1]!) };
  if (path === "/workflows/personas") return { page: "workflows", tab: "personas" };
  return { page: "fleet" };
}

export function missionRouteHash(route: MissionRoute): string {
  if (route.page === "fleet") return "#/fleet";
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
