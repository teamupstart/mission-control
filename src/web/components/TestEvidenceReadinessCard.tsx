import type {
  TestEvidenceAuditAggregate,
  TestEvidenceAuditRate,
  TestEvidenceAuditSlice,
  TestEvidenceRequestCategory,
} from "@shared/workflow.ts";
import { ConsoleCard, ConsoleState } from "./settings-console.tsx";

// What the built-in Test Evidence Auditor's own telemetry says, as a card an operator can
// read without running an agent.
//
// The scout report behind this (`docs/reports/test-evidence-auditor-rejections/report.html`)
// ends in a rollout criterion - "if first-pass failures remain above 30%, add the readiness
// gate", "at most 1.5 auditor attempts per run" - and the event that criterion is written in
// was appended and never read. A number nobody can see is not a measurement; it is a row in
// a table. This card is the reading, and it is deliberately the WHOLE reading rather than a
// single headline percentage, because every one of those targets has a different denominator
// and a panel that showed one rate would invite the other four to be guessed from it.
//
// It is on the Workflows settings category and not on the Runs page for the reason the
// health strip beside it is: this is a fleet-wide scalar over every run, and `WorkflowRuns`
// is a list of individual runs with per-run detail. A cross-run rate rendered inside a
// single run's reader would be a number that does not describe the thing it sits inside.
//
// Advisory only. It reads events; it re-runs nothing, re-judges nothing, and rewrites no
// Persona verdict. Nothing an operator does here can change what a Persona decided.

/** The report's own targets, restated where the numbers they judge are drawn. */
export const TEST_EVIDENCE_TARGETS = {
  /** At least this share of first submissions accepted. */
  firstPassAcceptance: 0.7,
  /** At most this many auditor attempts per run. */
  attemptsPerRun: 1.5,
} as const;

/**
 * A share as a sentence, with "no reading" kept distinct from zero.
 *
 * A rate of null means the population was empty, and rendering that as "0%" is the one
 * mistake this card cannot make: an install that has never run the auditor would read as one
 * whose first-pass acceptance is zero, which is the opposite conclusion. The raw counts ride
 * along because a percentage over three attempts and one over three hundred are different
 * claims and only one of them is worth acting on.
 */
export function formatAuditRate(value: TestEvidenceAuditRate, noun: string): string {
  if (value.rate === null) return `no reading - no ${noun} recorded`;
  return `${Math.round(value.rate * 100)}% (${value.count} of ${value.total} ${noun})`;
}

/** How a targeted number compares to the report's target, or null when there is no reading. */
export function meetsTarget(
  value: number | null,
  target: number,
  direction: "at_least" | "at_most",
): boolean | null {
  if (value === null) return null;
  return direction === "at_least" ? value >= target : value <= target;
}

/** The tone a target comparison earns. Unknown is never drawn as met. */
function targetTone(met: boolean | null): "ok" | "attention" | "unknown" {
  return met === null ? "unknown" : met ? "ok" : "attention";
}

const CATEGORY_LABELS: Record<TestEvidenceRequestCategory, string> = {
  visual_artifact: "No reviewer-visible UI artifact",
  focused_execution: "No completed focused execution output",
  downstream_proof: "Asked for later-stage proof",
  other: "Other",
};

/**
 * One slice's identity as a label.
 *
 * The digest is truncated again for display - the full twelve characters are for telling two
 * revisions apart in an export, and eight is enough to do it by eye. A slice from before the
 * identity fields existed says so rather than being drawn as version 0 or an empty string.
 */
export function sliceLabel(slice: TestEvidenceAuditSlice): string {
  if (slice.workflowVersion === null && slice.guidanceDigest === null) {
    return "Before guidance identity was recorded";
  }
  const version = slice.workflowVersion === null ? "unknown version" : `v${slice.workflowVersion}`;
  const digest = slice.guidanceDigest === null
    ? "unknown guidance"
    : `guidance ${slice.guidanceDigest.slice(0, 8)}`;
  return `${version} · ${digest}`;
}

/**
 * A slice's identity as a stable React key.
 *
 * Every field the aggregate groups by, so two rows can never collide: the label alone is not
 * an identity, since it deliberately omits the persona and shows a truncated digest.
 */
export function sliceIdentity(slice: TestEvidenceAuditSlice): string {
  return [
    slice.workflowId ?? "?",
    slice.workflowVersion ?? "?",
    slice.personaId ?? "?",
    slice.guidanceDigest ?? "?",
  ].join(":");
}

/**
 * One captioned block of readings.
 *
 * The caption is a real `<h4>` and the group is named BY it rather than beside it: three
 * unlabelled blocks of rows made a reader work out from the row wording which population each
 * block was over, and an `aria-label` duplicating a visible caption is announced twice. The
 * ids are fixed because this card renders once on the page.
 */
function Group({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="wf-settings-readout" role="group" aria-labelledby={id}>
      <h4 className="wf-evidence-caption" id={id}>{title}</h4>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <p className="sc-health-row">
      <span>{label}</span>
      <span className="sc-health-value">{value}</span>
    </p>
  );
}

