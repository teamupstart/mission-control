import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmConfig, LlmConfigPatch } from "@shared/protocol.ts";
import type { LlmStatus } from "@shared/types.ts";
import type { PersonaDefaultsView } from "@shared/workflow.ts";
import { api, fetchLlmConfig, fetchLlmStatus, fetchPersonaDefaults } from "./lib/api.ts";

// The LLM config plus what the daemon resolved from it. Polled rather than streamed for
// the same reason the Inspector's and Foreman's are: coarse, low-frequency control-panel
// chrome, not worth another SSE channel.
//
// Both reads, always together, because the panel renders both halves of every control: the
// box holds YOUR override and the line under it says which layer actually won. A config
// without a status would show an empty box under a set `MISSION_GOAL_MODEL` and quietly
// present the shipped default as what is running.

const POLL_MS = 4000;

function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick - the daemon refused it.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface LlmState {
  config: LlmConfig | null;
  /**
   * What the daemon will actually spawn with, and which layer chose each value. Null until
   * it answers - the fields fall back to showing the shipped defaults, which is what an
   * unreachable daemon does to every other control in Settings.
   */
  status: LlmStatus | null;
  personaDefaults: PersonaDefaultsView | null;
  update: (patch: LlmConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useLlm(): LlmState {
  const [config, setConfigState] = useState<LlmConfig | null>(null);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [personaDefaults, setPersonaDefaults] = useState<PersonaDefaultsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<LlmConfig | null>(null);
  /**
   * Bumped by every write. A poll reads it before its request and again after, and discards
   * its answer if a write started in between - the same guard `useInspector` carries, and
   * needed for the same reason: a tick that left before a commit lands after it and would
   * put the pre-write value back in a box the operator just typed into.
   */
  const writes = useRef(0);

  const setConfig = useCallback((c: LlmConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const at = writes.current;
      const [c, s, defaults] = await Promise.all([
        fetchLlmConfig(),
        fetchLlmStatus(),
        fetchPersonaDefaults(),
      ]);
      if (!alive || writes.current !== at) return;
      // The status is raced by a write exactly as the config is - it is DERIVED from the
      // config a `PUT` may have just changed - so it takes the same guard rather than being
      // applied unconditionally like a read-only list would be.
      if (s) setStatus(s);
      if (defaults) setPersonaDefaults(defaults);
      if (c) setConfig(c);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setConfig]);

  /**
   * Apply a change optimistically, and take it back if the daemon refuses.
   *
   * `models` merges per key on this side too, matching `setLlmConfig` on the server: the
   * optimistic value has to be the one the server will arrive at, or committing one field
   * would visibly blank the others for a poll interval before they came back.
   */
  const update = useCallback(
    async (patch: LlmConfigPatch): Promise<void> => {
      const before = configRef.current;
      if (!before) return;
      writes.current += 1;
      setConfig({ ...before, ...patch, models: { ...before.models, ...patch.models } });
      const res = await api.setLlmConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return;
      }
      setError(null);
      const at = (writes.current += 1);
      // Re-read NOW rather than on the next poll: a committed model has to re-resolve, or
      // the source line under the box goes on saying "Shipped default" for up to `POLL_MS`
      // after you typed an override into it.
      const [c, s, defaults] = await Promise.all([
        fetchLlmConfig(),
        fetchLlmStatus(),
        fetchPersonaDefaults(),
      ]);
      if (writes.current !== at) return;
      if (s) setStatus(s);
      if (defaults) setPersonaDefaults(defaults);
      if (c) setConfig(c);
    },
    [setConfig],
  );

  return { config, status, personaDefaults, update, error };
}
