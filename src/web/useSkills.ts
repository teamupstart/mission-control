import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillsConfigPatch } from "@shared/protocol.ts";
import type { SkillsView } from "@shared/types.ts";
import { api, fetchSkills } from "./lib/api.ts";

// The skills catalog + what's switched on, for the settings panel. Polled rather
// than streamed for the reason useForeman.ts gives about its own config: this is
// coarse, low-frequency dashboard chrome, not worth another SSE channel. The poll
// also keeps `pending` moving as sessions catch up, which is the one part of the
// view that changes without anyone touching the panel.

const POLL_MS = 4000;

/**
 * Frame a rejection as one short sentence. The daemon answers a bad patch with zod's
 * raw multi-line JSON dump, and a reconcile refusal with a joined list of problems -
 * neither of which is prose. Flatten and clamp rather than trusting it to render.
 */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That didn't stick - the daemon refused it.";
  return `That didn't stick: ${flat.length > 140 ? `${flat.slice(0, 139)}…` : flat}`;
}

export interface SkillsState {
  view: SkillsView | null;
  /** Flip the master switch, or one skill. Optimistic, reverted if refused. */
  update: (patch: SkillsConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useSkills(): SkillsState {
  const [view, setViewState] = useState<SkillsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The view as last confirmed, readable without making `update` depend on it (which
  // would rebuild the callback on every poll). This is what a revert restores.
  const viewRef = useRef<SkillsView | null>(null);

  const setView = useCallback((v: SkillsView | null): void => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const v = await fetchSkills();
      if (alive && v) setView(v);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setView]);

  /**
   * Apply a change optimistically, and TAKE IT BACK if the server refuses.
   *
   * The revert is not politeness. A refused patch changed nothing - not the config, not
   * the symlinks: the daemon decides before it writes, so a refusal is a patch it never
   * began, not one it took back. A toggle left sitting in the on position would
   * therefore be the panel claiming a skill is live in every session on the machine when
   * it is live in none. The next poll would eventually snap it back with no explanation
   * of what happened. For a control whose whole promise is "this is now in force
   * fleet-wide", showing a state that isn't in force is the whole ballgame.
   */
  const update = useCallback(
    async (patch: SkillsConfigPatch): Promise<void> => {
      const before = viewRef.current;
      if (!before) return;
      setView(optimistic(before, patch));
      const res = await api.setSkillsConfig(patch);
      if (!res.ok) {
        setView(before);
        setError(whyItFailed(res.error));
        return;
      }
      setError(null);
      const v = await fetchSkills();
      if (v) setView(v);
    },
    [setView],
  );

  return { view, update, error };
}

/**
 * What the panel should show the instant a toggle is clicked.
 *
 * `pending` is deliberately left alone rather than guessed at. It answers "how many
 * sessions haven't picked this up yet", which depends on whether the reconciler
 * actually changed the symlink set - toggling a skill that was already on changes
 * nothing and owes nobody a reload. Only the server knows, and it says so within the
 * poll. A number invented here would be wrong in exactly the cases the operator is
 * watching it for.
 */
function optimistic(view: SkillsView, patch: SkillsConfigPatch): SkillsView {
  return {
    ...view,
    enabled: patch.enabled ?? view.enabled,
    skills: view.skills.map((s) => ({ ...s, enabled: patch.skills?.[s.id] ?? s.enabled })),
  };
}
