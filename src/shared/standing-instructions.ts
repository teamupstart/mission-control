// Repository standing instructions - the operator's own words, held on THIS machine, sent
// to every session Mission Control opens into a given checkout.
//
// The gap this fills is the intersection nothing else covered: a rule that is specific to
// one repository AND specific to one operator's machine. `AGENTS.md` is per-repository and
// committed, so it reaches every teammate; Foreman's instructions are machine-local but
// global and never reach a session at all.
//
// Browser-safe, and deliberately so: the matching rule has exactly one implementation, and
// a settings panel that wanted to preview a match reads the same function the launch does
// rather than reimplementing longest-path-match in the browser.

/** Semantic ceiling for one repository's block, and for the machine-wide default. */
export const STANDING_INSTRUCTIONS_MAX_LENGTH = 8_000;

/** How many repository keys one operator may configure. */
export const STANDING_INSTRUCTIONS_MAX_REPOSITORIES = 200;

/** Longest key we will store, matching the path bound the rest of the app uses. */
export const STANDING_INSTRUCTIONS_MAX_KEY_LENGTH = 4_096;

/**
 * WHICH channel carried the text to an agent.
 *
 * A persisted, APPEND-ONLY vocabulary: it is written into
 * `session_standing_instructions.mechanism` at launch and read back by exact value for the
 * life of that row. Rename one and every historical row becomes unreadable.
 *
 * The values name a harness · runtime channel rather than a harness, because that is what
 * the fact is: the same text is a system-prompt append on `claude · terminal`, a
 * `systemPrompt.append` on `claude · sdk`, developer instructions on `codex · sdk`, and
 * ordinary turn-one prose on the two pairs with no channel of their own.
 */
export const STANDING_INSTRUCTIONS_MECHANISMS = [
  /** Nothing applies to this checkout, so nothing is carried. */
  "none",
  /** Composed into turn one, above the intent. The pairs with no out-of-band channel. */
  "prompt-prefix",
  /** `claude --append-system-prompt <value>`, one flag carrying one composed value. */
  "claude-append-system-prompt",
  /** The Agent SDK's `systemPrompt: { type: "preset", preset: "claude_code", append }`. */
  "claude-sdk-system-prompt-append",
  /** Codex app-server `thread/start` `developerInstructions`. */
  "codex-developer-instructions",
] as const;
export type StandingInstructionsMechanism = (typeof STANDING_INSTRUCTIONS_MECHANISMS)[number];

/** The stored document: a machine-wide default plus per-repository overrides. */
export interface StandingInstructionsConfig {
  default: string;
  repositories: Record<string, string>;
}

/** One repository's effective answer. The pure function's return, not the wire's. */
export interface ResolvedStandingInstructions {
  /** Effective text, "" when nothing applies. */
  text: string;
  /** Which stored key produced it, or null when the default did. */
  matchedKey: string | null;
  source: "repository" | "default" | "none";
}

/** One entry of provenance: the checkout that was matched, and the key that matched it. */
export interface StandingInstructionsSource {
  repoPath: string;
  matchedKey: string | null;
}

/**
 * What a session gets, composed.
 *
 * Returned by the resolved route for a launch that has not happened, and stored verbatim by
 * the launch snapshot for one that has - deliberately ONE type, so "what will be sent" and
 * "what was sent" render through the same component and cannot drift into two answers.
 */
export interface StandingInstructionsDelivery {
  /** The composed block exactly as it would be, or was, delivered. "" when nothing applies. */
  text: string;
  /** The channel that carries it for this harness · runtime pair. */
  mechanism: StandingInstructionsMechanism;
  /** One entry per contributing repository, in the launch manifest's order. */
  sources: StandingInstructionsSource[];
}

/** Drop a single trailing "/" (keeping bare "/") so "/repo/" and "/repo" compare equal. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Whether `repoPath` sits at, or inside, the stored key `root`.
 *
 * The BOUNDARY rule `src/shared/allowlist.ts` already defines for consent, applied to the
 * same question here rather than written a second time: `/repo-backup` must never match a
 * key of `/repo`, and a `startsWith` alone says it does.
 */
function withinKey(repoPath: string, root: string): boolean {
  const dir = stripTrailingSlash(repoPath);
  const r = stripTrailingSlash(root);
  return dir === r || dir.startsWith(`${r}/`);
}

/**
 * The effective standing instructions for one checkout.
 *
 * `repoPath`, not `repoRoot`, and the name is load-bearing. The argument is the CANONICAL
 * REPO-ROOTED PATH of the checkout being matched, which is a repository root only when the
 * operator named one. A session in `~/ws/mono/packages/api` has to be matched as
 * `~/ws/mono/packages/api`; hand this its repository root instead and `~/ws/mono` is the
 * only key that can ever match, which makes the longest-match rule below decorative. Every
 * caller gets the argument from `resolveRepoPath(cwd).path`.
 *
 * Longest matching key wins, so a monorepo package's rule beats the monorepo's.
 *
 * The empty-versus-absent distinction is the one to get right. A key present with `""`
 * resolves to `source: "repository"` and empty text - "send nothing here" - and MUST beat
 * the default; a key that is absent falls through to it. Collapse the two and clearing a
 * repository's box quietly reinstates the machine-wide text, which is the same trap
 * `foreman/instructions.ts` documents for its own stored-empty case.
 */
export function resolveStandingInstructions(
  config: StandingInstructionsConfig,
  repoPath: string | null,
): ResolvedStandingInstructions {
  const fallback = (): ResolvedStandingInstructions =>
    config.default.length > 0
      ? { text: config.default, matchedKey: null, source: "default" }
      : { text: "", matchedKey: null, source: "none" };

  if (!repoPath) return fallback();

  let best: string | null = null;
  for (const key of Object.keys(config.repositories)) {
    if (!withinKey(repoPath, key)) continue;
    if (best === null || stripTrailingSlash(key).length > stripTrailingSlash(best).length) {
      best = key;
    }
  }
  if (best === null) return fallback();

  const text = config.repositories[best] ?? "";
  return { text, matchedKey: best, source: "repository" };
}
