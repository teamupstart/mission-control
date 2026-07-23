import { createHash } from "node:crypto";
import { PersonaVerdictSchema, WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import { WORKFLOW_LIMITS } from "@shared/workflow.ts";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowNodeAttempt,
  WorkflowRun,
  WorkflowSubmission,
  WorkflowVersion,
} from "@shared/workflow.ts";

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

/** Render one immutable Persona-failure packet. Model output supplies facts, never structure. */
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
    if (node.kind !== "persona") continue;
    const attempt = byNode.get(node.id);
    const parsed = PersonaVerdictSchema.safeParse(attempt?.verdict);
    if (!parsed.success || parsed.data.verdict !== "fail") continue;
    const verdict: Extract<PersonaVerdict, { verdict: "fail" }> = parsed.data;
    const lines = [
      `## ${bounded(node.persona.name)}`,
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
  const body = sanitizeWorkflowFeedback(bodyParts.join("\n")).replace(/\s+$/u, "");
  let payload = `${body}\n\n${FINAL_INSTRUCTION}`;
  if (encoder.encode(payload).byteLength > WORKFLOW_LIMITS.feedbackPayloadBytes) {
    truncated = true;
  }
  if (truncated) {
    const suffix = `\n\n${FINAL_INSTRUCTION}${TRUNCATION_NOTICE}`;
    const budget = WORKFLOW_LIMITS.feedbackPayloadBytes - encoder.encode(suffix).byteLength;
    payload = clipUtf8(body, Math.max(0, budget)).value.replace(/\s+$/u, "") + suffix;
  }
  const payloadSha256 = createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
  return { payload, payloadSha256, failedPersonaCount: blocks.length, truncated };
}
