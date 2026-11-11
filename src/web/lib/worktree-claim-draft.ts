import type { WorktreeClaim } from "@shared/protocol.ts";

// The claim editor's draft, and the mapping from the worktrees settings route's schema refusal
// back onto the fields that caused it. The daemon's `WorktreeClaimSchema` is the only validator:
// the editor sends what was typed and places whatever the route refuses beside its field.

export interface ClaimStepDraft {
  /** One argument per line. A line is an argument exactly as typed; blank lines are dropped. */
  argv: string;
  /** Variable names, separated by spaces, commas or newlines. Names cannot contain any of those. */
  env: string;
}

export interface ClaimDraft {
  steps: ClaimStepDraft[];
  timeoutMinutes: string;
  /** One glob per line. */
  fingerprintPaths: string;
  /** One glob per line. Blank, with no exclusions, means the claim does not seed. */
  seedPaths: string;
  /** One glob per line. */
  seedExclude: string;
}

/** What is wrong, by the field the editor shows it beside. */
export interface ClaimDraftErrors {
  general: string[];
  steps: string[];
  timeoutMinutes: string[];
  fingerprintPaths: string[];
  seedPaths: string[];
  seedExclude: string[];
  /** Keyed by step index. */
  argv: Record<number, string[]>;
  env: Record<number, string[]>;
}

export const DEFAULT_CLAIM_TIMEOUT_MINUTES = 10;

export function draftFromClaim(claim: WorktreeClaim | null): ClaimDraft {
  if (!claim) {
    return {
      steps: [],
      timeoutMinutes: String(DEFAULT_CLAIM_TIMEOUT_MINUTES),
      fingerprintPaths: "",
      seedPaths: "",
      seedExclude: "",
    };
  }
  return {
    steps: claim.steps.map((step) => ({ argv: step.argv.join("\n"), env: step.env.join(" ") })),
    timeoutMinutes: String(claim.timeoutMinutes),
    fingerprintPaths: claim.fingerprintPaths.join("\n"),
    seedPaths: claim.seed?.paths.join("\n") ?? "",
    seedExclude: claim.seed?.exclude.join("\n") ?? "",
  };
}

/** Lines exactly as typed, minus a Windows carriage return, with empty lines dropped. */
export function draftLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
}

export function draftNames(text: string): string[] {
  return text.split(/[\s,]+/).filter((name) => name.length > 0);
}

/**
 * The claim this draft describes, as the route will see it. Nothing is validated here: a
 * blank or non-numeric timeout is sent as typed so the route refuses it by its own rule.
 * Blank seed paths and exclusions leave `seed` out, which is a claim that never seeds. Any
 * other combination is sent as typed, so exclusions with no paths are refused by the route
 * rather than dropped here.
 */
export function claimFromDraft(draft: ClaimDraft): unknown {
  const typed = draft.timeoutMinutes.trim();
  const timeout = typed === "" ? Number.NaN : Number(typed);
  const seedPaths = draftLines(draft.seedPaths);
  const seedExclude = draftLines(draft.seedExclude);
  return {
    steps: draft.steps.map((step) => ({ argv: draftLines(step.argv), env: draftNames(step.env) })),
    timeoutMinutes: Number.isFinite(timeout) ? timeout : typed,
    fingerprintPaths: draftLines(draft.fingerprintPaths),
    ...(seedPaths.length > 0 || seedExclude.length > 0
      ? { seed: { paths: seedPaths, exclude: seedExclude } }
      : {}),
  };
}

export function emptyClaimErrors(): ClaimDraftErrors {
  return {
    general: [],
    steps: [],
    timeoutMinutes: [],
    fingerprintPaths: [],
    seedPaths: [],
    seedExclude: [],
    argv: {},
    env: {},
  };
}

/**
 * The errors once step `removed` is gone from the draft, re-indexed the way the step list is:
 * the removed step's own errors go with it, and every later step's move down one place, so a
 * refusal stays beside the field that caused it. Errors not tied to a step are unchanged.
 */
