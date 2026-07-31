import { createHash } from "node:crypto";
import { PersonaVerdictSchema, WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import { WORKFLOW_LIMITS, isVerdictNode, verdictAuthor } from "@shared/workflow.ts";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowNodeAttempt,
  WorkflowRun,
  WorkflowSubmission,
  WorkflowVersion,
} from "@shared/workflow.ts";
import type { InspectorComment } from "@shared/types.ts";
import type { InspectorPosture } from "@shared/inspector.ts";
import type { InspectorFindingsPolicy } from "@shared/workflow.ts";

const TRUNCATION_NOTICE = "\n\n[Workflow repair packet truncated deterministically.]";
/**
 * How every repair packet ends.
 *
 * It used to close with "and signal completion normally", which was an instruction the loop
 * could not honour: the signal it asked for is refused for every binding whose trigger mode
 * is not `foreman_complete`, so the agent obeyed and the round was thrown away. Resumption
 * is now the ENGINE's job (see `WORKFLOW_RESUMPTION_POLICIES`), which observes the session
 * rather than listening for a claim - so the packet asks for the work and nothing else. Do
 * not put the signal back: an instruction whose effect depends on a binding setting the
 * model cannot see is one it will follow into silence.
 */
const FINAL_INSTRUCTION =
  "Preserve the user's explicit intent. Make only changes supported by this packet, then verify the work.";
const encoder = new TextEncoder();

export interface RenderedWorkflowFeedback {
  payload: string;
  payloadSha256: string;
  failedPersonaCount: number;
  truncated: boolean;
}

export interface WorkflowFeedbackInput {
  workflowName: string;
  version: WorkflowVersion;
  run: WorkflowRun;
  submission: WorkflowSubmission;
  attempts: WorkflowNodeAttempt[];
}

export interface InspectorFeedbackInput {
  workflowName: string;
  workflowVersion: number;
  runId: string;
  submissionRound: number;
  originalGoal: string;
  prUrl: string;
  targetHeadSha: string;
  inspectorRound: number;
  reviewPosture: InspectorPosture | null;
  policy: InspectorFindingsPolicy;
  findings: InspectorComment[];
}

export interface PrHandoffInput {
  workflowName: string;
  workflowVersion: number;
  runId: string;
  originalGoal: string;
  skillCommand: string;
}

export interface UnchangedEvidenceNudgeInput {
  workflowName: string;
  workflowVersion: number;
  runId: string;
  /** The refused round, so the packet names the same number the run detail shows. */
  round: number;
  originalGoal: string;
  /** The fingerprint that matched, shown short - it is an identifier here, not a value to act on. */
  evidenceFingerprint: string;
  /** The packet this session already received and did not act on, or null if it was pruned. */
  priorPacket: string | null;
  /** Which nudge this is, and how many there are. Stated so the bound is not a surprise. */
  nudge: number;
  nudgeLimit: number;
}

/** Remove bytes that a terminal could interpret as controls while retaining plain line breaks. */
export function sanitizeWorkflowFeedback(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function clipUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const clean = sanitizeWorkflowFeedback(value);
  if (encoder.encode(clean).byteLength <= maxBytes) return { value: clean, truncated: false };
  let bytes = 0;
  let output = "";
  for (const scalar of clean) {
    const size = encoder.encode(scalar).byteLength;
    if (bytes + size > maxBytes) break;
    output += scalar;
    bytes += size;
  }
  return { value: output, truncated: true };
}

function field(value: string): { value: string; truncated: boolean } {
  return clipUtf8(value, WORKFLOW_LIMITS.feedbackFieldBytes);
}

function evidenceLine(reference: EvidenceRef): string {
  const location = reference.path
    ? ` (${reference.path}${reference.line ? `:${reference.line}` : ""})`
    : reference.line
      ? ` (line ${reference.line})`
      : "";
  return `[${reference.kind}] ${reference.quote}${location}`;
}

function latestAttempts(attempts: WorkflowNodeAttempt[]): Map<string, WorkflowNodeAttempt> {
  const latest = new Map<string, WorkflowNodeAttempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.nodeId);
    if (!current || attempt.attempt > current.attempt) latest.set(attempt.nodeId, attempt);
  }
  return latest;
}

