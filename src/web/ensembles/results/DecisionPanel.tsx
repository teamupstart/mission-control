import { useState } from "react";
import type { EnsembleSelectOneSelection } from "@shared/ensemble.ts";
import { Tooltip } from "../../components/Tooltip.tsx";
import type { EnsembleResultContext } from "./index.ts";

/**
 * The ONE select-one decision form.
 *
 * It was written twice - once in Best-of-N's view and once in Panel vote's - near-verbatim, and
 * the two copies were already drifting: only one of them guarded its radio against a tie with
 * no recommendation. Every guarantee this form carries is the same guarantee whichever strategy
 * asks for it, so it is one component and the strategy supplies only the words that are its own:
 * the choices, the intro, and what an override means when IT is the thing being overridden.
 *
 * What the form is FOR is the destructive step behind it. Confirming a winner resets that
 * member's checkout and reaps the other worktrees, so nothing here is reachable by accident: a
 * rationale is required, the destructive effect is confirmed by hand, and the submit stays
 * disabled until both. The one-shot semantics are the server's - `expectedStatus` refuses a
 * second decide once the first moved the run to `finalizing` - and are not restated as a
 * client-side lock, which would only ever be a second, weaker answer.
 */

/** One thing that can be picked, worded by the strategy that ranked it. */
export interface DecisionChoice {
  artifactId: string;
  /** The row's own label: rank, subject, and whatever the strategy adds ("- contested"). */
  label: string;
  /** The hover sentence for this row. */
  tip: string;
}

export function DecisionPanel({
  choices,
  recommendedArtifactId,
  intro,
  overrideWarning,
  decision,
}: {
  choices: DecisionChoice[];
  /**
   * What the evidence recommends, or null when it recommends nothing - a panel that could not
   * separate its top two. Null selects nothing initially, so the operator makes the pick the
   * judges could not, and no override warning can fire against a recommendation that does not
   * exist.
   */
  recommendedArtifactId: string | null;
  /** What this strategy's evidence is, and what confirming does. */
  intro: React.ReactNode;
  /** The sentence shown when the pick is not the recommended one. */
  overrideWarning: string;
  decision: NonNullable<EnsembleResultContext["decision"]>;
}): React.JSX.Element {
  const [mode, setMode] = useState<"select" | "no_consensus">("select");
  const [artifactId, setArtifactId] = useState<string>(recommendedArtifactId ?? "");
  const [reason, setReason] = useState("");
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const selection: EnsembleSelectOneSelection =
    mode === "select"
      ? { kind: "selected", artifactId }
      : { kind: "no_consensus", reason: reason.trim() };
  const ready =
    confirmed &&
    !decision.busy &&
    rationale.trim().length > 0 &&
    (mode === "select" ? Boolean(artifactId) : reason.trim().length > 0);
  const nonRecommended =
    mode === "select" &&
    Boolean(artifactId) &&
    recommendedArtifactId !== null &&
    artifactId !== recommendedArtifactId;

  return (
    <form
      className="ensemble-decision"
      aria-label="Confirm a winner"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) decision.onDecide(selection, rationale.trim());
      }}
    >
      <h4>Confirm the outcome</h4>
      <p className="ensemble-decision-intro">{intro}</p>
      <fieldset className="ensemble-decision-choices">
        <legend>Outcome</legend>
        {choices.map((choice) => (
          <Tooltip key={choice.artifactId} label={choice.tip}>
            <label className="ensemble-decision-choice">
              <input
                type="radio"
                name="ensemble-decision"
                checked={mode === "select" && artifactId === choice.artifactId}
                onChange={() => {
                  setMode("select");
                  setArtifactId(choice.artifactId);
                }}
              />
              <span>{choice.label}</span>
            </label>
          </Tooltip>
        ))}
        <Tooltip label="Promote none; keep every candidate's snapshot">
          <label className="ensemble-decision-choice">
            <input
              type="radio"
              name="ensemble-decision"
              checked={mode === "no_consensus"}
              onChange={() => setMode("no_consensus")}
            />
            <span>No consensus - keep every snapshot, promote none</span>
          </label>
        </Tooltip>
      </fieldset>
      {mode === "no_consensus" && (
        <label className="ensemble-field">
          <span>Why there is no winner</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            required
          />
        </label>
      )}
      {nonRecommended && (
        <p className="ensemble-warn" role="note">
          {overrideWarning}
        </p>
      )}
      <label className="ensemble-field">
        <span>Rationale (required, recorded with the decision)</span>
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          rows={2}
          required
        />
      </label>
      <Tooltip label="Confirm you understand the destructive effect before deciding">
        <label className="ensemble-confirm-line">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            {mode === "select"
              ? "I understand the other worktrees will be reaped."
              : "I understand no member is promoted and all snapshots are retained."}
          </span>
        </label>
      </Tooltip>
      {/* Deciding is one-shot, and the operator is told so BEFORE the click rather than by a
          409 after it: the server refuses a second `decide` on `expectedStatus`, which is a
          guarantee, not a warning, and a form that only mentioned it in the error is a form
          that let someone plan to change their mind. */}
      <p className="ensemble-decision-oneshot">
        Recorded once. A decision cannot be replayed or revised - the losers' snapshots are kept,
        so a change of mind is a Reset checkout, not a second decision.
      </p>
      {decision.error && (
        <p className="ensemble-error" role="alert">
          {decision.error}
        </p>
      )}
      <Tooltip label="Record this decision and begin finalization">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {decision.pending
            ? "Recording…"
            : mode === "select"
              ? "Confirm winner"
              : "Record no consensus"}
        </button>
      </Tooltip>
    </form>
  );
}
