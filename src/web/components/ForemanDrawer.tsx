import { useEffect, useState } from "react";
import type { ForemanEpisode, IntentRelationship, SessionGoal } from "@shared/types.ts";
// Moved to shared so the daemon can reduce an episode the same way this drawer does -
// the fleet-wide ledger ships the RESULT rather than the captured screen it came from.
import { askPreview } from "@shared/foreman-ask.ts";
import { ForemanEpisodeCard } from "./ForemanEpisodeCard.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { relativeTime } from "../lib/format.ts";

// Everything Foreman has decided on this session, with the context that produced it.
//
// A rail rather than a fifth tab, and the distinction is real rather than cosmetic:
// Work queue, Gate and Diff are things the session HAS, so they belong in its tab
// strip. Foreman is a separate observer talking ABOUT the session, so it gets its own
// surface instead of a peer slot next to the session's own state.

/** How many unanswered episodes the rail's dot is counting. */
export function openEpisodeCount(episodes: ForemanEpisode[]): number {
  return episodes.filter((e) => e.disposition === "escalated" || e.disposition === "pending").length;
}

export function ForemanDrawer({
  episodes,
  intent,
  open,
  onClose,
}: {
  episodes: ForemanEpisode[];
  intent: SessionGoal | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const [selected, setSelected] = useState<number | null>(null);

  // Escape backs out one level at a time - detail to list, list to closed - rather
  // than dismissing the whole drawer from the detail view. Anything else loses the
  // reader's place in a list they may have scrolled a long way down.
  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent): void {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      // Branch on `selected` out here rather than inside a `setSelected` updater:
      // updaters must be pure, and StrictMode double-invokes them, so closing from
      // within one fires `onClose` twice per keypress.
      if (selected !== null) setSelected(null);
      else onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, selected]);

  // Closing forgets the selection, so re-opening lands on the list. A drawer that
  // reopened onto whichever episode was last read would hide the newest one, which is
  // the one it is usually being opened for.
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  if (!open) return null;

  const detail = episodes.find((e) => e.id === selected) ?? null;

  return (
    <aside className="foreman-drawer" onClick={(e) => e.stopPropagation()}>
      <header className="fd-head">
        {detail ? (
          <Tooltip label="Back to every note on this session">
            <button className="fd-back" onClick={() => setSelected(null)}>
              ← All notes
            </button>
          </Tooltip>
        ) : (
          <>
            <span className="fn-badge">Foreman</span>
            <span className="fd-title">
              {episodes.length} {episodes.length === 1 ? "note" : "notes"} on this session
            </span>
          </>
        )}
        <Tooltip label="Close this drawer (Escape)">
          <button className="fd-close" onClick={onClose} aria-label="Close">
            esc
          </button>
        </Tooltip>
      </header>

      <div className="fd-pane">
        {detail ? (
          <ForemanEpisodeCard episode={detail} detail />
        ) : (
          <>
            <IntentSummary intent={intent} />
            <div className="fd-history-head">
              <span>Decision history</span>
              <span>{episodes.length}</span>
            </div>
            {episodes.length === 0 ? (
              <p className="fd-empty dim">
                Foreman hasn&apos;t had to decide anything on this session yet.
              </p>
            ) : (
              episodes.map((e) => (
                <EpisodeRow key={e.id} episode={e} onOpen={() => setSelected(e.id)} />
              ))
            )}
          </>
        )}
      </div>
    </aside>
  );
}

const RELATIONSHIP_LABEL: Record<IntentRelationship, string> = {
  initial: "objective set",
  steer: "steering",
  amend: "objective amended",
  replace: "objective replaced",
  unclear: "needs more context",
};

/** What Foreman will treat as the completion contract on its next prompted wrap-up. */
function IntentSummary({ intent }: { intent: SessionGoal | null }): React.JSX.Element {
  if (!intent?.objective) {
    return (
      <section className="fd-intent fd-intent-empty">
        <span className="fd-intent-kicker">Current intent</span>
        <p>Waiting for the session&apos;s first substantive instruction.</p>
      </section>
    );
  }

  const resolving = intent.resolvedPromptRevision < intent.promptRevision;
  const relationship = resolving ? null : intent.relationship;
  const label = resolving
    ? "reconciling"
    : relationship
      ? RELATIONSHIP_LABEL[relationship]
      : "not classified";

  return (
    <section className={`fd-intent fd-intent-${relationship ?? "pending"}`}>
      <div className="fd-intent-top">
        <span className="fd-intent-kicker">Current intent</span>
        <span className="fd-intent-version">objective v{intent.objectiveVersion}</span>
      </div>
      <div className="fd-intent-track">
        <span className="fd-intent-node" aria-hidden />
        <div className="fd-intent-copy">
          <span className="fd-intent-label">Objective</span>
          <p className="fd-intent-objective">{intent.objective}</p>
        </div>
      </div>
      {intent.focus && (
        <div className="fd-intent-track fd-intent-focus">
          <span className="fd-intent-node" aria-hidden />
          <div className="fd-intent-copy">
            <span className="fd-intent-label">Latest focus</span>
            <p>{intent.focus}</p>
          </div>
        </div>
      )}
      <div className="fd-intent-reading">
        <span className="fd-intent-relation">{label}</span>
        <span>
          {resolving
            ? "Automatic wrap-up is paused until this instruction is classified."
            : intent.rationale ?? "No classification rationale is available yet."}
        </span>
      </div>
    </section>
  );
}

/** How each disposition colours a row. */
const ROW_CLASS: Record<string, string> = {
  escalated: "fd-row-open",
  pending: "fd-row-open",
  answered: "fd-row-done",
  skipped: "fd-row-skip",
};

const ROW_LABEL: Record<string, string> = {
  escalated: "needs your decision",
  pending: "drafted a reply",
  answered: "answered",
  skipped: "left for you",
};

/**
 * One episode in the list, leading with the QUESTION rather than the verdict.
 *
 * That ordering is the whole design of this list. When you open an archive of past
 * decisions you are looking for a particular moment, and what you remember of it is
 * what was being asked - not how Foreman characterised its own answer. Leading with
 * the purpose made every row read as a variation on "a decision was needed", which is
 * true of all of them and identifies none of them.
 */
function EpisodeRow({
  episode,
  onOpen,
}: {
  episode: ForemanEpisode;
  onOpen: () => void;
}): React.JSX.Element {
  const answeredBy =
    episode.disposition === "answered" && episode.resolvedBy
      ? `answered by ${episode.resolvedBy === "you" ? "you" : "foreman"}`
      : (ROW_LABEL[episode.disposition] ?? episode.disposition);
  return (
    <Tooltip label={`Open this note - ${answeredBy}`}>
      <button className={`fd-row ${ROW_CLASS[episode.disposition] ?? ""}`} onClick={onOpen}>
      <span className="fd-row-top">
        <span className="fd-row-state">{answeredBy}</span>
        {episode.createdAt > 0 && (
          <span className="fd-row-when dim">{relativeTime(episode.createdAt)}</span>
        )}
      </span>
      <span className="fd-row-q">{askPreview(episode)}</span>
        {episode.purpose && <span className="fd-row-verdict">{episode.purpose}</span>}
      </button>
    </Tooltip>
  );
}