export function TestEvidenceReadinessCard({
  aggregate,
}: {
  /** Null while the daemon has not answered, which is stated rather than drawn as zeros. */
  aggregate: TestEvidenceAuditAggregate | null;
}): React.JSX.Element {
  const acceptance = aggregate?.firstSubmissionAccepted.rate ?? null;
  const perRun = aggregate?.attemptsPerRun ?? null;
  const acceptanceMet = meetsTarget(
    acceptance,
    TEST_EVIDENCE_TARGETS.firstPassAcceptance,
    "at_least",
  );
  const perRunMet = meetsTarget(perRun, TEST_EVIDENCE_TARGETS.attemptsPerRun, "at_most");
  return (
    <ConsoleCard title="Test evidence readiness" anchor="workflows/test-evidence">
      <p className="settings-hint">
        What the built-in Test Evidence Auditor has actually done, from the bounded telemetry
        each of its attempts appends. Counts and rates only - no prompt, diff, transcript,
        Persona guidance, verdict text or session content passes through here. Reading this
        changes nothing: it never re-runs a Persona or rewrites a verdict.
      </p>

      {!aggregate ? (
        <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
      ) : aggregate.attempts === 0 && aggregate.malformed === 0 ? (
        <ConsoleState tone="off">
          No Test Evidence Auditor attempt has been recorded yet
        </ConsoleState>
      ) : aggregate.attempts === 0 ? (
        /* Events exist and NONE of them could be read back. The empty state above is wrong
           here in the way that matters: it reports an auditor nobody has run, when what is
           actually true is that every recorded attempt is unreadable - a corrupted or
           unrecognisable payload, which is a thing to investigate rather than a quiet
           nothing. Reserving "no attempt recorded" for zero valid AND zero malformed rows is
           the same rule the rates follow, that an absence of readings must never be dressed
           up as a reading. */
        <>
          <ConsoleState tone="attention">
            No Test Evidence Auditor attempt could be read back
          </ConsoleState>
          <p className="settings-warn">
            {aggregate.malformed} recorded {aggregate.malformed === 1 ? "attempt" : "attempts"}
            {" "}could not be read back, so no rate can be computed. This is a malformed or
            unrecognised telemetry payload, not an auditor that has never run.
          </p>
        </>
      ) : (
        <>
          <ConsoleState tone={targetTone(acceptanceMet)}>
            {`First-pass acceptance ${formatAuditRate(
              aggregate.firstSubmissionAccepted,
              "first submissions",
            )} · target at least 70%`}
          </ConsoleState>

          <Group id="wf-evidence-attempts" title="Attempts">
            <Row
              label="Attempts that failed"
              value={formatAuditRate(aggregate.attemptFailures, "attempts")}
            />
            <Row
              label="Auditor attempts per run"
              value={perRun === null
                ? "no reading"
                : `${perRun.toFixed(2)} across ${aggregate.runs} `
                  + `${aggregate.runs === 1 ? "run" : "runs"}`
                  + ` · target at most 1.5${perRunMet ? "" : " · over target"}`}
            />
            <Row
              label="Possible later-stage overreach"
              value={formatAuditRate(aggregate.possibleOverreach, "attempts")}
            />
          </Group>

          <Group id="wf-evidence-reasons" title="Why attempts were refused">
            {aggregate.rejectionCategories.map((entry) => (
              <Row
                key={entry.category}
                label={CATEGORY_LABELS[entry.category]}
                value={formatAuditRate(entry.failures, "failing attempts")}
              />
            ))}
          </Group>

          <Group id="wf-evidence-readiness" title="Evidence readiness on first submissions">
            <Row
              label="First submissions with no image"
              value={formatAuditRate(aggregate.readiness.withoutImages, "first submissions")}
            />
            <Row
              label="First submissions with no text artifact"
              value={formatAuditRate(
                aggregate.readiness.withoutTextArtifacts,
                "first submissions",
              )}
            />
            <Row
              label="First submissions with no upstream Check"
              value={formatAuditRate(aggregate.readiness.withoutChecks, "first submissions")}
            />
            <Row
              label="First submissions with a truncated transcript"
              value={formatAuditRate(aggregate.readiness.transcriptTruncated, "first submissions")}
            />
            <Row
              label="Bytes dropped from first-submission evidence"
              value={`${aggregate.readiness.checkOmittedBytes} from Checks, `
                + `${aggregate.readiness.transcriptOmittedHeadBytes} from transcript heads`}
            />
          </Group>

          {aggregate.slices.length > 1 && (
            <Group id="wf-evidence-slices" title="By guidance revision">
              {/* The before/after comparison the rollout criterion asks for. Drawn only when
                  there is something to compare: one slice is the same number as the headline
                  above it, restated in smaller type. */}
              {aggregate.slices.map((slice) => (
                <Row
                  key={sliceIdentity(slice)}
                  label={sliceLabel(slice)}
                  value={`${slice.attempts} attempts · first pass `
                    + formatAuditRate(slice.firstSubmissionAccepted, "first submissions")}
                />
              ))}
            </Group>
          )}

          {/* Both of these are said out loud rather than left to be inferred from a rate that
              looks complete. A capped window and an unreadable row each mean the numbers
              above describe less than the operator thinks they do. */}
          {aggregate.truncated && (
            <p className="settings-hint">
              Older attempts are outside this window: only the newest {aggregate.scanLimit}{" "}
              are counted.
            </p>
          )}
          {aggregate.malformed > 0 && (
            <p className="settings-warn">
              {aggregate.malformed} recorded {aggregate.malformed === 1 ? "attempt" : "attempts"}
              {" "}could not be read back and {aggregate.malformed === 1 ? "is" : "are"} excluded
              from every rate above.
            </p>
          )}
          {aggregate.slicesOmitted > 0 && (
            <p className="settings-hint">
              {aggregate.slicesOmitted} further guidance revisions are not listed.
            </p>
          )}
        </>
      )}
    </ConsoleCard>
  );
}
