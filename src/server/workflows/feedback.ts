import { createHash } from "node:crypto";
import { PersonaVerdictSchema, WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import { WORKFLOW_LIMITS, isVerdictNode, verdictAuthor } from "@shared/workflow.ts";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowNodeAttempt,
  WorkflowEvidenceReadinessGapCode,
  WorkflowEvidenceReadinessResult,
  WorkflowRun,
  WorkflowSubmission,
  WorkflowVersion,
} from "@shared/workflow.ts";
import type { InspectorComment } from "@shared/types.ts";
import type { InspectorPosture } from "@shared/inspector.ts";
import type { InspectorFindingsPolicy } from "@shared/workflow.ts";
import { executionAuthorizationContract } from "../execution-authorization.ts";
import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./evidence-tool.ts";
import { workflowPullRequestCiContract } from "./agent-contract.ts";
import {
  isTestEvidenceAuditorPersona,
  testEvidenceRequestCategories,
} from "./test-evidence-audit.ts";

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
  /** The pinned immutable workflow version contains at least one Persona. */
  workflowEvidence: boolean;
}

export interface PrHandoffInput {
  workflowName: string;
  workflowVersion: number;
  runId: string;
  originalGoal: string;
  skillCommand: string;
  /** The pinned immutable workflow version contains at least one Persona. */
  workflowEvidence: boolean;
  /**
   * The repository this run reviews, or null when it is the session's own checkout. Same
   * reason `SessionActionPacketOrigin` carries one: the handoff asks for a pull request, and
   * a session running two reviews must be told which repository's.
   */
  repoRoot: string | null;
}

/**
 * A rendered action packet, or the refusal that it cannot be sent whole.
 *
 * A discriminated result rather than a `truncated` flag, because there is no useful truncated
 * action packet: the caller's only correct response to "it does not fit" is to block, and a
 * boolean beside a usable-looking payload invites shipping the prefix.
 */
export type RenderedSessionAction =
  | { ok: true; payload: string; payloadSha256: string }
  | { ok: false; bytes: number; limit: number };

/**
 * Who asked for this action, as the envelope will say it.
 *
 * A discriminated union rather than three optional fields, because the two callers have
 * genuinely different provenance and the envelope must not invent the half it lacks. A run
 * delivers on behalf of a published version and names it; the retro route delivers because a
 * human clicked, and there is no workflow, no version and no run to name. Printing
 * `Run: unknown` there would be a fact the packet asserts and nothing backs.
 *
 * The `session` arm names the RECEIVING session's own id, which is not decoration: an action
 * whose instructions send the session back through its own transcript
 * (`GET /api/sessions/:id/transcript`) has no other way to learn that id. The prompt Markdown
 * cannot carry it - it is frozen bytes, never a template - so the envelope is the only place
 * a per-delivery fact can live.
 */
export type SessionActionPacketOrigin =
  | {
      kind: "run";
      workflowName: string;
      workflowVersion: number;
      runId: string;
      /**
       * The repository this run reviews, or null when it is the session's own checkout.
       *
       * A run is one repository, and a multi-repo task's session runs several of them at once
       * into ONE pane. Without this the two packets differ only by a run id, and an action
       * that says "open the pull request for the work you just had reviewed" cannot be told
       * which work that was. Null everywhere else, and the line is then omitted entirely, so
       * a single-repo packet is byte-identical to what it always was.
       */
      repoRoot: string | null;
    }
  | { kind: "session"; sessionId: string };

export interface SessionActionPacketInput {
  origin: SessionActionPacketOrigin;
  /** The snapshot's name, for the envelope. Never re-read from the live library. */
  actionName: string;
  /** The snapshot's exact prompt Markdown. */
  promptMarkdown: string;
  /** Resolved from the bound harness at preparation, or null when none is required. */
  skillCommand: string | null;
  /** The pinned immutable workflow version contains a Persona; false for on-demand actions. */
  workflowEvidence: boolean;
  /** Enabled only for workflow PR completion actions at packet preparation. */
  pullRequestCi?: boolean;
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
  /** The pinned immutable workflow version contains at least one Persona. */
  workflowEvidence: boolean;
}

