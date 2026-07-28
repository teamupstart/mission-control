import { useEffect, useState } from "react";
import type { EnsembleActionBody } from "@shared/protocol.ts";
import {
  ENSEMBLE_LIMITS,
  type EnsembleArtifact,
  type EnsembleAttempt,
  type EnsembleMember,
} from "@shared/ensemble.ts";
import { activePaneDialog } from "@shared/session.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { PaneDialogPrompt } from "../components/PaneDialogPrompt.tsx";
import { ReviewCard } from "../components/ReviewModal.tsx";
import { CostChip, GoalLine } from "../components/session-bits.tsx";
import { relativeTime, stateDisplay } from "../lib/format.ts";
import type { EnsembleRunDetailResponse } from "./types.ts";
import {
  artifactStatusLabel,
  fmtElapsed,
  memberStatusLabel,
  memberStatusTone,
  titleCaseEnum,
} from "./format.ts";

export interface EnsembleMemberLiveLane {
  session: Session;
  reviews: ReviewItem[];
  gateNeedsYou: boolean;
}

const EMPTY_LIVE_LANES: ReadonlyMap<string, EnsembleMemberLiveLane> = new Map();

/**
 * Members, grouped by wave and shown in ordinal order. Each card states the member's identity,
 * launch facts as they were actually resolved, its Task/session link, and - the point the plan
 * insists on - what the member REPORTED separately from what Mission Control OBSERVED, so a
 * reported check never reads as an observed fact.
 */