function finalizePacket(body: string, truncated: boolean, finalInstruction: string): {
  payload: string;
  payloadSha256: string;
  truncated: boolean;
} {
  const cleanBody = sanitizeWorkflowFeedback(body).replace(/\s+$/u, "");
  let payload = `${cleanBody}\n\n${finalInstruction}`;
  if (encoder.encode(payload).byteLength > WORKFLOW_LIMITS.feedbackPayloadBytes) truncated = true;
  if (truncated) {
    const suffix = `\n\n${finalInstruction}${TRUNCATION_NOTICE}`;
    const budget = WORKFLOW_LIMITS.feedbackPayloadBytes - encoder.encode(suffix).byteLength;
    payload = clipUtf8(cleanBody, Math.max(0, budget)).value.replace(/\s+$/u, "") + suffix;
  }
  return {
    payload,
    payloadSha256: createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex"),
    truncated,
  };
}

/** Render one immutable verdict-failure packet. Verdict output supplies facts, never structure. */
export function renderWorkflowFeedback(input: WorkflowFeedbackInput): RenderedWorkflowFeedback {
  const context = WorkflowContextSnapshotSchema.parse(input.submission.context);
  const byNode = latestAttempts(input.attempts);
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const blocks: string[] = [];

  for (const node of input.version.graph.nodes) {
    if (!isVerdictNode(node)) continue;
    const attempt = byNode.get(node.id);
    const parsed = PersonaVerdictSchema.safeParse(attempt?.verdict);
    if (!parsed.success || parsed.data.verdict !== "fail") continue;
    const verdict: Extract<PersonaVerdict, { verdict: "fail" }> = parsed.data;
    const lines = [
      `## ${bounded(verdictAuthor(node))}`,
      bounded(verdict.summary),
      "",
      "Requested changes:",
    ];
    verdict.requestedChanges.forEach((change, index) => {
      lines.push(`${index + 1}. ${bounded(change.title)}`);
      lines.push(`   Why: ${bounded(change.rationale)}`);
      for (const reference of change.evidence) {
        lines.push(`   Evidence: ${bounded(evidenceLine(reference))}`);
      }
    });
    blocks.push(lines.join("\n"));
  }

  const fingerprint = sanitizeWorkflowFeedback(input.submission.evidenceFingerprint).slice(0, 16);
  const bodyParts = [
    "Workflow review failed. This is a repair round; address the review packet below.",
    "",
    "Original user goal:",
    bounded(context.primaryGoal.rawPrompt),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.version.version}`,
    `Run: ${input.run.id}`,
    `Repair round: ${input.submission.round}`,
    `Evidence: ${fingerprint}`,
    "",
    ...blocks.flatMap((block, index) => index === 0 ? [block] : ["", block]),
  ];
  return {
    ...finalizePacket(bodyParts.join("\n"), truncated, FINAL_INSTRUCTION),
    failedPersonaCount: blocks.length,
  };
}

const INSPECTOR_SEVERITY: Record<InspectorComment["severity"], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** Render one frozen Inspector finding snapshot without reusing model prose as framing. */
export function renderInspectorFeedback(input: InspectorFeedbackInput): RenderedWorkflowFeedback {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const unique = new Map<string, InspectorComment>();
  for (const finding of input.findings) {
    const prior = unique.get(finding.fingerprint);
    if (!prior) {
      unique.set(finding.fingerprint, finding);
      continue;
    }
    // A unique DB index normally makes this branch unreachable. Keeping the renderer
    // deterministic for a duplicated snapshot prevents caller order from changing the
    // frozen packet if a joined or legacy input ever contains the same issue twice.
    const stableFinding = (row: InspectorComment): string => JSON.stringify([
      row.path,
      row.line,
      row.title,
      row.body,
      row.severity,
      row.id,
    ]);
    if (stableFinding(finding) < stableFinding(prior)) {
      unique.set(finding.fingerprint, finding);
    }
  }
  const findings = [...unique.values()].sort((a, b) =>
    INSPECTOR_SEVERITY[a.severity] - INSPECTOR_SEVERITY[b.severity]
    || (a.path ?? "").localeCompare(b.path ?? "")
    || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
    || a.fingerprint.localeCompare(b.fingerprint));
  const policyInstruction = input.policy === "restart_workflow"
    // `restart_workflow` no longer asks for a signal, for `FINAL_INSTRUCTION`'s reason. The
    // `inspector_only` arm below still ends in "wait for Inspector to review that new head",
    // which remains literally true: that policy is resolved by the Inspector poller observing
    // a pushed head, not by anything the session reports.
    ? "Fix the findings, verify the work, then commit and push it."
    : "This published policy permits bypassing Personas only for this Inspector repair. Fix the findings, verify the work, commit and push a new head, then wait for Inspector to review that new head.";
  const body = [
    "Inspector reviewed the pinned pull request head and found changes that are required.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
    `PR: ${bounded(input.prUrl)}`,
    `Pinned head: ${bounded(input.targetHeadSha)}`,
    `Inspector round: ${input.inspectorRound}`,
    `Review posture: ${input.reviewPosture ?? "unknown"}`,
    "",
    ...findings.flatMap((finding, index) => {
      const location = finding.path
        ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
        : "general";
      return [
        ...(index === 0 ? [] : [""]),
        `## ${finding.severity.toUpperCase()} - ${bounded(finding.title)}`,
        `Location: ${bounded(location)}`,
        bounded(
          finding.body
            ?? "Legacy finding detail is unavailable. Use the severity, title, and location above.",
        ),
        `Fingerprint: ${finding.fingerprint}`,
      ];
    }),
  ].join("\n");
  return {
    ...finalizePacket(body, truncated, policyInstruction),
    failedPersonaCount: findings.length,
  };
}

