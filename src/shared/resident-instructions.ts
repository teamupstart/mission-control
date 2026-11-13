// A resident's standing instructions, edited from inside its own conversation.
//
// Browser-safe: no `node:` import may reach this module. The daemon validates and applies
// proposals with it, the MCP bridge mirrors its input schema, and the dashboard reads its
// vocabulary.
//
// A proposal is a list of EDITS rather than replacement documents, because the human picks a
// subset of them. Each edit either replaces one exact passage or appends a new one, every
// passage must occur exactly once in the text it was proposed against, and no two passages may
// overlap. Any subset of such edits then applies to the original text in one deterministic
// result, which is what lets a person tick three of five changes and get exactly those three.

import { z } from "zod";
import { REQUEST_INPUT_DECISION_ID, requestInputOptionId, type RequestInputAsk } from "./request-input.ts";

/** Where an edit lands: the profile's own instructions, or the Persona the profile names. */
export const RESIDENT_INSTRUCTION_TARGETS = ["profile", "persona"] as const;
export type ResidentInstructionTarget = (typeof RESIDENT_INSTRUCTION_TARGETS)[number];

export const RESIDENT_INSTRUCTION_CHANGE_LIMITS = {
  changes: 8,
  title: 120,
  rationale: 2_000,
  passage: 8_000,
  summary: 2_000,
} as const;

/**
 * A proposal is asked as a `request_input` question with one option per change, so its answer is
 * read through `request_input`'s own decision and option ids (`@shared/request-input.ts`).
 */
export const RESIDENT_INSTRUCTION_DECISION_ID = REQUEST_INPUT_DECISION_ID;
export const residentInstructionOptionId = requestInputOptionId;

export const ResidentInstructionChangeSchema = z
  .object({
    target: z.enum(RESIDENT_INSTRUCTION_TARGETS),
    title: z.string().trim().min(1).max(RESIDENT_INSTRUCTION_CHANGE_LIMITS.title),
    rationale: z.string().trim().max(RESIDENT_INSTRUCTION_CHANGE_LIMITS.rationale).default(""),
    /** The exact passage to replace. Omitted, `replace` is appended as a new passage. */
    find: z.string().min(1).max(RESIDENT_INSTRUCTION_CHANGE_LIMITS.passage).optional(),
    /** The new passage. Empty removes `find`. */
    replace: z.string().max(RESIDENT_INSTRUCTION_CHANGE_LIMITS.passage),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (change.find === undefined && change.replace.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["replace"], message: "an appended change needs text in replace" });
    }
    if (change.find !== undefined && change.find === change.replace) {
      ctx.addIssue({ code: "custom", path: ["replace"], message: "replace must differ from find" });
    }
  });
export type ResidentInstructionChange = z.infer<typeof ResidentInstructionChangeSchema>;

export const ProposeResidentInstructionChangesSchema = z
  .object({
    summary: z.string().trim().max(RESIDENT_INSTRUCTION_CHANGE_LIMITS.summary).default(""),
    changes: z.array(ResidentInstructionChangeSchema).min(1).max(RESIDENT_INSTRUCTION_CHANGE_LIMITS.changes),
  })
  .strict();
export type ProposeResidentInstructionChanges = z.infer<typeof ProposeResidentInstructionChangesSchema>;

/** What `get_resident_instructions` returns: the CURRENT texts a proposal edits. */
export interface ResidentInstructionsView {
  profile: {
    id: string;
    name: string;
    /** The profile's current revision, which is what a proposal is written against. */
    revision: number;
    builtin: boolean;
    instructions: string;
  };
  /** Null when the profile names no Persona. */
  persona: {
    id: string;
    name: string;
    revision: number;
    builtin: boolean;
    guidance: string;
  } | null;
  /** The revision the calling run launched on. It keeps it until Restart on new profile. */
  runProfileRevision: number;
  /** Why each target cannot take an edit now, or null when it can. */
  refusals: Record<ResidentInstructionTarget, string | null>;
}

export const RESIDENT_INSTRUCTION_OUTCOME_STATUSES = [
  "pending",
  "applied",
  "none_selected",
  "dismissed",
  "chat",
  "orphaned",
  "stale",
  "refused",
] as const;
export type ResidentInstructionOutcomeStatus = (typeof RESIDENT_INSTRUCTION_OUTCOME_STATUSES)[number];

export interface ResidentInstructionOutcomeChange {
  index: number;
  title: string;
  target: ResidentInstructionTarget;
}

/** What became of one proposal, recorded when the human settled its review. */
export interface ResidentInstructionOutcome {
  reviewId: string;
  status: ResidentInstructionOutcomeStatus;
  /** One plain sentence for the agent, and for anyone reading the conversation. */
  message: string;
  applied: ResidentInstructionOutcomeChange[];
  skipped: ResidentInstructionOutcomeChange[];
  /** The profile revision the applied changes created, when any landed there. */
  profileRevision: number | null;
  /** The Persona revision the applied changes created, when any landed there. */
  personaRevision: number | null;
  /** What the human typed in "Other" or as a note: guidance for a follow-up, never applied. */
  feedback: string | null;
}

/** One edit, located in the text it applies to. An append has no range. */
export interface LocatedResidentInstructionChange {
  index: number;
  range: { start: number; end: number } | null;
  replace: string;
}

/**
 * Locate each edit in `text`, or say why the set cannot be applied as proposed.
 *
 * Strict on purpose: a passage that appears twice would make "replace it" ambiguous, and two
 * overlapping passages would make "apply both" depend on order. Either is refused at proposal
 * time, before anything is shown to the human, so every subset they can select applies.
 */
