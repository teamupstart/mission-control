import { GOAL_OPERATOR_HANDOFF_ONLY, goalLine, mapUnfencedGoalLines } from "@shared/goal.ts";

const STOP_DIRECTIVE = /^(?:please\s+)?stop(?:\s+(?:here|now|for now|(?:this|the)\s+task|work(?:ing)?\s+on\s+this(?:\s+task)?))?$/i;
const NO_PR_DIRECTIVE = /^(?:please\s+)?(?:no\s+|(?:do not|don['’]t)\s+(?:open|create|make|raise|publish|file|submit(?:\s+(?:this|it)\s+as)?)\s+(?:(?:a|the|any)\s+)?)(?:pr|pull request)s?(?:\s+for\s+this(?:\s+(?!yourself\b)[a-z][a-z0-9-]*)*)?$/i;
const NO_REVIEW_DIRECTIVE = /^(?:please\s+)?(?:do not|don['’]t)\s+(?:submit|send)\s+(?:(?:this|it|the (?:work|change))\s+)?for\s+review(?:\s+or\s+open\s+(?:a\s+)?(?:pr|pull request))?$/i;
const NO_SHIPPING_DIRECTIVE = /^(?:please\s+)?(?:do not|don['’]t)\s+ship(?:\s+(?:this|it|the (?:work|change)))?$/i;
const DIRECTIVE_JOIN = /(\s*,\s*(?:(?:and|but)\s+)?|\s+(?:and|but)\s+)/i;
const LIST_MARKER = /^\s*(?:[-+*]|\d+[.)])\s+/;

export const HANDOFF_RESTRICTION_PREFIX = "Operator handoff restriction: ";
const WORKFLOW_DELEGATION = /^(?:(?:then|please|also)\s+)*(?:let|have)\s+(?:the\s+)?(?:bound\s+)?workflow\s+(?:open|create|make|raise|publish|file|submit)\s+(?:it|(?:the|a)\s+(?:pr|pull request))\b/i;
const APPROVAL_CONDITION = /\s+(?:yet|(?:until|before)\s+\S.*|without\s+my\s+approval)$/i;
export function isStandaloneHandoffRelease(text: string): boolean {
  return /^(?:please\s+)?resume\s+automatic\s+handoff$/i.test(text.trim().replace(/[.!?]+$/, ""));
}

const PERSONAL_PR = /^leave opening the (?:pr|pull request) to me$/i;

export function contextualHandoffRestriction(instruction: string): string {
  return HANDOFF_RESTRICTION_PREFIX + goalLine(instruction, 480);
}

function restrictionParts(clause: string, listItem: boolean, nextClause = ""): boolean[] {
  const parts = clause.split(DIRECTIVE_JOIN);
  const delegates = WORKFLOW_DELEGATION.test(nextClause.trim())
    || parts.some((part, index) => index % 2 === 0 && WORKFLOW_DELEGATION.test(part.trim()));
  return parts.map((part, index) => {
    if (index % 2) return false;
    const directive = part.trim().replace(/^also\s+/i, "");
    const unconditional = directive.replace(APPROVAL_CONDITION, "");
    const holdsPublication = NO_PR_DIRECTIVE.test(unconditional) || NO_REVIEW_DIRECTIVE.test(unconditional);
    return (holdsPublication && (!delegates || unconditional !== directive))
      || NO_SHIPPING_DIRECTIVE.test(unconditional)
      || PERSONAL_PR.test(directive)
      || (STOP_DIRECTIVE.test(directive) && (!/^stop$/i.test(directive) || (!listItem && parts.length === 1)));
  });
}

export function explicitHandoffRestriction(instruction: string | null): string | undefined {
  const restrictions: string[] = [];
  if (instruction) mapUnfencedGoalLines(instruction, (line) => {
    const listMarker = line.match(LIST_MARKER)?.[0] ?? "";
    const trimmed = line.slice(listMarker.length).trim();
    if (trimmed.startsWith(HANDOFF_RESTRICTION_PREFIX)) restrictions.push(trimmed);
    else trimmed.split(/[.!?;]+/).forEach((clause, index, clauses) => {
      const matches = restrictionParts(clause, Boolean(listMarker), clauses[index + 1]);
      restrictions.push(...clause.split(DIRECTIVE_JOIN).filter((_, index) => matches[index]).map((part) => part.trim()));
    });
    return line;
  });
  return restrictions.join(" and ") || undefined;
}

export function withoutHandoffRestrictions(objective: string): string {
  return mapUnfencedGoalLines(objective, (line) => {
    const listMarker = line.match(LIST_MARKER)?.[0] ?? "";
    const content = line.slice(listMarker.length);
    const trimmed = content.trim();
    if (trimmed === GOAL_OPERATOR_HANDOFF_ONLY || trimmed.startsWith(HANDOFF_RESTRICTION_PREFIX)) return "";
    const remaining = content.replace(/[^.!?;]+([.!?;]*)/g, (sentence: string, punctuation: string, offset: number) => {
      const clause = sentence.slice(0, sentence.length - punctuation.length);
      const parts = clause.split(DIRECTIVE_JOIN);
      const nextClause = content.slice(offset + sentence.length).split(/[.!?;]/, 1)[0];
      const matches = restrictionParts(clause, Boolean(listMarker), nextClause);
      if (!matches.some(Boolean)) return sentence;
      let retained = "";
      for (let index = 0; index < parts.length; index += 2) {
        const part = parts[index]!;
        if (matches[index]) continue;
        retained += retained ? parts[index - 1]! + part : part;
      }
      return retained.trim() ? retained.trimEnd() + punctuation : "";
    });
    return listMarker && remaining !== content && !remaining.trim() ? "" : listMarker + remaining;
  }).join("\n").trim();
}
