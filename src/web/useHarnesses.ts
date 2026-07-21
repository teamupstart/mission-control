import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessesConfig, HarnessesConfigPatch } from "@shared/protocol.ts";
import { api, fetchHarnessesConfig } from "./lib/api.ts";

// The "Harnesses" settings section's config: dispatch-time defaults the harness
// applies to the sessions it launches. Owned locally by SettingsModal (like
// useSkills), because nothing outside the panel reads it - unlike Foreman, whose
// state the topbar control shares.
//
// Polled rather than streamed for the same reason as Foreman's config: it's coarse,
// rarely-edited chrome, not worth another SSE channel. The poll also reconciles a
// second dashboard tab's edits, and snaps an optimistic value back if the server
// refused it out-of-band.

const POLL_MS = 4000;

/**
 * Frame a rejection as one short sentence. A bad patch comes back as zod's raw
 * multi-line JSON, which would render as a wall of braces in this panel - so flatten
 * and clamp it. Mirrors `useForeman`'s `whyItFailed`.
 */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface HarnessesState {
  config: HarnessesConfig | null;
  update: (patch: HarnessesConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useHarnesses(): HarnessesState {
  const [config, setConfigState] = useState<HarnessesConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The config as last written, readable without making `update` depend on it (which
  // would rebuild the callback on every toggle). This is what a revert restores.
  const configRef = useRef<HarnessesConfig | null>(null);

  const setConfig = useCallback((c: HarnessesConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const c = await fetchHarnessesConfig();
      if (alive && c) setConfig(c);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setConfig]);

  /**
   * Apply a change optimistically, and TAKE IT BACK if the server refuses - so the
   * toggle never shows a state that isn't in force. Same contract as Foreman's,
   * which matters more here: this switch governs whether dispatched agents run
   * unattended, so a switch that reads on while the daemon has it off is the bug.
   */
  const update = useCallback(
    async (patch: HarnessesConfigPatch): Promise<void> => {
      const before = configRef.current;
      if (!before) return;
      // Mirrors the server's merge (see `setHarnessesConfig`): per-agent maps merge,
      // so changing Claude doesn't blank the Codex row on the optimistic pass.
      setConfig({
        ...before,
        ...patch,
        defaultModel: { ...before.defaultModel, ...(patch.defaultModel ?? {}) },
        defaultEffort: { ...before.defaultEffort, ...(patch.defaultEffort ?? {}) },
      });
      const res = await api.setHarnessesConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return;
      }
      setError(null);
      const c = await fetchHarnessesConfig();
      if (c) setConfig(c);
    },
    [setConfig],
  );

  return { config, update, error };
}