/**
 * Render the answer to a completion signal that changed nothing.
 *
 * This packet exists because the alternative is a permanently dead loop. The completion guard
 * is retired inside the claim transaction, BEFORE capture runs, so a capture that then refuses
 * for unchanged evidence leaves a spent guard and a parked run that no later signal can move.
 * Re-arming the guard on refusal instead would be a hot loop - one Foreman tick plus the settle
 * is about fourteen seconds, and each pass spends a real context-compaction call against a
 * session that is not changing. A packet costs one write, lands in the session, and lets the
 * ordinary confirmed-delivery re-arm supply the next legitimate claim.
 *
 * It states the bound (`nudge N of M`) rather than hiding it. An agent that knows it has one
 * more chance to explain itself behaves differently from one that thinks it has unlimited ones,
 * and the run really does block after the limit.
 */
export function renderUnchangedEvidenceNudge(
  input: UnchangedEvidenceNudgeInput,
): RenderedWorkflowFeedback {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const fingerprint = sanitizeWorkflowFeedback(input.evidenceFingerprint).slice(0, 16);
  const body = [
    "This work was reported complete, but nothing changed since the last review round.",
    "",
    `The evidence snapshot is byte-identical to the round that asked for changes (${fingerprint}).`,
    "No commit, no working-tree edit, no new file. Reviewing the same bytes again would return",
    "the same verdict, so this round was refused rather than re-run.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
    `Repair round: ${input.round}`,
    `Nudge ${input.nudge} of ${input.nudgeLimit}`,
    "",
    ...(input.priorPacket
      ? ["The review packet you already received asked for this:", "", bounded(input.priorPacket)]
      : [
        "The original review packet is no longer retained, so re-read the review on the run",
        "detail page for what it asked for.",
      ]),
  ].join("\n");
  const instruction =
    "Exactly two responses are acceptable. Either make the change the packet asks for, or say "
    + "plainly why it should not be made and leave the work as it stands. Reporting completion "
    + "again without doing one of those two will block this run for a human to resolve.";
  return {
    ...finalizePacket(body, truncated, instruction),
    failedPersonaCount: 0,
  };
}

/** Render the explicit human-chosen PR preparation handoff. */
export function renderPrHandoff(input: PrHandoffInput): RenderedWorkflowFeedback {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const body = [
    bounded(input.skillCommand),
    "",
    "Prepare the reviewed work for the workflow's Inspector final gate.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
  ].join("\n");
  const instruction =
    "Use the invoked pull-request skill to commit all reviewed work, push it, and open the pull request with a reviewer-ready description and concrete proof.";
  return {
    ...finalizePacket(body, truncated, instruction),
    failedPersonaCount: 0,
  };
}
