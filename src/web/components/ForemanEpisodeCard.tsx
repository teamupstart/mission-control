import { Markdown } from "./Markdown.tsx";
import type { ForemanEpisode, NoteDisposition } from "@shared/types.ts";
import { DISPOSITION_LABEL } from "../lib/foreman.ts";
import { relativeTime } from "../lib/format.ts";

// One recorded Foreman decision, rendered whole: what it concluded, and - on the
// detail path - the ask that provoked it and what actually reached the child.
//
// Shared by the two surfaces that show an episode, and deliberately so. The
// transcript shows it as a turn in the conversation; the drawer shows it as a row in
// the archive. Those differ in what CONTEXT they carry (the transcript is already the
// context, the drawer has none), not in how a verdict is written down - so they share
// the verdict and diverge on the ask.

/**
 * What the header says happened.
 *
 * `answered` alone is ambiguous in a way the live note never had to care about,
 * because the note is only ever written by Foreman. An episode outlives that: an
 * escalation you approved ends up `answered` too, and labelling it "answered for
 * you" credits Foreman with your decision. The record is the one place that must get
 * the author right, so it reads `resolvedBy` rather than the disposition alone -
 * and `resolvedBy` rather than `sentBy`, because a dismissal is a decision you made
 * that sent nothing, so it has no author to read.
 */
function episodeLabel(e: ForemanEpisode): string {
  if (e.disposition === "answered" && e.resolvedBy === "you") return "you answered";
  if (e.disposition === "skipped" && e.resolvedBy === "you") return "you dismissed";
  return DISPOSITION_LABEL[e.disposition];
}

/** How each disposition colours its left border - the same scale the note uses. */
const DISPOSITION_CLASS: Record<NoteDisposition, string> = {
  answered: "fe-answered",
  pending: "fe-pending",
  escalated: "fe-escalated",
  skipped: "fe-skipped",
};

/**
 * The verdict half: header, purpose, brief, recommendation.
 *
 * Rendered at FULL length with no clamp, which is the point of moving it here. The
 * old card was pinned above the transcript, so its length pushed the conversation off
 * screen; in the scroller it is just a long message, and long messages are ordinary.
 */
export function ForemanEpisodeCard({
  episode,
  /** The ask, and what was sent. Off in the transcript, where the ask is the chat. */
  detail = false,
}: {
  episode: ForemanEpisode;
  detail?: boolean;
}): React.JSX.Element {
  const e = episode;
  return (
    <section className={`foreman-episode ${DISPOSITION_CLASS[e.disposition]}`}>
      <header className="fe-head">
        <span className="fn-badge">Foreman</span>
        <span className="fe-disp">{episodeLabel(e)}</span>
        {e.createdAt > 0 && <span className="fe-time dim">{relativeTime(e.createdAt)}</span>}
      </header>

      {detail && <EpisodeAsk episode={e} />}

      {e.purpose && <p className="fe-purpose">{e.purpose}</p>}

      {e.brief && (
        <div className="fe-brief markdown">
          <Markdown>{e.brief}</Markdown>
        </div>
      )}

      {e.recommendation && (
        <div className="fn-rec">
          <span className="fn-rec-label">
            {e.disposition === "escalated" ? "Suggested answer" : "Proposed reply"}
          </span>
          <p className="fn-rec-text">{e.recommendation}</p>
        </div>
      )}

      {detail && <EpisodeResolution episode={e} />}
    </section>
  );
}

/**
 * The question, verbatim.
 *
 * Monospace, and not as a style preference: for a terminal ask this is a literal
 * screen capture, where the `❯` cursor marks where an Enter would have landed and the
 * rows are aligned by column. Proportional type would quietly misrepresent what the
 * model was actually looking at when it decided.
 *
 * The pane wins over `question` when both exist, because the pane is the whole screen
 * and `question` for a terminal ask is only the notification line ("Claude needs your
 * permission"), which never names what is being approved.
 */
function EpisodeAsk({ episode }: { episode: ForemanEpisode }): React.JSX.Element | null {
  const ask = episode.pane ?? episode.question;
  if (!ask.trim()) return null;
  const where =
    episode.surface === "input-review"
      ? "the review it posted"
      : episode.pane
        ? "the child's screen, as Foreman read it"
        : "what the session reported";
  return (
    <div className="fe-block">
      <div className="fe-label">
        The ask <span>· {where}</span>
      </div>
      <pre className="fe-ask">{ask}</pre>
      <EpisodeMeta episode={episode} />
    </div>
  );
}

/** The verdict's own fields, which the note has never carried. */
function EpisodeMeta({ episode }: { episode: ForemanEpisode }): React.JSX.Element | null {
  const chips: string[] = [];
  if (episode.situation) chips.push(episode.situation);
  if (episode.classification) chips.push(episode.classification);
  // Rendered only when present, and `!= null` rather than truthy: a confidence of 0
  // is a real and highly informative reading, and `0 &&` would hide exactly the
  // episode a reader most wants to see the number on.
  if (episode.confidence != null) chips.push(`confidence ${episode.confidence.toFixed(2)}`);
  if (episode.tier != null) chips.push(`tier ${episode.tier}`);
  if (chips.length === 0) return null;
  return (
    <div className="fe-meta">
      {chips.map((c) => (
        <span key={c}>{c}</span>
      ))}
    </div>
  );
}

/**
 * What reached the child, and who sent it.
 *
 * The half that did not survive at all before the episode log: Approve nulled the
 * recommendation, leaving `lastAction: "approved by you"` and no record of the words.
 */
function EpisodeResolution({ episode }: { episode: ForemanEpisode }): React.JSX.Element | null {
  const { disposition, resolvedBy, sentText, sentOption, lastAction, resolvedAt } = episode;
  if (!resolvedBy && !lastAction) return null;
  // Branches on the disposition as well as the author, for the same reason
  // `episodeLabel` does: "You approved" over a header reading "you dismissed" is the
  // block contradicting the two lines above it about what the human actually did.
  const who =
    resolvedBy === "you"
      ? disposition === "skipped"
        ? "You dismissed this"
        : "You approved"
      : resolvedBy === "foreman"
        ? disposition === "skipped"
          ? "Foreman left this for you"
          : "Foreman answered"
        : (lastAction ?? "Recorded");
  return (
    <div className="fe-block">
      <div className="fe-label">Resolution</div>
      <div className="fe-resolution">
        <span className="fe-res-who">
          {who}
          {resolvedAt ? ` · ${relativeTime(resolvedAt)}` : ""}
        </span>
        {sentOption && (
          <p className="fe-res-option">
            Selected option {sentOption.number}. {sentOption.label}
          </p>
        )}
        {/* Suppressed when it merely repeats the option's label: a menu send types
            nothing, so `sentText` IS the label there, and printing both reads as two
            separate things having happened. */}
        {sentText && sentText !== sentOption?.label && <p className="fe-res-text">{sentText}</p>}
        {!sentText && !sentOption && lastAction && <p className="fe-res-text dim">{lastAction}</p>}
      </div>
    </div>
  );
}