export function locateResidentInstructionChanges(
  text: string,
  changes: ReadonlyArray<{ index: number; title: string; find?: string; replace: string }>,
): { ok: true; located: LocatedResidentInstructionChange[] } | { ok: false; problem: string } {
  const located: LocatedResidentInstructionChange[] = [];
  for (const change of changes) {
    if (change.find === undefined) {
      located.push({ index: change.index, range: null, replace: change.replace });
      continue;
    }
    const start = text.indexOf(change.find);
    if (start < 0) {
      return { ok: false, problem: `change ${change.index + 1} ("${change.title}"): its find passage does not occur in the current text; copy it exactly from get_resident_instructions` };
    }
    if (text.indexOf(change.find, start + 1) >= 0) {
      return { ok: false, problem: `change ${change.index + 1} ("${change.title}"): its find passage occurs more than once; include enough surrounding text to make it unique` };
    }
    located.push({ index: change.index, range: { start, end: start + change.find.length }, replace: change.replace });
  }
  const ranged = located
    .filter((change): change is LocatedResidentInstructionChange & { range: { start: number; end: number } } => change.range !== null)
    .sort((a, b) => a.range.start - b.range.start);
  for (let i = 1; i < ranged.length; i += 1) {
    if (ranged[i]!.range.start < ranged[i - 1]!.range.end) {
      return { ok: false, problem: `changes ${ranged[i - 1]!.index + 1} and ${ranged[i]!.index + 1} edit overlapping passages; merge them into one change` };
    }
  }
  return { ok: true, located };
}

/**
 * Apply a located subset to the text it was located in.
 *
 * Replacements run from the end of the text backwards so each earlier range is still where it
 * was found; appends follow in proposal order, each as its own paragraph.
 */
export function applyResidentInstructionChanges(
  text: string,
  located: readonly LocatedResidentInstructionChange[],
): string {
  let result = text;
  const ranged = located
    .filter((change) => change.range !== null)
    .sort((a, b) => b.range!.start - a.range!.start);
  for (const change of ranged) {
    result = result.slice(0, change.range!.start) + change.replace + result.slice(change.range!.end);
  }
  for (const change of [...located].filter((entry) => entry.range === null).sort((a, b) => a.index - b.index)) {
    const base = result.replace(/\s+$/, "");
    const addition = change.replace.trim();
    result = base ? `${base}\n\n${addition}` : addition;
  }
  return result;
}

/** A passage set apart by indentation, which the plain-text question renders verbatim. */
function indented(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

export interface ResidentInstructionQuestionInput {
  profileName: string;
  profileRevision: number;
  personaName: string | null;
  summary: string;
  changes: readonly ResidentInstructionChange[];
}

export function residentInstructionTargetLabel(
  target: ResidentInstructionTarget,
  personaName: string | null,
): string {
  return target === "profile" ? "Profile instructions" : `Persona guidance (${personaName ?? "Persona"})`;
}

/**
 * The `request_input` question a proposal is asked as: every change in full, exactly as it would
 * be written, then one multi-select option per change and room for guidance in "Other".
 *
 * Plain text, because a `request_input` question is shown as written, whitespace kept: passages
 * are indented rather than fenced so nothing in them can be read as markup.
 */
export function residentInstructionQuestion(input: ResidentInstructionQuestionInput): RequestInputAsk & {
  options: Array<{ label: string; detail: string }>;
  multiSelect: true;
  allowOther: true;
} {
  const touchesPersona = input.changes.some((change) => change.target === "persona");
  const lines: string[] = [`Which of these changes to ${input.profileName}'s standing instructions should Mission Control apply?`];
  if (input.summary) lines.push("", input.summary);
  lines.push(
    "",
    `Mission Control writes only the changes you select: profile changes become the next revision of ${input.profileName} (now revision ${input.profileRevision})`
      + (touchesPersona && input.personaName
        ? `, and Persona changes become the next revision of ${input.personaName}, which every profile and task that uses it picks up at its next launch.`
        : ".")
      + " A running resident keeps its current instructions until you choose Restart on new profile.",
  );
  input.changes.forEach((change, index) => {
    lines.push("", `${index + 1}. ${change.title}`, `Where: ${residentInstructionTargetLabel(change.target, input.personaName)}`);
    if (change.rationale) lines.push(`Why: ${change.rationale}`);
    if (change.find === undefined) {
      lines.push("Append:", indented(change.replace.trim()));
    } else if (change.replace === "") {
      lines.push("Remove:", indented(change.find));
    } else {
      lines.push("Replace:", indented(change.find), "With:", indented(change.replace));
    }
  });
  return {
    question: lines.join("\n"),
    options: input.changes.map((change, index) => ({
      label: `${index + 1}. ${change.title}`,
      detail: residentInstructionTargetLabel(change.target, input.personaName),
    })),
    multiSelect: true,
    allowOther: true,
  };
}

/** What the propose tool hands back to the agent. */
export function residentInstructionOutcomeText(outcome: ResidentInstructionOutcome): string {
  const lines = [`outcome=${outcome.status}`, outcome.message];
  if (outcome.applied.length > 0) {
    lines.push(`Applied: ${outcome.applied.map((change) => `${change.index + 1}. ${change.title}`).join("; ")}`);
  }
  if (outcome.skipped.length > 0) {
    lines.push(`Not applied: ${outcome.skipped.map((change) => `${change.index + 1}. ${change.title}`).join("; ")}`);
  }
  if (outcome.feedback) lines.push(`The operator also wrote: ${outcome.feedback}`);
  return lines.join("\n");
}
