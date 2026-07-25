import type {
  EnsembleActionBody,
} from "@shared/protocol.ts";
import type { EnsembleArtifact, EnsembleAttempt, EnsembleMember } from "@shared/ensemble.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import type { EnsembleRunDetailResponse } from "./types.ts";
import { memberStatusLabel, memberStatusTone } from "./format.ts";

/**
 * Members, grouped by wave and shown in ordinal order. Each card states the member's identity,
 * launch facts as they were actually resolved, its Task/session link, and - the point the plan
 * insists on - what the member REPORTED separately from what Mission Control OBSERVED, so a
 * reported check never reads as an observed fact.
 */
export function EnsembleMembers({
  detail,
  pending,
  onAction,
  onOpenSession,
}: {
  detail: EnsembleRunDetailResponse;
  pending: string | null;
  onAction: (body: EnsembleActionBody) => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const waves = [...new Set(detail.members.map((m) => m.wave))].sort((a, b) => a - b);
  return (
    <div className="ensemble-members">
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
                  pending={pending}
                  onAction={onAction}
                  onOpenSession={onOpenSession}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function attemptForMember(detail: EnsembleRunDetailResponse, member: EnsembleMember): EnsembleAttempt | null {
  const mine = detail.attempts.filter((a) => a.memberId === member.id);
  if (member.selectedAttemptId) {
    const selected = mine.find((a) => a.id === member.selectedAttemptId);
    if (selected) return selected;
  }
  return mine.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
}

function readyArtifactForMember(
  detail: EnsembleRunDetailResponse,
  member: EnsembleMember,
): EnsembleArtifact | null {
  const attemptIds = new Set(detail.attempts.filter((a) => a.memberId === member.id).map((a) => a.id));
  return (
    detail.artifacts.find((a) => a.attemptId && attemptIds.has(a.attemptId) && a.status === "ready") ??
    null
  );
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
  pending,
  onAction,
  onOpenSession,
}: {
  member: EnsembleMember;
  detail: EnsembleRunDetailResponse;
  pending: string | null;
  onAction: (body: EnsembleActionBody) => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const attempt = attemptForMember(detail, member);
  const artifact = readyArtifactForMember(detail, member);
  const reported = section(artifact?.metadata, "reported");
  const observed = section(artifact?.metadata, "observed");
  const busy = pending !== null;

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

  return (
    <li className={`ensemble-member ensemble-tone-${memberStatusTone(member.status)}`}>
      <div className="ensemble-member-head">
        <span className="ensemble-member-ordinal">#{member.ordinal}</span>
        <span className="ensemble-member-role">{member.roleLabel}</span>
        <span className="ensemble-pill">{memberStatusLabel(member.status)}</span>
        {member.resultLabel && <span className="ensemble-result-label">{member.resultLabel}</span>}
        <span className="ensemble-artifact-spacer" />
        {attempt?.sessionId && onOpenSession && (
          <Tooltip label="Jump to this member's session on the fleet">
            <button className="btn btn-ghost" onClick={() => onOpenSession(attempt.sessionId!)}>
              Open session
            </button>
          </Tooltip>
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
    </li>
  );
}
