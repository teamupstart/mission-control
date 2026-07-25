import { useMemo, useState } from "react";
import type { EnsembleEvaluation, EnsembleStageAttempt } from "@shared/ensemble.ts";
import {
  parseConsensusDecisionInput,
  parseConsensusFindings,
  type ConsensusDivergence,
  type ConsensusFindings,
} from "@shared/ensemble-strategies/consensus.ts";
import { Tooltip } from "../../components/Tooltip.tsx";
import type { EnsembleRunDetailResponse } from "../types.ts";
import type { EnsembleResultContext } from "./index.ts";

/**
 * Consensus's result presentation: what the fleet agreed on, the questions it split over with the
 * positions each attempt actually took, and - while the run awaits a person - the form that
 * answers them. Everything strategy specific about the OUTCOME lives here, so the generic detail
 * and engine never branch on `consensus`.
 *
 * Two rules this view is written around, both of them safety rather than style:
 *
 *  - **Every string from the evaluator renders as TEXT.** An agreement, a question, an option
 *    label and its rationale are all model output over untrusted candidate diffs. They go into
 *    JSX children and never into `dangerouslySetInnerHTML`, a `title` that is parsed, a URL, or a
 *    React `key` that is treated as identity - the server-assigned option id is what identity is
 *    keyed on.
 *  - **The questions come from the decision stage's persisted INPUT.** That is what the operator
 *    is being asked and what their answers are validated against; rendering the evaluation row
 *    instead would let a screen and a server-side check disagree about the question set.
 */

/**
 * The evaluation whose findings are on screen, with its parsed body.
 *
 * `preferId` is the evaluation the decision stage recorded as the source of its question set. It
 * WINS over recency, and when it names an evaluation this response does not carry, the answer is
 * null rather than the newest one: a pass re-run after the stage opened has different runner,
 * model, attempt and truncation facts, and labelling one pass's questions with another pass's
 * evidence metadata is a claim about provenance that is simply false. No metadata is better than
 * wrong metadata, so the header and the truncation warning disappear together.
 */
function findingsEvaluation(
  evaluations: EnsembleEvaluation[],
  preferId: string | null,
): { evaluation: EnsembleEvaluation; findings: ConsensusFindings } | null {
  const succeeded = evaluations
    .filter((e) => e.status === "succeeded" && e.result)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const readable = succeeded
    .map((evaluation) => ({ evaluation, findings: parseConsensusFindings(evaluation.result?.body ?? null) }))
    .filter((entry): entry is { evaluation: EnsembleEvaluation; findings: ConsensusFindings } => entry.findings !== null);
  if (preferId !== null) {
    return readable.find((entry) => entry.evaluation.id === preferId) ?? null;
  }
  return readable[0] ?? null;
}

/** The decision stage attempt holding the exact question set the operator was asked. */
function askedQuestions(
  stageAttempts: EnsembleStageAttempt[],
): { agreements: string[]; questions: ConsensusDivergence[]; evaluationId: string | null } | null {
  const decisions = stageAttempts
    .filter((attempt) => attempt.driverKind === "decision")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const attempt of decisions) {
    const asked = parseConsensusDecisionInput(attempt.input);
    if (asked) {
      return { agreements: asked.agreements, questions: asked.questions, evaluationId: asked.evaluationId };
    }
  }
  return null;
}

/** The answers already recorded, keyed by question id, or null when none has been. */
function recordedAnswers(
  detail: EnsembleRunDetailResponse,
): Map<string, { optionId: string | null; note: string }> | null {
  const decision = [...detail.decisions]
    .filter((candidate) => candidate.status !== "superseded")
    .sort((a, b) => b.version - a.version)[0];
  if (!decision) return null;
  const body = decision.selection.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const answers = (body as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return null;
  const map = new Map<string, { optionId: string | null; note: string }>();
  for (const answer of answers) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) continue;
    const record = answer as { questionId?: unknown; optionId?: unknown; note?: unknown };
    if (typeof record.questionId !== "string") continue;
    map.set(record.questionId, {
      optionId: typeof record.optionId === "string" ? record.optionId : null,
      note: typeof record.note === "string" ? record.note : "",
    });
  }
  return map.size > 0 ? map : null;
}

