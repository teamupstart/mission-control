import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessesConfig, HarnessesConfigPatch } from "@shared/protocol.ts";
import { mergeHarnessesPatch, readIsCurrent } from "./harnesses-reconcile.ts";
import { api, fetchHarnessesConfig } from "./lib/api.ts";

// The "Harnesses" settings section's config: dispatch-time defaults the harness
// applies to the sessions it launches. Owned locally by SettingsPage (like
// useSkills), because nothing outside the panel reads it - unlike Foreman, whose
// state the topbar control shares.
//
// Reconciled from THREE directions, which is why the ordering guard below exists:
//  - the mount read, which fills the panel;
//  - `harnesses_config_changed` over SSE, so another tab's edit (or this tab's dispatch
//    modal) sees a change at once rather than at the end of a poll interval;
//  - a slow poll, kept only as a backstop for a dropped SSE channel, since a change made
//    while the stream is down is announced to nobody and the config rides no snapshot.
//
// Every one of those lands asynchronously, so every one of them can land STALE. See
// `readIsCurrent`.

const POLL_MS = 15000;

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

/**
 * @param revision Bumped by `useEventStream` on every `harnesses_config_changed`. A counter
 * rather than the config itself because the event carries no body - see its declaration in
 * `ServerEvent` for why - so this hook re-reads the route when the number moves.
 */
export function useHarnesses(revision = 0): HarnessesState {
  const [config, setConfigState] = useState<HarnessesConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The config as last written, readable without making `update` depend on it (which
  // would rebuild the callback on every toggle). This is what a revert restores.
  const configRef = useRef<HarnessesConfig | null>(null);
  // How many edits this panel has STARTED. Every read captures it before leaving and is
  // dropped on return if it moved, so a response can never reintroduce a value the
  // operator has already changed away from.
  const editSeq = useRef(0);

  const setConfig = useCallback((c: HarnessesConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  /** Read the route and apply the result only if no edit started while it was in flight. */
  const read = useCallback(async (): Promise<void> => {
    const seq = editSeq.current;
    const c = await fetchHarnessesConfig();
    if (c && readIsCurrent(seq, editSeq.current)) setConfig(c);
  }, [setConfig]);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      if (!alive) return;
      await read();
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // `revision` is a dependency so a pushed change re-reads immediately: remounting this
    // effect fires `tick` at once and restarts the backstop interval from now.
  }, [read, revision]);

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
      const seq = ++editSeq.current;
      setConfig(mergeHarnessesPatch(before, patch));
      const res = await api.setHarnessesConfig(patch);
      if (!res.ok) {
        // Say so either way - a refusal the operator never sees is how a panel comes to
        // disagree with the daemon silently.
        setError(whyItFailed(res.error));
        // But only REVERT while this is still the newest edit. A later edit has already
        // replaced what `before` holds, so restoring it would undo that newer change; the
        // later edit's own confirming read is what corrects this one's optimistic value.
        if (readIsCurrent(seq, editSeq.current)) setConfig(before);
        return;
      }
      setError(null);
      // Confirming read, guarded like the poll: if the operator has changed something else
      // since the PUT resolved, this body predates it and must not be applied.
      const c = await fetchHarnessesConfig();
      if (c && readIsCurrent(seq, editSeq.current)) setConfig(c);
    },
    [setConfig],
  );

  return { config, update, error };
}