export function withoutStepErrors(errors: ClaimDraftErrors, removed: number): ClaimDraftErrors {
  const shift = (byStep: Record<number, string[]>): Record<number, string[]> => {
    const next: Record<number, string[]> = {};
    for (const [key, messages] of Object.entries(byStep)) {
      const index = Number(key);
      if (index < removed) next[index] = messages;
      else if (index > removed) next[index - 1] = messages;
    }
    return next;
  };
  return { ...errors, argv: shift(errors.argv), env: shift(errors.env) };
}

export function hasClaimErrors(errors: ClaimDraftErrors): boolean {
  return errors.general.length > 0 || hasClaimFieldErrors(errors);
}

/**
 * Whether any error belongs to a field the operator can fix. A refusal that names no field,
 * such as a request that never reached the daemon, has only general errors.
 */
export function hasClaimFieldErrors(errors: ClaimDraftErrors): boolean {
  return errors.steps.length > 0 ||
    errors.timeoutMinutes.length > 0 ||
    errors.fingerprintPaths.length > 0 ||
    errors.seedPaths.length > 0 ||
    errors.seedExclude.length > 0 ||
    Object.keys(errors.argv).length > 0 ||
    Object.keys(errors.env).length > 0;
}

interface SchemaIssue {
  path: Array<string | number>;
  message: string;
}

function schemaIssues(error: string): SchemaIssue[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(error);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const issues: SchemaIssue[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const { path, message } = entry as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== "string") return null;
    issues.push({
      path: path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
      message,
    });
  }
  return issues;
}

function push(map: Record<number, string[]>, index: number, message: string): void {
  (map[index] ??= []).push(message);
}

/**
 * Place a refusal from `PUT /api/worktrees/config` beside the claim fields it names. The route
 * answers a schema failure with Zod's issue list as its `error`; each issue's path runs through
 * the patch (`repositories`, the common directory, `claim`) to the field. An issue outside the
 * claim, or an error that is not an issue list at all, is shown as a general error.
 */
export function claimErrorsFrom(error: string, draft: ClaimDraft): ClaimDraftErrors {
  const errors = emptyClaimErrors();
  const issues = schemaIssues(error);
  if (!issues) {
    errors.general.push(error);
    return errors;
  }
  const claim = claimFromDraft(draft) as {
    steps: Array<{ argv: string[]; env: string[] }>;
    fingerprintPaths: string[];
    seed?: { paths: string[]; exclude: string[] };
  };
  for (const issue of issues) {
    const at = issue.path.indexOf("claim");
    const path = at >= 0 ? issue.path.slice(at + 1) : null;
    if (!path) {
      errors.general.push(issue.message);
      continue;
    }
    const [field, index, part, item] = path;
    if (field === "steps" && typeof index === "number") {
      if (part === "argv") {
        push(errors.argv, index, typeof item === "number"
          ? `Argument ${item + 1}: ${issue.message}`
          : issue.message);
      } else if (part === "env") {
        const name = typeof item === "number" ? claim.steps[index]?.env[item] : undefined;
        push(errors.env, index, name ? `${name}: ${issue.message}` : issue.message);
      } else {
        push(errors.argv, index, issue.message);
      }
    } else if (field === "steps") {
      errors.steps.push(issue.message);
    } else if (field === "timeoutMinutes") {
      errors.timeoutMinutes.push(issue.message);
    } else if (field === "fingerprintPaths") {
      const glob = typeof index === "number" ? claim.fingerprintPaths[index] : undefined;
      errors.fingerprintPaths.push(glob !== undefined ? `${glob}: ${issue.message}` : issue.message);
    } else if (field === "seed" && (index === "paths" || index === "exclude")) {
      const globs = index === "paths" ? claim.seed?.paths : claim.seed?.exclude;
      const glob = typeof part === "number" ? globs?.[part] : undefined;
      const message = glob !== undefined ? `${glob}: ${issue.message}` : issue.message;
      (index === "paths" ? errors.seedPaths : errors.seedExclude).push(message);
    } else if (field === "seed") {
      errors.seedPaths.push(issue.message);
    } else {
      errors.general.push(issue.message);
    }
  }
  return errors;
}