export function ConsensusResultView(ctx: EnsembleResultContext): React.JSX.Element | null {
  const asked = useMemo(() => askedQuestions(ctx.detail.stageAttempts), [ctx.detail.stageAttempts]);
  // Once the decision stage has opened, its recorded evaluation id decides which pass's metadata is
  // shown - never whichever pass is newest. Before it opens there is no question set to be wrong
  // about, so the newest readable findings are the right thing to render.
  const found = useMemo(
    () => findingsEvaluation(ctx.detail.evaluations, asked?.evaluationId ?? null),
    [ctx.detail.evaluations, asked],
  );
  const answers = useMemo(() => recordedAnswers(ctx.detail), [ctx.detail]);

  if (!found && !asked) {
    return (
      <p className="ensemble-empty">
        No divergence pass has been recorded yet. It runs once every live attempt has submitted or
        terminated and at least three produced a snapshot.
      </p>
    );
  }

  // The persisted question set wins: it is what was asked and what an answer is checked against.
  const agreements = asked?.agreements ?? found?.findings.agreements ?? [];
  const questions = asked?.questions ?? found?.findings.divergences ?? [];
  const evaluation = found?.evaluation ?? null;

  return (
    <div className="ensemble-result">
      <header className="ensemble-result-head">
        <h4>Agreements and divergences</h4>
        {evaluation && (
          <small>
            {evaluation.runnerId ?? "runner"} · {evaluation.modelId ?? "model"} · attempt{" "}
            {evaluation.attempt}
          </small>
        )}
      </header>
      {found?.findings.evidenceTruncated && (
        <p className="ensemble-warn" role="note">
          Some attempt diffs were truncated for the evaluator. A question it did not raise may still
          be open.
        </p>
      )}

      <section className="ensemble-agreements" aria-label="Agreements">
        <h5>Every attempt did this the same way</h5>
        {agreements.length === 0 ? (
          <p className="ensemble-muted">
            Nothing was decided the same way by all of them - every judgement call below was made
            differently.
          </p>
        ) : (
          <ul>
            {agreements.map((agreement, i) => (
              <li key={i}>{agreement}</li>
            ))}
          </ul>
        )}
      </section>

      {questions.length === 0 ? (
        <p className="ensemble-muted">
          The attempts made no conflicting decisions, so there is nothing to choose between.
        </p>
      ) : (
        <ol className="ensemble-divergences">
          {questions.map((question) => (
            <DivergenceCard
              key={question.id}
              question={question}
              subjectLabel={ctx.subjectLabel}
              onOpenArtifact={ctx.onOpenArtifact}
              answer={answers?.get(question.id) ?? null}
            />
          ))}
        </ol>
      )}

      {ctx.decision && <DivergenceAnswerPanel questions={questions} decision={ctx.decision} />}
    </div>
  );
}

