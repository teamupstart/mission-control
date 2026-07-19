import { useEffect, useState } from "react";
import type { ForemanEpisode } from "@shared/types.ts";
import { ForemanEpisodeCard } from "./ForemanEpisodeCard.tsx";
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
  open,
  onClose,
}: {
  episodes: ForemanEpisode[];
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
      setSelected((cur) => {
        if (cur !== null) return null;
        onClose();
        return null;
      });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
          <button className="fd-back" onClick={() => setSelected(null)}>
            ← All notes
          </button>
        ) : (
          <>
            <span className="fn-badge">Foreman</span>
            <span className="fd-title">
              {episodes.length} {episodes.length === 1 ? "note" : "notes"} on this session
            </span>
          </>
        )}
        <button className="fd-close" onClick={onClose} aria-label="Close">
          esc
        </button>
      </header>

      <div className="fd-pane">
        {detail ? (
          <ForemanEpisodeCard episode={detail} detail />
        ) : episodes.length === 0 ? (
          <p className="fd-empty dim">
            Foreman hasn&apos;t had to decide anything on this session yet.
          </p>
        ) : (
          episodes.map((e) => (
            <EpisodeRow key={e.id} episode={e} onOpen={() => setSelected(e.id)} />
          ))
        )}
      </div>
    </aside>
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
    episode.disposition === "answered" && episode.sentBy
      ? `answered by ${episode.sentBy === "you" ? "you" : "foreman"}`
      : (ROW_LABEL[episode.disposition] ?? episode.disposition);
  return (
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
  );
}

/** `Claude needs your permission to use Bash` and friends - a header, not a question. */
const PERMISSION_HEADER = /needs your permission to use/i;

/** A numbered option row, as `parsePaneDialog` recognises one. */
const OPTION_ROW = /^\s*❯?\s*\d{1,2}\.\s+\S/u;

/**
 * A one-glance version of the ask.
 *
 * The hard case is a terminal menu, where the three candidate texts are all wrong on
 * their own. `question` is the notification line - "Claude needs your permission to
 * use AskUserQuestion" - which never names what is being approved, and reads
 * identically on every such row. The option rows say what the CHOICES were but not
 * what was being decided. And the pane is a whole screen, mostly scrollback.
 *
 * What a reader actually remembers is the sentence above the options, so that is what
 * this reaches for: the prose between the permission header and the first numbered
 * row. Falling back to the options, then the question, then the pane's tail - the
 * tail rather than the head because the dialog is the foreground and sits at the
 * BOTTOM of a capture (see `parsePaneDialog`).
 */
export function askPreview(e: ForemanEpisode): string {
  const prompt = panePrompt(e.pane);
  if (prompt) return prompt;
  if (e.menu && e.menu.options.length > 0) {
    return e.menu.options.map((o) => `${o.number}. ${o.label}`).join("   ");
  }
  const q = e.question.trim();
  if (q) return q;
  const pane = e.pane?.trim();
  if (!pane) return "(no question was recorded)";
  return pane.split("\n").slice(-3).join(" ").trim();
}

/** The prose a pane showed above its option rows, or null when it showed none. */
function panePrompt(pane: string | null): string | null {
  if (!pane) return null;
  const lines: string[] = [];
  for (const raw of pane.split("\n")) {
    if (OPTION_ROW.test(raw)) break;
    const line = raw.trim();
    if (!line || PERMISSION_HEADER.test(line)) continue;
    lines.push(line);
  }
  const text = lines.join(" ").trim();
  return text || null;
}
