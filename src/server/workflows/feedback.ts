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
const FINAL_INSTRUCTION =
  "Preserve the user's explicit intent. Make only changes supported by this packet, verify the work, and signal completion normally.";
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
    ? "Fix the findings, verify the work, commit and push it, then signal completion so every Persona reruns before Inspector."
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

/** Render the explicit human-chosen PR preparation handoff. */
export function renderPrHandoff(input: PrHandoffInput): RenderedWorkflowFeedback {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const body = [
    "Prepare the reviewed work for the workflow's Inspector final gate.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
  ].join("\n");
  const instruction =
    "Commit all reviewed work, push it, open the pull request through the normal harness or no-mistakes path, then signal completion so the full Persona workflow is submitted again.";
  return {
    ...finalizePacket(body, truncated, instruction),
    failedPersonaCount: 0,
  };
}
