import { useCallback, useEffect, useRef, useState } from "react";
import {
  pipelineRepoKey,
  type PipelineProviderId,
  type PipelinesConfig,
  type PipelinesView,
} from "@shared/pipeline.ts";
import { api, fetchPipelines, fetchRepos } from "./lib/api.ts";
import { readIsCurrent } from "./harnesses-reconcile.ts";

// The Conductor Settings state. Provider registration and Mission Control observation are
// deliberately two ordered mutations: the provider's CLI owns its registry, while the existing
// whole-config PUT remains Mission Control's single consent writer.

const POLL_MS = 4000;

/** Flatten a rejection to one clamped sentence. Mirrors `useTaskSources`'s twin. */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick.";
  return `That change didn't stick: ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
}

/** Compose observation consent without disturbing any other provider or repository choice. */
export function configWithObservation(
  config: PipelinesConfig,
  provider: PipelineProviderId,
  repoRoot: string,
): PipelinesConfig {
  const key = pipelineRepoKey(provider, repoRoot);
  const kept = config.repos.filter((repo) => pipelineRepoKey(repo.provider, repo.repoRoot) !== key);
  return {
    ...config,
    enabled: true,
    repos: [...kept, { provider, repoRoot, enabled: true }],
  };
}

export interface ConductorSetupNotice {
  repoRoot: string;
  tone: "ok" | "attention" | "error";
  detail: string;
  output: string;
}

export interface ConductorState {
  /** Null until the first read lands. Null is UNKNOWN, never "nothing is enabled". */
  view: PipelinesView | null;
  /** Canonical repository roots from Mission Control's existing workspace catalog. */
  workspaceRepos: string[];
  /** Write the whole consent config. Applied optimistically, reverted if refused. */
  save: (config: PipelinesConfig) => Promise<boolean>;
  /** Register with the provider, then enable Mission Control observation after confirmation. */
  registerAndObserve: (provider: PipelineProviderId, repoRoot: string) => Promise<boolean>;
  /** Recovery after provider registration succeeded but the observation write did not. */
  enableObservation: (provider: PipelineProviderId, repoRoot: string) => Promise<boolean>;
  /** Re-run the engine probe now, bypassing the daemon's TTL cache. */
  recheck: () => Promise<void>;
  checking: boolean;
  /** The repository and ordered phase currently mutating, or null. */
  setup: { repoRoot: string; phase: "registering" | "observing" } | null;
  setupNotice: ConductorSetupNotice | null;
  /** Why the last ordinary config edit did not stick, or null. */
  error: string | null;
}

/** @param active Whether the permanent Conductor category is the one on screen. */
export function useConductor(active: boolean): ConductorState {
  const [view, setViewState] = useState<PipelinesView | null>(null);
  const [workspaceRepos, setWorkspaceRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [setup, setSetup] = useState<ConductorState["setup"]>(null);
  const [setupNotice, setSetupNotice] = useState<ConductorSetupNotice | null>(null);
  const viewRef = useRef<PipelinesView | null>(null);
  const editSeq = useRef(0);
  const writeGen = useRef(0);
  /** Non-null while the two-step setup flow owns the view. Ordinary polls stand down. */
  const setupToken = useRef<number | null>(null);
  const nextSetupToken = useRef(0);
  /** The config write or registration already in flight. Every later mutation queues behind it. */
  const writing = useRef<Promise<unknown>>(Promise.resolve());

  const setView = useCallback((next: PipelinesView | null): void => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  const refresh = useCallback(
    async (
      seqAtRequest: number = editSeq.current,
      { force = false }: { force?: boolean } = {},
    ): Promise<void> => {
      if (!force && setupToken.current !== null) return;
      const genAtRequest = writeGen.current;
      const v = await fetchPipelines(force);
      if (!v) return;
      if (!readIsCurrent(seqAtRequest, editSeq.current)) return;
      if (!readIsCurrent(genAtRequest, writeGen.current)) return;
      if (!force && setupToken.current !== null) return;
      setView(v);
    },
    [setView],
  );

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      if (alive) await refresh();
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, refresh]);

  // The existing workspace catalog is fetched only while this destination is active. It is
  // the candidate source; Conductor's probe remains the authority for registration.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void fetchRepos().then((repos) => {
      if (alive) setWorkspaceRepos(repos);
    });
    return () => {
      alive = false;
    };
  }, [active]);

  const save = useCallback(
    async (config: PipelinesConfig): Promise<boolean> => {
      const before = viewRef.current;
      if (!before) return false;
      const seq = ++editSeq.current;
      setView({ ...before, config });

      const queued = writing.current;
      const attempt = (async (): Promise<boolean> => {
        await queued;
        if (!readIsCurrent(seq, editSeq.current)) return true;
        const res = await api.setPipelines(config);
        if (!res.ok) {
          setError(whyItFailed(res.error));
          if (readIsCurrent(seq, editSeq.current)) setView(before);
          return false;
        }
        setError(null);
        writeGen.current += 1;
        setView(res.view);
        return true;
      })();
      writing.current = attempt.catch(() => {});
      return attempt;
    },
    [setView],
  );

  const enableObservation = useCallback(
    async (provider: PipelineProviderId, repoRoot: string): Promise<boolean> => {
      const seq = ++editSeq.current;
      const token = ++nextSetupToken.current;
      setupToken.current = token;
      setSetup({ repoRoot, phase: "observing" });
      setSetupNotice(null);
      setError(null);

      const queued = writing.current;
      const attempt = (async (): Promise<boolean> => {
        await queued;
        if (!readIsCurrent(seq, editSeq.current)) return true;
        const current = viewRef.current;
        if (!current) return false;
        const res = await api.setPipelines(configWithObservation(current.config, provider, repoRoot));
        if (!res.ok) {
          setSetupNotice({
            repoRoot,
            tone: "attention",
            detail: "Registered with Conductor; Mission Control observation still needs enabling.",
            output: whyItFailed(res.error),
          });
          return false;
        }
        writeGen.current += 1;
        setView(res.view);
        setSetupNotice({
          repoRoot,
          tone: "ok",
          detail: "Registered and observed. Pipeline dispatch is ready for this repository.",
          output: "",
        });
        return true;
      })();
      writing.current = attempt.catch(() => {});
      try {
        return await attempt;
      } finally {
        if (setupToken.current === token) setupToken.current = null;
        setSetup(null);
      }
    },
    [setView],
  );

  const registerAndObserve = useCallback(
    async (provider: PipelineProviderId, requestedRoot: string): Promise<boolean> => {
      const seq = ++editSeq.current;
      const token = ++nextSetupToken.current;
      setupToken.current = token;
      setSetup({ repoRoot: requestedRoot, phase: "registering" });
      setSetupNotice(null);
      setError(null);

      const queued = writing.current;
      const attempt = (async (): Promise<boolean> => {
        await queued;
        if (!readIsCurrent(seq, editSeq.current)) return true;
        const res = await api.registerPipelineRepo(provider, requestedRoot);
        if (!res.ok) {
          setSetupNotice({
            repoRoot: requestedRoot,
            tone: "error",
            detail: "Registration did not complete, so observation was not enabled.",
            output: whyItFailed(res.error),
          });
          return false;
        }

        const registration = res.registration;
        setView(res.view);
        if (!registration.ok) {
          setSetupNotice({
            repoRoot: registration.repoRoot,
            tone: "error",
            detail: registration.detail,
            output: registration.output,
          });
          return false;
        }

        setSetup({ repoRoot: registration.repoRoot, phase: "observing" });
        const consent = await api.setPipelines(
          configWithObservation(res.view.config, registration.provider, registration.repoRoot),
        );
        if (!consent.ok) {
          setSetupNotice({
            repoRoot: registration.repoRoot,
            tone: "attention",
            detail: "Registered with Conductor; Mission Control observation still needs enabling.",
            output: whyItFailed(consent.error),
          });
          return false;
        }

        writeGen.current += 1;
        setView(consent.view);
        setSetupNotice({
          repoRoot: registration.repoRoot,
          tone: "ok",
          detail: "Registered and observed. Pipeline dispatch is ready for this repository.",
          output: "",
        });
        return true;
      })();
      writing.current = attempt.catch(() => {});
      try {
        return await attempt;
      } finally {
        if (setupToken.current === token) setupToken.current = null;
        setSetup(null);
      }
    },
    [setView],
  );

  const recheck = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      await refresh(editSeq.current, { force: true });
    } finally {
      setChecking(false);
    }
  }, [refresh]);

  return {
    view,
    workspaceRepos,
    save,
    registerAndObserve,
    enableObservation,
    recheck,
    checking,
    setup,
    setupNotice,
    error,
  };
}