export function EnsembleMembers({
  detail,
  liveByMemberId = EMPTY_LIVE_LANES,
  pending,
  onAction,
  onOpenSession,
  onOpenTask,
  onManualSubmit,
}: {
  detail: EnsembleRunDetailResponse;
  liveByMemberId?: ReadonlyMap<string, EnsembleMemberLiveLane>;
  pending: string | null;
  onAction: (body: EnsembleActionBody) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onManualSubmit?: (
    memberId: string,
    result: { summary: string; checks?: string[]; testEvidence?: string | null },
  ) => Promise<string | null>;
}): React.JSX.Element {
  const waves = [...new Set(detail.members.map((m) => m.wave))].sort((a, b) => a - b);
  const attemptsPartial = detail.pagination.attemptsReturned < detail.pagination.attemptsTotal;
  return (
    <div className="ensemble-members">
      {attemptsPartial && (
        <p className="ensemble-warn" role="note">
          Showing {detail.pagination.attemptsReturned} of {detail.pagination.attemptsTotal} attempts.
          Member histories and current-session links may be incomplete.
        </p>
      )}
      {waves.map((wave) => {
        const members = detail.members
          .filter((m) => m.wave === wave)
          .sort((a, b) => a.ordinal - b.ordinal);
        return (
          <div key={wave} className="ensemble-wave">
            {waves.length > 1 && <h5 className="ensemble-wave-head">Wave {wave}</h5>}
            <ul className="ensemble-member-list">
              {members.map((member) => (
                <MemberCard
                  key={member.id}
                  member={member}
                  detail={detail}
                  live={liveByMemberId.get(member.id) ?? null}
                  attemptsPartial={attemptsPartial}
                  pending={pending}
                  onAction={onAction}
                  onOpenSession={onOpenSession}
                  onOpenTask={onOpenTask}
                  onManualSubmit={onManualSubmit}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function attemptsForMember(
  detail: EnsembleRunDetailResponse,
  member: EnsembleMember,
): EnsembleAttempt[] {
  return detail.attempts
    .filter((attempt) => attempt.memberId === member.id)
    .sort((a, b) => b.attempt - a.attempt);
}

function currentAttemptForMember(
  attempts: EnsembleAttempt[],
  member: EnsembleMember,
  attemptsPartial: boolean,
): { attempt: EnsembleAttempt | null; unavailable: boolean } {
  if (member.selectedAttemptId) {
    const selected = attempts.find((attempt) => attempt.id === member.selectedAttemptId);
    return { attempt: selected ?? null, unavailable: selected === undefined };
  }
  if (member.taskId) {
    const current = attempts.find((attempt) => attempt.taskId === member.taskId);
    if (current) return { attempt: current, unavailable: false };
    if (attemptsPartial) return { attempt: null, unavailable: true };
  }
  return { attempt: attempts[0] ?? null, unavailable: false };
}

function artifactsForMember(
  detail: EnsembleRunDetailResponse,
  attempts: EnsembleAttempt[],
  member: EnsembleMember,
): EnsembleArtifact[] {
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  if (member.selectedAttemptId) attemptIds.add(member.selectedAttemptId);
  return detail.artifacts
    .filter((artifact) => artifact.attemptId && attemptIds.has(artifact.attemptId))
    .sort((a, b) => b.createdAt - a.createdAt || b.attempt - a.attempt);
}

function section(metadata: unknown, key: string): Record<string, unknown> | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}

function MemberCard({
  member,
  detail,
  live,
  attemptsPartial,
  pending,
  onAction,
  onOpenSession,
  onOpenTask,
  onManualSubmit,
}: {
  member: EnsembleMember;
  detail: EnsembleRunDetailResponse;
  live: EnsembleMemberLiveLane | null;
  attemptsPartial: boolean;
  pending: string | null;
  onAction: (body: EnsembleActionBody) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onManualSubmit?: (
    memberId: string,
    result: { summary: string; checks?: string[]; testEvidence?: string | null },
  ) => Promise<string | null>;
}): React.JSX.Element {
  const attempts = attemptsForMember(detail, member);
  const current = currentAttemptForMember(attempts, member, attemptsPartial);
  const attempt = current.attempt;
  const artifacts = artifactsForMember(detail, attempts, member);
  const evidenceAttemptId = member.selectedAttemptId ?? attempt?.id ?? null;
  const artifact =
    artifacts.find(
      (candidate) =>
        candidate.status === "ready" && candidate.attemptId === evidenceAttemptId,
    ) ??
    (!current.unavailable
      ? artifacts.find((candidate) => candidate.status === "ready")
      : undefined) ??
    null;
  const attemptById = new Map(attempts.map((candidate) => [candidate.id, candidate]));
  const reported = section(artifact?.metadata, "reported");
  const observed = section(artifact?.metadata, "observed");
  const busy = pending !== null;
  const session = live?.session ?? null;
  const sessionState = session ? stateDisplay(session, live?.gateNeedsYou ?? false) : null;
  const dialog = session ? activePaneDialog(session) : null;

  const facts = [
    attempt?.agent,
    attempt?.observedModel ?? attempt?.requestedModel,
    attempt?.requestedEffort,
  ].filter(Boolean);

  const active = member.status
    ? ["pending", "launching", "active", "submitted", "reviewing"].includes(member.status)
    : false;
  const retryable = member.status === "failed";

  const reportedChecks = Array.isArray(reported?.checks)
    ? (reported!.checks as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const openSessionId = session?.id ?? attempt?.sessionId ?? null;

  return (
    <li
      className={`ensemble-member${session ? " ensemble-member-lane" : ""} ensemble-tone-${memberStatusTone(member.status)}`}
    >
      <div className="ensemble-member-head">
        {sessionState && (
          <Tooltip label={`Session ${sessionState.label}`}>
            <span
              className={`ensemble-lane-tone ensemble-lane-tone-${sessionState.tone}`}
              aria-label={`Session ${sessionState.label}`}
              tabIndex={0}
            />
          </Tooltip>
        )}
        <span className="ensemble-member-ordinal">#{member.ordinal}</span>
        <span className="ensemble-member-role">{member.roleLabel}</span>
        <span className="ensemble-pill">{memberStatusLabel(member.status)}</span>
        {sessionState && <span className="ensemble-lane-state">{sessionState.label}</span>}
        {member.resultLabel && <span className="ensemble-result-label">{member.resultLabel}</span>}
        <span className="ensemble-artifact-spacer" />
        {openSessionId && onOpenSession && (
          <Tooltip label="Jump to this member's session on the fleet">
            <button className="btn btn-ghost" onClick={() => onOpenSession(openSessionId)}>
              Open session
            </button>
          </Tooltip>
        )}
        {member.taskId && onOpenTask && (
          <Tooltip label="Open this member's Task">
            <button className="btn btn-ghost" onClick={() => onOpenTask(member.taskId!)}>
              Open task
            </button>
          </Tooltip>
        )}
        {member.status === "active" && !artifact && !current.unavailable && onManualSubmit && (
          <ManualSubmit memberId={member.id} disabled={busy} onSubmit={onManualSubmit} />
        )}
        {active && (
          <Tooltip label="Withdraw this member after cancelling its task">
            <button
              className="btn btn-ghost danger"
              disabled={busy}
              onClick={() => onAction({ kind: "withdraw_member", memberId: member.id })}
            >
              {pending === "withdraw_member" ? "Withdrawing…" : "Withdraw"}
            </button>
          </Tooltip>
        )}
        {retryable && (
          <Tooltip label="Relaunch this failed member">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => onAction({ kind: "retry_member", memberId: member.id })}
            >
              {pending === "retry_member" ? "Retrying…" : "Retry"}
            </button>
          </Tooltip>
        )}
      </div>
      {facts.length > 0 && <p className="ensemble-member-facts">{facts.join(" · ")}</p>}
      {session && (
        <div className="ensemble-lane-live">
          <div className="ensemble-lane-activity">
            <span>{session.activity ?? sessionState?.label ?? "No activity reported"}</span>
            <LiveLaneClock session={session} />
            <CostChip cost={session.cost} />
          </div>
          <GoalLine session={session} />
        </div>
      )}
      {current.unavailable && (
        <p className="ensemble-warn" role="note">
          {attemptsPartial
            ? "The current attempt is beyond the returned history window."
            : "The current attempt is unavailable."}
        </p>
      )}
      {session ? (
        <details className="ensemble-lane-history" open={member.status === "failed"}>
          <Tooltip label="Show or hide this member's recorded attempts and artifacts">
            <summary>Attempt &amp; artifact history</summary>
          </Tooltip>
          <DurableState
            attempts={attempts}
            artifacts={artifacts}
            attemptById={attemptById}
            selectedAttemptId={member.selectedAttemptId}
          />
        </details>
      ) : (
        <DurableState
          attempts={attempts}
          artifacts={artifacts}
          attemptById={attemptById}
          selectedAttemptId={member.selectedAttemptId}
        />
      )}
      {member.error && (
        <p className="ensemble-error" role="alert">
          {member.error}
        </p>
      )}
      {(reported || observed) && (
        <div className="ensemble-evidence-split">
          <div className="ensemble-reported">
            <h6>Reported by member</h6>
            {typeof reported?.summary === "string" && reported.summary ? (
              <p>{reported.summary}</p>
            ) : (
              <p className="ensemble-muted">No summary.</p>
            )}
            {reportedChecks.length > 0 && (
              <ul className="ensemble-checks">
                {reportedChecks.map((check, i) => (
                  <li key={i}>{check}</li>
                ))}
              </ul>
            )}
            <p className="ensemble-claim-note">Claims, not verified by Mission Control.</p>
          </div>
          <div className="ensemble-observed">
            <h6>Observed by Mission Control</h6>
            {observed ? (
              <p>
                {String(observed.filesChanged ?? 0)} files · +{String(observed.insertions ?? 0)} / -
                {String(observed.deletions ?? 0)}
              </p>
            ) : (
              <p className="ensemble-muted">No snapshot observed yet.</p>
            )}
          </div>
        </div>
      )}
      {session && ((live?.reviews.length ?? 0) > 0 || dialog) && (
        <div className="ensemble-lane-asks">
          <h6>Candidate {member.ordinal} asks</h6>
          <div className="ensemble-lane-protocols">
            {live?.reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
            {dialog && <PaneDialogPrompt sessionId={session.id} dialog={dialog} />}
          </div>
        </div>
      )}
    </li>
  );
}

function LiveLaneClock({ session }: { session: Session }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <span className="ensemble-muted">
        elapsed {fmtElapsed(session.startedAt ?? session.firstSeen, now)}
      </span>
      <span className="ensemble-muted">
        {session.lastActivity
          ? `last event ${relativeTime(session.lastActivity, now)}`
          : "no session events reported"}
      </span>
    </>
  );
}

function DurableState({
  attempts,
  artifacts,
  attemptById,
  selectedAttemptId,
}: {
  attempts: EnsembleAttempt[];
  artifacts: EnsembleArtifact[];
  attemptById: Map<string, EnsembleAttempt>;
  selectedAttemptId: string | null;
}): React.JSX.Element {
  return (
    <div className="ensemble-member-durable-state">
      <div>
        <h6>Attempt state</h6>
        {attempts.length > 0 ? (
          <ul className="ensemble-member-history">
            {attempts.map((candidate) => (
              <li key={candidate.id}>
                <span>
                  Attempt #{candidate.attempt}
                  {candidate.id === selectedAttemptId ? " · selected" : ""}
                </span>
                <span className={`ensemble-pill ensemble-pill-${candidate.status ?? "unknown"}`}>
                  {candidate.status ? titleCaseEnum(candidate.status) : "Unknown"}
                </span>
                {candidate.error && <span className="ensemble-stage-error">{candidate.error}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ensemble-muted">No attempts yet.</p>
        )}
      </div>
      <div>
        <h6>Artifact state</h6>
        {artifacts.length > 0 ? (
          <ul className="ensemble-member-history">
            {artifacts.map((candidate) => {
              const owner = candidate.attemptId
                ? attemptById.get(candidate.attemptId)
                : undefined;
              return (
                <li key={candidate.id}>
                  <span>
                    Attempt #{owner?.attempt ?? "?"} · {candidate.kind ?? "unknown"} capture #
                    {candidate.attempt}
                  </span>
                  <span className={`ensemble-pill ensemble-pill-${candidate.status ?? "unknown"}`}>
                    {artifactStatusLabel(candidate.status)}
                  </span>
                  {candidate.error && <span className="ensemble-stage-error">{candidate.error}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="ensemble-muted">No artifact captures yet.</p>
        )}
      </div>
    </div>
  );
}

export function validateManualChecks(value: string): {
  checks: string[];
  error: string | null;
} {
  const checks = value
    .split("\n")
    .map((check) => check.trim())
    .filter(Boolean);
  const error =
    checks.length > ENSEMBLE_LIMITS.submissionChecks
      ? `Use at most ${ENSEMBLE_LIMITS.submissionChecks} checks.`
      : checks.some((check) => check.length > ENSEMBLE_LIMITS.submissionCheck)
        ? `Each check must be at most ${ENSEMBLE_LIMITS.submissionCheck} characters.`
        : null;
  return { checks, error };
}

function ManualSubmit({
  memberId,
  disabled,
  onSubmit,
}: {
  memberId: string;
  disabled: boolean;
  onSubmit: (
    memberId: string,
    result: { summary: string; checks?: string[]; testEvidence?: string | null },
  ) => Promise<string | null>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [checks, setChecks] = useState("");
  const [testEvidence, setTestEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { checks: normalizedChecks, error: checksIssue } = validateManualChecks(checks);
  const canSubmit = Boolean(summary.trim()) && checksIssue === null && !disabled;

  if (!open) {
    return (
      <Tooltip label="Manually capture this member's current work and submit its reported claims">
        <button className="btn btn-ghost" disabled={disabled} onClick={() => setOpen(true)}>
          Submit result…
        </button>
      </Tooltip>
    );
  }

  const submit = async (): Promise<void> => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    const issue = await onSubmit(memberId, {
      summary: summary.trim(),
      checks: normalizedChecks,
      testEvidence: testEvidence || null,
    });
    setSubmitting(false);
    if (issue) {
      setError(issue);
      return;
    }
    setOpen(false);
    setSummary("");
    setChecks("");
    setTestEvidence("");
  };

  return (
    <form
      className="ensemble-manual-submit"
      aria-label="Manually submit member result"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Tooltip label="Required summary reported by the member">
        <label className="ensemble-field">
          <span>Summary (required)</span>
          <textarea
            value={summary}
            maxLength={ENSEMBLE_LIMITS.submissionSummary}
            rows={2}
            required
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
      </Tooltip>
      <Tooltip label="Optional checks, one reported command or check per line">
        <label className="ensemble-field">
          <span>Checks (optional, one per line)</span>
          <textarea
            value={checks}
            rows={2}
            aria-invalid={checksIssue !== null}
            onChange={(event) => setChecks(event.target.value)}
          />
        </label>
      </Tooltip>
      <Tooltip label="Optional test output reported by the member">
        <label className="ensemble-field">
          <span>Test evidence (optional)</span>
          <textarea
            value={testEvidence}
            maxLength={ENSEMBLE_LIMITS.submissionTestEvidence}
            rows={2}
            onChange={(event) => setTestEvidence(event.target.value)}
          />
        </label>
      </Tooltip>
      {checksIssue && <p className="ensemble-error" role="alert">{checksIssue}</p>}
      {error && <p className="ensemble-error" role="alert">{error}</p>}
      <div className="ensemble-action-row" aria-live="polite">
        <Tooltip label="Capture the member worktree and submit these claims">
          <button className="btn btn-primary" type="submit" disabled={submitting || !canSubmit}>
            {submitting ? "Submitting…" : "Submit result"}
          </button>
        </Tooltip>
        <Tooltip label="Close the manual submission form without submitting">
          <button className="btn btn-ghost" type="button" disabled={submitting} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </Tooltip>
      </div>
    </form>
  );
}
