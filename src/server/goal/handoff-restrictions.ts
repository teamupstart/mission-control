import { GOAL_OPERATOR_HANDOFF_ONLY } from "@shared/goal.ts";

const STOP_DIRECTIVE = /^(?:please\s+)?stop(?:\s+(?:here|now|for now|(?:this|the)\s+task|work(?:ing)?\s+on\s+this(?:\s+task)?))?$/i;
const NO_PR_DIRECTIVE = /^(?:please\s+)?(?:no\s+|(?:do not|don['’]t)\s+(?:open|create|make|raise|publish|file|submit(?:\s+(?:this|it)\s+as)?)\s+(?:(?:a|the|any)\s+)?)(?:pr|pull request)s?(?:\s+for\s+this(?:\s+(?!yourself\b)[a-z][a-z0-9-]*)*)?(?:\s+(?:yet|until\s+\S.*|without\s+my\s+approval))?$/i;
const NO_REVIEW_DIRECTIVE = /^(?:please\s+)?(?:do not|don['’]t)\s+(?:submit|send)\s+(?:(?:this|it|the (?:work|change))\s+)?for\s+review(?:\s+or\s+open\s+(?:a\s+)?(?:pr|pull request))?$/i;
const DIRECTIVE_JOIN = /(\s*,\s*(?:(?:and|but)\s+)?|\s+(?:and|but)\s+)/i;

function isHandoffRestriction(part: string): boolean {
  const directive = part.trim().replace(/^also\s+/i, "");
  return STOP_DIRECTIVE.test(directive) || NO_PR_DIRECTIVE.test(directive) || NO_REVIEW_DIRECTIVE.test(directive);
}

// Match direct restrictions in the accepted turn or its effective objective. Leave
// contextual directions to the semantic reconciler and ignore transcript evidence here.
export function explicitHandoffRestriction(instruction: string | null): string | undefined {
  return directiveClauses(instruction)
    .flatMap((clause) => clause.split(DIRECTIVE_JOIN).filter((_, index) => index % 2 === 0))
    .filter(isHandoffRestriction).join(" and ") || undefined;
}

export function withoutHandoffRestrictions(objective: string): string {
  return objective.split("\n")
    .filter((line) => line.trim() !== GOAL_OPERATOR_HANDOFF_ONLY)
    .map((line) => line.replace(/[^.!?;]+([.!?;]*)/g, (sentence: string, punctuation: string) => {
      const parts = sentence.slice(0, sentence.length - punctuation.length).split(DIRECTIVE_JOIN);
      if (!parts.some((part, index) => index % 2 === 0 && isHandoffRestriction(part))) return sentence;
      let retained = "";
      for (let index = 0; index < parts.length; index += 2) {
        const part = parts[index]!;
        if (isHandoffRestriction(part)) continue;
        retained += retained ? parts[index - 1]! + part : part;
      }
      return retained.trim() ? retained.trimEnd() + punctuation : "";
    })).join("\n").trim();
}

function directiveClauses(instruction: string | null): string[] {
  return instruction?.split(/[.!?;\n]+/).map((clause) => clause.trim()) ?? [];
}
