import { useCallback, useEffect, useState } from "react";
import type { ResidentMcpCatalog, ResidentMcpCustomServerView, ResidentMcpGlobalServer } from "@shared/resident-mcp.ts";
import type { ResidentAgent, ResidentMcpServerRef } from "@shared/residents.ts";
import { fetchResidentMcpCatalog, refreshResidentMcpCatalog } from "./api.ts";

/**
 * The MCP catalog, fetched on demand: there is no SSE collection for it, so a surface that
 * changes it (saving a custom server, Refresh) hands the answer back through `replace`.
 */
export function useResidentMcpCatalog(): {
  catalog: ResidentMcpCatalog | null;
  error: string | null;
  refresh: () => Promise<void>;
  replace: (next: ResidentMcpCatalog) => void;
  reload: () => Promise<void>;
} {
  const [catalog, setCatalog] = useState<ResidentMcpCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (fetcher: () => Promise<ResidentMcpCatalog>) => {
    try {
      setCatalog(await fetcher());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    let live = true;
    void fetchResidentMcpCatalog()
      .then((value) => { if (live) setCatalog(value); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, []);
  return {
    catalog,
    error,
    refresh: () => load(refreshResidentMcpCatalog),
    reload: () => load(fetchResidentMcpCatalog),
    replace: setCatalog,
  };
}

/** What one selection points at in the catalog, or null when it no longer exists there. */
export function residentMcpRefTarget(
  catalog: ResidentMcpCatalog | null,
  ref: ResidentMcpServerRef,
): { kind: "global"; server: ResidentMcpGlobalServer } | { kind: "custom"; server: ResidentMcpCustomServerView } | null {
  if (!catalog) return null;
  if (ref.source === "custom") {
    const server = catalog.custom.find((candidate) => candidate.id === ref.id);
    return server ? { kind: "custom", server } : null;
  }
  const server = catalog.harnesses.find((row) => row.agent === ref.agent)?.servers.find((candidate) => candidate.name === ref.name);
  return server ? { kind: "global", server } : null;
}

/** A selection's display name: the server's name, or what is known of a missing one. */
export function residentMcpRefLabel(catalog: ResidentMcpCatalog | null, ref: ResidentMcpServerRef): string {
  const target = residentMcpRefTarget(catalog, ref);
  if (target) return target.server.name;
  return ref.source === "global" ? ref.name : "missing custom server";
}

/** Whether the catalog says this harness can pin a run's MCP set. Unknown until it loads. */
export function residentMcpSelectable(catalog: ResidentMcpCatalog | null, agent: ResidentAgent): boolean | null {
  if (!catalog) return null;
  return catalog.harnesses.find((row) => row.agent === agent)?.selectable ?? false;
}