export interface EvidenceReadinessPacketInput {
  workflowName: string;
  workflowVersion: number;
  runId: string;
  repository: string;
  round: number;
  segment: number;
  readiness: WorkflowEvidenceReadinessResult;
  workflowEvidence: boolean;
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

function testEvidenceRepairRecipe(verdict: PersonaVerdict): string[] {
  const categories = new Set(testEvidenceRequestCategories(verdict));
  const lines = ["", "Evidence registration recipe:"];
  if (categories.has("visual_artifact")) {
    lines.push(
      `- Visual: save the final rendered state as a gitignored image and register it through \`${SUBMIT_WORKFLOW_EVIDENCE_TOOL}\` \`images\` with the issued repository scope and a precise caption.`,
    );
  }
  if (categories.has("focused_execution")) {
    lines.push(
      `- Executed output: after the final focused run, register its exact command, exit code, and completed output through \`${SUBMIT_WORKFLOW_EVIDENCE_TOOL}\` \`commandOutputs\`.`,
    );
  }
  if (categories.has("downstream_proof")) {
    lines.push(
      "- Later-stage proof: do not create or wait for pull-request, remote CI, merge, or Inspector evidence unless the original user goal explicitly requires it at this stage. Register current-stage native evidence instead.",
    );
  }
  if (categories.has("other")) {
    lines.push(
      `- Match the missing proof to its native channel: \`images\` for rendered pixels, \`commandOutputs\` for a completed focused run, or \`artifacts\` for an existing gitignored UTF-8 log.`,
    );
  }
  lines.push(
    "- Confirm registration succeeded before stopping. Prose summaries, unregistered files, ordinary tool-result bodies, and pull-request attachments are not visible to this Persona.",
  );
  return lines;
}

function finalizePacket(
  body: string,
  truncated: boolean,
  finalInstruction: string,
  workflowEvidence: boolean,
): {
  payload: string;
  payloadSha256: string;
  truncated: boolean;
} {
  const cleanBody = sanitizeWorkflowFeedback(body).replace(/\s+$/u, "");
  const authorization = executionAuthorizationContract({
    workflowEvidence,
    workflowContinuation: true,
  });
  const finalBlock = `${authorization}\n\n${finalInstruction}`;
  let payload = `${cleanBody}\n\n${finalBlock}`;
  if (encoder.encode(payload).byteLength > WORKFLOW_LIMITS.feedbackPayloadBytes) truncated = true;
  if (truncated) {
    const suffix = `\n\n${finalBlock}${TRUNCATION_NOTICE}`;
    const budget = WORKFLOW_LIMITS.feedbackPayloadBytes - encoder.encode(suffix).byteLength;
    payload = clipUtf8(cleanBody, Math.max(0, budget)).value.replace(/\s+$/u, "") + suffix;
  }
  return {
    payload,
    payloadSha256: createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex"),
    truncated,
  };
}

/**
 * One line per gap, printed under `Required repair:`.
 *
 * That block is rendered LAST for a criterion, after its contested-claim line and its linked
 * evidence, so any wording that points at them points upward. It read "the claims below" and
 * sent a reader down the packet past the list it meant.
 */
const READINESS_ACTIONS: Record<WorkflowEvidenceReadinessGapCode, string> = {
  missing_coverage: "Declare and link an author-controlled coverage claim for this criterion.",
  ambiguous_mapping: "Leave exactly one of the claims listed above on this criterion and move or withdraw the rest.",
  evidence_not_frozen: "Register the linked evidence item again so it freezes with the repair segment.",
  scope_conflict: "Link evidence issued for this repository scope or for all repositories.",
  missing_execution: "Register and link exact completed focused command output with role execution.",
  missing_rendered_output: "Register and link a gitignored rendered image with role rendered_output.",
  missing_baseline_measurement: "Register and link the comparable baseline with role baseline_measurement.",
  missing_result_measurement: "Register and link the measured result with role result_measurement.",
  missing_deliverable_or_rendered_output: "Register and link the deliverable or its rendered output.",
  missing_state_snapshot: "Register and link a bounded state snapshot with role state_snapshot.",
  unknown_criterion_id: "Correct or remove the criterionId named below; it matches no criterion of this run.",
};

/** Render deterministic structural gaps without exposing internal evidence ids or local paths. */
export function renderEvidenceReadinessPacket(
  input: EvidenceReadinessPacketInput,
): RenderedWorkflowFeedback {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const lines = [
    "# Evidence preflight needs repair",
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
    `Repository: ${bounded(input.repository)}`,
    `Round: ${input.round}, segment: ${input.segment}`,
  ];
  /*
   * The rules first, then the criteria, and the criteria include the ones that passed.
   *
   * An author cannot repair a mapping it has never been shown. The criteria are minted during
   * capture from the operator's intent, so a first submission necessarily guesses at how many
   * there are and how they are worded, and this packet is the first and only place that guess
   * is corrected. Printing only the failures left the author to infer the rubric from its
   * holes, and printing no rule at all left the commonest repair - one claim per criterion,
   * all of them pointing at evidence that is already registered - to be rediscovered.
   */
  lines.push(
    "",
    "## How a criterion is matched",
    "- Each criterion below needs exactly one coverage claim of its own. Two claims on one criterion is the only ambiguity left; one claim may answer several criteria.",
    "- Bind a claim by copying the criterion id into its `criterionId`. Copying the criterion text verbatim into `criterion` also binds it. Either one avoids a guess.",
    "- One evidence item may be linked from as many claims as apply. Proof you already registered does not need capturing again to cover a second criterion.",
    "- Evidence and coverage you already registered are carried into this repair segment. Register only what is genuinely missing.",
  );
  /*
   * A refused citation is reported before the criteria, because it EXPLAINS them.
   *
   * A claim whose `criterionId` resolved to nothing is matched by nothing at all - not by its
   * prose either - so whatever criterion it was meant to answer is sitting below saying it has
   * no coverage. Printing only that would send the author to capture proof for a criterion
   * whose proof is already registered under a mistyped id.
   */
  const rejected = input.readiness.rejectedCitations ?? [];
  if (rejected.length > 0) {
    lines.push("", "## Criterion ids that matched nothing");
    for (const citation of rejected) {
      lines.push(
        `- Claim ${bounded(citation.clientCriterionId)} cited ${bounded(citation.criterionId)},`
        + " which is not a criterion of this run. The claim was matched by nothing, including"
        + " its own text.",
      );
    }
    lines.push(
      "Copy an id exactly as it appears under a criterion below, or drop `criterionId` and let"
      + " the claim be matched by its text.",
    );
  }
  for (const criterion of input.readiness.criteria.filter((item) => item.gaps.length > 0)) {
    lines.push("", `## ${bounded(criterion.criterion)}`);
    lines.push(`Criterion id: ${bounded(criterion.criterionId)}`);
    lines.push(`Author proof class: ${criterion.authorProofClass?.replaceAll("_", " ") ?? "not declared"}`);
    const contested = criterion.contestedClientCriterionIds ?? [];
    if (contested.length > 0) {
      lines.push(`Claims currently matched to it: ${contested.map(bounded).join(", ")}`);
    }
    if (criterion.links.length > 0) {
      lines.push("Linked evidence:");
      for (const link of criterion.links) {
        lines.push(`- ${link.role.replaceAll("_", " ")}: ${bounded(link.clientItemId)}`);
      }
    } else {
      lines.push("Linked evidence: none");
    }
    lines.push("Required repair:");
    for (const gap of criterion.gaps) lines.push(`- ${READINESS_ACTIONS[gap] ?? gap}`);
    if (criterion.warnings.length > 0) {
      lines.push("Advisory model warning: the suggested proof class differs from the author's declaration. The author declaration controls structural requirements.");
    }
  }
  const satisfied = input.readiness.criteria.filter((item) => item.gaps.length === 0);
  if (satisfied.length > 0) {
    lines.push("", "## Criteria already matched, for reference only");
    for (const criterion of satisfied) {
      const by = criterion.matchedClientCriterionId
        ? `covered by ${bounded(criterion.matchedClientCriterionId)}`
        : criterion.material
        ? "no claim needed"
        : "not material";
      lines.push(`- ${bounded(criterion.criterionId)}: ${bounded(criterion.criterion)} (${by})`);
    }
  }
  lines.push(
    "",
    "Register the missing proof and updated coverage through `submit_workflow_evidence` using the issued repository scope. Mission Control will freeze a new immutable segment in this same round when applicable evidence changes.",
  );
  return {
    ...finalizePacket(
      lines.join("\n"),
      truncated,
      "Repair only the gaps named above, verify the work, confirm evidence registration succeeded, and stop. Mission Control owns resubmission.",
      input.workflowEvidence,
    ),
    failedPersonaCount: 0,
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
    if (node.kind === "persona" && isTestEvidenceAuditorPersona(node.persona)) {
      lines.push(...testEvidenceRepairRecipe(verdict).map(bounded));
    }
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
    ...finalizePacket(
      bodyParts.join("\n"),
      truncated,
      FINAL_INSTRUCTION,
      input.version.graph.nodes.some((node) => node.kind === "persona"),
    ),
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
    : "This published policy permits bypassing Personas only for this GitHub Inspector repair. Fix the findings, verify the work, commit and push a new head, then wait for GitHub Inspector to review that new head.";
  const body = [
    "GitHub Inspector reviewed the pinned pull request head and found changes that are required.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
    `PR: ${bounded(input.prUrl)}`,
    `Pinned head: ${bounded(input.targetHeadSha)}`,
    `GitHub Inspector round: ${input.inspectorRound}`,
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
    ...finalizePacket(body, truncated, policyInstruction, input.workflowEvidence),
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
    ...finalizePacket(body, truncated, instruction, input.workflowEvidence),
    failedPersonaCount: 0,
  };
}

export interface ParkedRepairReminderInput {
  workflowName: string;
  workflowVersion: number;
  runId: string;
  /** The parked round, so the reminder names the number run detail shows. */
  round: number;
  originalGoal: string;
  /** How long the round has been parked with its packet delivered, in whole minutes. */
  parkedMinutes: number;
  /** The packet this session was handed and has not acted on, or null if it was pruned. */
  priorPacket: string | null;
  /** The pinned immutable workflow version contains at least one Persona. */
  workflowEvidence: boolean;
}

/**
 * Ask once about a repair round that has been parked with nothing happening.
 *
 * The gap this fills is the quietest failure the repair loop has. A packet is delivered, the
 * observer starts watching for repository movement, and if the session simply never acts -
 * a lapsed hook, a turn that ended early, an agent that read the packet as a status report -
 * then nothing moves and nothing says so. Runs have sat like that for most of a day: the
 * observer was right to withhold every round it withheld, and the operator's only recourse
 * was a manual resubmission that spent a round to discover the tree was untouched.
 *
 * This is NOT the unchanged-evidence nudge and must not read like it. That one answers a
 * claim - the session said it was done and the bytes disagree - so it is entitled to be
 * blunt and to count against a limit. This one answers a silence, which has innocent causes,
 * so it states what it sees, repeats what was asked, and makes no accusation.
 *
 * It is sent ONCE per parked round. A reminder that repeats is a session's whole context
 * spent on the daemon asking the same question, and the second one has never been the thing
 * that unsticks a stuck agent.
 */
export function renderParkedRepairReminder(
  input: ParkedRepairReminderInput,
): RenderedWorkflowFeedback {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = field(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const body = [
    `This repair round has been open for ${input.parkedMinutes} minutes with no change to the`,
    "repository - no commit, no working-tree edit, no new file - so the review has not been",
    "able to start another round.",
    "",
    "If the repair is done, nothing else is needed and this will pick itself up. If it was",
    "never started, or it stopped part way, the packet below is what it was waiting for.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
    `Repair round: ${input.round}`,
    "",
    ...(input.priorPacket
      ? ["The review packet you were handed asked for this:", "", bounded(input.priorPacket)]
      : [
        "The original review packet is no longer retained, so re-read the review on the run",
        "detail page for what it asked for.",
      ]),
  ].join("\n");
  const instruction =
    "Either carry out the change the packet asks for, or say plainly why it should not be "
    + "made and leave the work as it stands. This is the only reminder this round will send.";
  return {
    ...finalizePacket(body, truncated, instruction, input.workflowEvidence),
    failedPersonaCount: 0,
  };
}

/**
 * Render one authored SessionAction packet: a small envelope plus the exact prompt.
 *
 * Deliberately NOT routed through `finalizePacket`, and the difference is the whole point.
 * Every other packet is prose the DAEMON composed from verdicts or findings, so clipping it
 * to the review budget and appending a house instruction loses nothing an operator wrote.
 * This one carries the operator's own instruction, frozen into an immutable version, so the
 * ceiling is the delivery row's bound rather than the review budget, and nothing is appended
 * after it - a trailing house sentence would be an instruction nobody authored, arriving
 * after the one they did.
 *
 * The prompt is still sanitized. `sanitizeWorkflowFeedback` removes bytes a terminal would
 * read as controls and leaves plain line breaks, and that is a safety property of writing
 * into somebody's pane rather than an edit of the text: it is the same treatment every other
 * packet gets, applied to text that is otherwise passed through verbatim.
 */
export function renderSessionAction(input: SessionActionPacketInput): RenderedSessionAction {
  const header = [
    `Mission Control session action: ${sanitizeWorkflowFeedback(input.actionName)}`,
    ...(input.origin.kind === "run"
      ? [
        `Workflow: ${sanitizeWorkflowFeedback(input.origin.workflowName)} v${input.origin.workflowVersion}`,
        `Run: ${input.origin.runId}`,
        ...(input.origin.repoRoot
          ? [`Repository: ${sanitizeWorkflowFeedback(input.origin.repoRoot)}`]
          : []),
      ]
      : [`Session: ${sanitizeWorkflowFeedback(input.origin.sessionId)}`]),
    "",
  ];
  // The skill invocation leads, exactly as the PR handoff's does, so the harness resolves it
  // as the turn's first line. `deliveryBlock` re-checks this prefix immediately before the
  // write, which is what stops a prepared packet invoking a link that has since drifted.
  const lines = input.skillCommand
    ? [sanitizeWorkflowFeedback(input.skillCommand), "", ...header]
    : header;
  const authorization = executionAuthorizationContract({
    workflowEvidence: input.workflowEvidence,
    workflowContinuation: input.origin.kind === "run",
  });
  const ciPolicy = input.origin.kind === "run" && input.pullRequestCi
    ? ["", workflowPullRequestCiContract(), ""]
    : [];
  const payload = `${[...lines, authorization, ...ciPolicy, ""].join("\n")}${sanitizeWorkflowFeedback(input.promptMarkdown)}`;
  // REFUSED, never truncated. Every other packet in this file clips, because every other
  // packet is prose the daemon composed and a shorter summary is still a true summary. This
  // one is the operator's own instruction, frozen into an immutable version: a prefix of
  // "delete the old adapter and keep the new one" is a different request, and delivering it
  // would change the operation without failing the run. `sessionActionPromptBytes` is derived
  // from this budget so an authored action cannot reach here, and a version minted by some
  // other build blocks instead of typing half a sentence.
  const bytes = encoder.encode(payload).byteLength;
  if (bytes > WORKFLOW_LIMITS.sessionActionPacketBytes) {
    return { ok: false, bytes, limit: WORKFLOW_LIMITS.sessionActionPacketBytes };
  }
  return {
    ok: true,
    payload,
    payloadSha256: createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex"),
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
    "Prepare the reviewed work for the workflow's GitHub Inspector final gate.",
    "",
    "Original user goal:",
    bounded(input.originalGoal),
    "",
    `Workflow: ${bounded(input.workflowName)} v${input.workflowVersion}`,
    `Run: ${input.runId}`,
    ...(input.repoRoot ? [`Repository: ${bounded(input.repoRoot)}`] : []),
  ].join("\n");
  const instruction = input.repoRoot
    ? "Use the invoked pull-request skill to commit the reviewed work in the repository named above, push it, and open that repository's pull request with a reviewer-ready description and concrete proof. Leave the task's other repositories alone; each has its own review and its own pull request."
    : "Use the invoked pull-request skill to commit all reviewed work, push it, and open the pull request with a reviewer-ready description and concrete proof.";
  return {
    ...finalizePacket(body, truncated, instruction, input.workflowEvidence),
    failedPersonaCount: 0,
  };
}