function DivergenceCard({
  question,
  subjectLabel,
  onOpenArtifact,
  answer,
}: {
  question: ConsensusDivergence;
  subjectLabel: (artifactId: string) => string;
  onOpenArtifact?: (artifactId: string) => void;
  answer: { optionId: string | null; note: string } | null;
}): React.JSX.Element {
  const chosen = answer?.optionId ?? null;
  return (
    <li className="ensemble-divergence">
      <h5 className="ensemble-divergence-q">{question.question}</h5>
      <ul className="ensemble-divergence-options">
        {question.options.map((option) => (
          <li
            key={option.id}
            className={`ensemble-divergence-option${chosen === option.id ? " chosen" : ""}`}
          >
            <header>
              <span className="ensemble-option-label">{option.label}</span>
              <span className="ensemble-option-votes">
                {option.artifactIds.length} of {question.options.reduce((n, o) => n + o.artifactIds.length, 0)}
              </span>
              {chosen === option.id && <span className="ensemble-recommended-tag">Your answer</span>}
            </header>
            {option.rationale && <p className="ensemble-rationale">{option.rationale}</p>}
            <ul className="ensemble-option-subjects">
              {option.artifactIds.map((artifactId) => (
                <li key={artifactId}>
                  {onOpenArtifact ? (
                    <Tooltip label="Open this attempt's diff and evidence">
                      <button
                        className="btn btn-ghost ensemble-evidence-btn"
                        onClick={() => onOpenArtifact(artifactId)}
                      >
                        {subjectLabel(artifactId)}
                      </button>
                    </Tooltip>
                  ) : (
                    subjectLabel(artifactId)
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {answer && answer.optionId === null && (
        <p className="ensemble-your-answer">
          <strong>Your answer:</strong> {answer.note}
        </p>
      )}
      {answer && answer.optionId !== null && answer.note.trim() !== "" && (
        <p className="ensemble-your-answer">
          <strong>Your note:</strong> {answer.note}
        </p>
      )}
    </li>
  );
}

/** The id used for "none of these - here is my own answer" in the radio group. Never sent. */
const OWN_ANSWER = "";

function DivergenceAnswerPanel({
  questions,
  decision,
}: {
  questions: ConsensusDivergence[];
  decision: NonNullable<EnsembleResultContext["decision"]>;
}): React.JSX.Element {
  // Every question starts on its first option so the form is always completable, and the operator
  // changes the ones they disagree with. Nothing is submitted until they confirm.
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((question) => [question.id, question.options[0]?.id ?? OWN_ANSWER])),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const answers = questions.map((question) => {
    const optionId = picks[question.id] ?? OWN_ANSWER;
    return {
      questionId: question.id,
      optionId: optionId === OWN_ANSWER ? null : optionId,
      note: notes[question.id] ?? "",
    };
  });
  const ownAnswerMissing = answers.some(
    (answer) => answer.optionId === null && answer.note.trim() === "",
  );
  const ready = confirmed && !decision.busy && rationale.trim().length > 0 && !ownAnswerMissing;

  return (
    <form
      className="ensemble-decision"
      aria-label="Answer the open questions"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          decision.onDecide(
            { kind: "answers", answers: answers.map((answer) => ({ ...answer, note: answer.note.trim() })) },
            rationale.trim(),
          );
        }
      }}
    >
      <h4>Answer the open questions</h4>
      <p className="ensemble-decision-intro">
        Nothing is promoted and nothing is reaped: every attempt's snapshot is kept whatever you
        answer. The options are what the attempts actually did - pick one, or write your own.
      </p>
      {questions.length === 0 && (
        <p className="ensemble-muted">
          There is nothing to answer. Confirming completes the run and keeps every snapshot.
        </p>
      )}
      {questions.map((question) => (
        <fieldset key={question.id} className="ensemble-decision-choices">
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <Tooltip
              key={option.id}
              label={`Answer with this position - ${option.artifactIds.length} of the attempts took it`}
            >
              <label className="ensemble-decision-choice">
                <input
                  type="radio"
                  name={`divergence-${question.id}`}
                  checked={(picks[question.id] ?? OWN_ANSWER) === option.id}
                  onChange={() => setPicks((current) => ({ ...current, [question.id]: option.id }))}
                />
                <span>{option.label}</span>
              </label>
            </Tooltip>
          ))}
          <Tooltip label="Answer this question in your own words instead of taking one of the positions">
            <label className="ensemble-decision-choice">
              <input
                type="radio"
                name={`divergence-${question.id}`}
                checked={(picks[question.id] ?? OWN_ANSWER) === OWN_ANSWER}
                onChange={() => setPicks((current) => ({ ...current, [question.id]: OWN_ANSWER }))}
              />
              <span>None of these - my own answer</span>
            </label>
          </Tooltip>
          <label className="ensemble-field">
            <span>
              {(picks[question.id] ?? OWN_ANSWER) === OWN_ANSWER
                ? "Your answer (required)"
                : "Note (optional)"}
            </span>
            <textarea
              value={notes[question.id] ?? ""}
              onChange={(event) =>
                setNotes((current) => ({ ...current, [question.id]: event.target.value }))
              }
              rows={2}
              required={(picks[question.id] ?? OWN_ANSWER) === OWN_ANSWER}
            />
          </label>
        </fieldset>
      ))}
      <label className="ensemble-field">
        <span>Rationale (required, recorded with the decision)</span>
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          rows={2}
          required
        />
      </label>
      <Tooltip label="Confirm you are recording these answers as the run's outcome">
        <label className="ensemble-confirm-line">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>I understand every attempt is retained and none is promoted.</span>
        </label>
      </Tooltip>
      {decision.error && (
        <p className="ensemble-error" role="alert">
          {decision.error}
        </p>
      )}
      <Tooltip label="Record these answers and complete the run">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {decision.pending ? "Recording…" : "Record answers"}
        </button>
      </Tooltip>
    </form>
  );
}
