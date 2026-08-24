import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import { MECHANISM_PROSE, deliverySummary } from "../lib/standing-instructions-view.ts";
import { RepositoryName } from "./RepositoryName.tsx";

/**
 * What a session gets, or got, rendered read-only.
 *
 * ONE component with two callers - the dispatch note and the session header chip - rather
 * than two components with one shape between them. They render the same
 * `StandingInstructionsDelivery`, so writing it twice would let "what will be sent" and
 * "what was sent" drift into two different-looking answers about the same bytes.
 *
 * What they do NOT share is the source. The dispatch note reads live configuration through
 * the resolved route, because nothing has happened yet; the session chip reads that
 * session's immutable launch snapshot. That difference lives at the two call sites, and it
 * is deliberately not a prop here - a component that could resolve live config for a
 * running session is a component that can lie to it.
 *
 * The MECHANISM is named, not just the fact of delivery. On Claude the text rides the system
 * prompt and never enters the transcript, so a marker that only said "sent" would send an
 * operator searching a conversation for something that was never in it.
 */
export function StandingInstructionsDeliveryView({
  delivery,
  heading,
}: {
  delivery: StandingInstructionsDelivery;
  /** What this delivery is: a forecast, or a record. The caller owns the tense. */
  heading: string;
}): React.JSX.Element | null {
  if (!delivery.text) return null;
  const prose = MECHANISM_PROSE[delivery.mechanism];
  return (
    <div className="si-delivery">
      <p className="si-delivery-head">
        <span className="si-glyph" aria-hidden>✎</span>
        <span className="si-delivery-heading">{heading}</span>
      </p>
      <p className="si-delivery-summary">
        {deliverySummary(delivery.text, delivery.mechanism)}
        <span className="si-delivery-detail">{` (${prose.detail})`}</span>
      </p>
      {/* Provenance stays one entry per contributing repository, so a two-repo dispatch can
          still say which checkout inherited which stored key - including the case the
          composer groups into a single block because both resolved to the same words. */}
      <ul className="si-delivery-sources">
        {delivery.sources.map((source) => (
          <li key={source.repoPath}>
            <RepositoryName path={source.repoPath} className="si-source-repo" />
            <span className="si-source-key">
              {source.matchedKey === null
                ? " · from the machine-wide default"
                : ` · from the rule for ${source.matchedKey}`}
            </span>
          </li>
        ))}
      </ul>
      <pre className="si-delivery-text">{delivery.text}</pre>
      {!prose.inTranscript && (
        <p className="si-delivery-note">
          Carried as {prose.channel}, so it never appears in the conversation.
        </p>
      )}
    </div>
  );
}
