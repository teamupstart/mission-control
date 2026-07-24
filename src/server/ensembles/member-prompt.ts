import { ENSEMBLE_LIMITS, type EnsembleRoleSpec } from "@shared/ensemble.ts";
import { boundedSection } from "../review/prompt.ts";
import { SUBMIT_ENSEMBLE_RESULT_TOOL } from "./submission-tool.ts";

/**
 * The harness-neutral appendix that turns an ordinary Task intent into an ensemble member's.
 *
 * A member is a normal Task, so it receives a normal intent; this is what the launch runtime
 * ADDS to it - the group facts the operator's task cannot carry, and the rules that make a
 * member a member. What it deliberately does NOT carry is any sibling's transcript, path or id,
 * and no server-assigned ensemble or member id at all: submission attribution comes from the
 * member's authenticated runtime, so an id in the prompt could only ever be an id used to submit
 * for someone else. The one exception is an explicit parent-artifact input, where the compiled
 * information policy has SAID this member starts from a named prior wave's immutable work.
 *
 * Everything interpolated is bounded, and the two operator-authored strings - the original intent
 * and the role's compiled appendix - are clamped with the shared review-prompt bound so a runaway
 * value truncates visibly rather than silently blowing the member's first prompt.
 */

/** A short, human-facing handle for a run. Not the id, which is never given to a member. */
export function ensembleDisplayId(runId: string): string {
  return runId.slice(0, 8);
}

export interface MemberPromptInput {
  runId: string;
  /** The operator's ordinary task intent - what the member actually works on. */
  intent: string;
  role: EnsembleRoleSpec;
  /** How many members share this run, for "candidate N of M". */
  totalMembers: number;
  /** The exact commit this member's checkout was pinned to and verified at. */
  baseSha: string;
  /**
   * For a parent-artifact input, the human LABELS of the parent roles this member starts from -
   * "Candidate 1", never an artifact id. Empty for a run-base member.
   */
  parentLabels: string[];
}

/**
 * Build the full first prompt for one member: the ordinary intent, then a bounded, self-contained
 * ensemble appendix.
 */
export function buildMemberPrompt(input: MemberPromptInput): string {
  const displayId = ensembleDisplayId(input.runId);
  const lines: string[] = [
    boundedSection(input.intent, ENSEMBLE_LIMITS.intent),
    "",
    "--- Mission Control ensemble ---",
    `You are part of ensemble run ${displayId}: ${input.role.label} ` +
      `(candidate ${input.role.ordinal} of ${input.totalMembers}, wave ${input.role.wave}).`,
  ];

  if (input.role.input.kind === "parent_artifacts") {
    const from =
      input.parentLabels.length > 0 ? input.parentLabels.join(", ") : "an earlier wave";
    lines.push(
      `Your checkout starts from the submitted work of ${from}, pinned at commit ${input.baseSha}. ` +
        "That work is immutable; build on it, and do not try to reach the other candidates' live checkouts.",
    );
  } else {
    lines.push(
      `Your checkout starts at commit ${input.baseSha}. Work only from there.`,
    );
  }

  // The role's compiled appendix carries the strategy's own rules - isolation, the approach hint,
  // no pushing before a winner is chosen. Bounded because the approach hint inside it is operator
  // free text.
  const roleAppendix = input.role.promptTemplate.trim();
  if (roleAppendix !== "") lines.push("", boundedSection(roleAppendix, ENSEMBLE_LIMITS.rolePrompt));

  lines.push(
    "",
    `When your work is ready to be compared, call the ${SUBMIT_ENSEMBLE_RESULT_TOOL} tool with a ` +
      "concise summary of what you did and the checks you actually ran. Mission Control captures " +
      "your working tree at that moment as an immutable snapshot; you do not push, open a pull " +
      "request, or run the shipping gate, and a winner is chosen afterwards.",
    "Do not claim a check you did not run, and do not inspect or coordinate with the other candidates.",
  );

  return lines.join("\n");
}
