import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RepoIndexConfigPatch,
  RepoIndexView,
} from "@shared/repo-index.ts";
import { api, fetchRepoIndex } from "./lib/api.ts";

const POLL_MS = 4000;

function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  return flat || "That change didn't stick because the daemon refused it.";
}

export interface RepoIndexState {
  view: RepoIndexView | null;
  update: (patch: RepoIndexConfigPatch) => Promise<boolean>;
  addDirectory: (path: string) => Promise<boolean>;
  removeDirectory: (path: string) => Promise<boolean>;
  restoreDefaults: () => Promise<boolean>;
  rescan: () => Promise<boolean>;
  error: string | null;
  writing: boolean;
}

/** Poll and mutate the machine-local repository-index view from one guarded owner. */
export function useRepoIndex(): RepoIndexState {
  const [viewState, setViewState] = useState<RepoIndexView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const viewRef = useRef<RepoIndexView | null>(null);
  /** A poll started before a write may not restore the rows that write removed. */
  const writes = useRef(0);

  const setView = useCallback((view: RepoIndexView | null): void => {
    viewRef.current = view;
    setViewState(view);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const at = writes.current;
      const next = await fetchRepoIndex();
      if (alive && next && writes.current === at) setView(next);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setView]);

  const update = useCallback(async (patch: RepoIndexConfigPatch): Promise<boolean> => {
    const current = viewRef.current;
    if (!current || current.managedBy === "environment") return false;
    const at = (writes.current += 1);
    setWriting(true);
    const result = await api.setRepoIndex(patch);
    if (writes.current !== at) return result.ok;
    setWriting(false);
    if (!result.ok) {
      setError(whyItFailed(result.error));
      return false;
    }
    setError(null);
    setView(result);
    return true;
  }, [setView]);

  const addDirectory = useCallback(async (path: string): Promise<boolean> => {
    const current = viewRef.current;
    if (!current || current.managedBy === "environment") return false;
    return update({
      directories: [...current.directories.map((row) => ({ path: row.path })), { path }],
    });
  }, [update]);

  const removeDirectory = useCallback(async (path: string): Promise<boolean> => {
    const current = viewRef.current;
    if (!current || current.managedBy === "environment") return false;
    return update({
      directories: current.directories
        .filter((row) => row.path !== path)
        .map((row) => ({ path: row.path })),
    });
  }, [update]);

  const restoreDefaults = useCallback(async (): Promise<boolean> => {
    const current = viewRef.current;
    if (!current || current.managedBy === "environment") return false;
    return update({
      directories: [
        ...current.directories.map((row) => ({ path: row.path })),
        ...current.defaultsMissing.map((path) => ({ path })),
      ],
    });
  }, [update]);

  const rescan = useCallback(async (): Promise<boolean> => {
    if (!viewRef.current) return false;
    const at = (writes.current += 1);
    setWriting(true);
    const result = await api.rescanRepoIndex();
    if (writes.current !== at) return result.ok;
    setWriting(false);
    if (!result.ok) {
      setError(whyItFailed(result.error));
      return false;
    }
    setError(null);
    setView(result);
    return true;
  }, [setView]);

  return {
    view: viewState,
    update,
    addDirectory,
    removeDirectory,
    restoreDefaults,
    rescan,
    error,
    writing,
  };
}
