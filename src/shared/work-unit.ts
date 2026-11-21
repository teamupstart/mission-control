/**
 * The work unit id: one id for one piece of work, shared by a plan task and the phase tasks
 * its session creates. See `docs/work-units.md`.
 *
 * This file is the only place the format and the four carrier names are spelled. Browser-safe:
 * no `node:` import, so minting (which needs `node:crypto`) lives in `src/server/work-unit.ts`.
 */

/**
 * `wu_` and a ULID: 48 bits of millisecond time and 80 random bits in Crockford base32,
 * 26 characters. Identical to Agent Platform's check, so an id that passes here passes there.
 */
export const WORK_UNIT_ID_PATTERN = /^wu_[0-9A-HJKMNP-TV-Z]{26}$/;

export const WORK_UNIT_ID_PREFIX = "wu_";

/** The environment variable an agent process reads its work unit from. */
export const WORK_UNIT_ENV_VAR = "WORK_UNIT_ID";
/** The HTTP header an MCP server receives it in. */
export const WORK_UNIT_HEADER = "x-work-unit-id";
/** The `params._meta` key on an MCP request. */
export const WORK_UNIT_META_KEY = "work_unit_id";
/** The span attribute on exported telemetry. */
export const WORK_UNIT_SPAN_ATTRIBUTE = "work_unit_id";

/** Crockford base32: no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
/** 2^48 - 1: the largest millisecond time ten characters can hold. */
const MAX_TIME = 281_474_976_710_655;

export function isWorkUnitId(value: unknown): value is string {
  return typeof value === "string" && WORK_UNIT_ID_PATTERN.test(value);
}

/**
 * The id for `timeMs` and ten random bytes. Pure, so a test can pin a known vector; the server
 * supplies the bytes.
 */
export function encodeWorkUnitId(timeMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
    throw new RangeError(`work unit time must be an integer from 0 to ${MAX_TIME}`);
  }
  if (random.length !== RANDOM_BYTES) {
    throw new RangeError(`work unit randomness must be ${RANDOM_BYTES} bytes`);
  }
  let time = "";
  let rest = timeMs;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  // 80 bits read five at a time, most significant first: sixteen characters.
  let entropy = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of random) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      entropy += CROCKFORD[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return `${WORK_UNIT_ID_PREFIX}${time}${entropy}`;
}

/**
 * Whether a session whose agent was started with `launched` would tag a task of `taskWorkUnit`
 * with the wrong work unit (decision D7). An agent's environment is fixed when it starts, so an
 * agent started with one work unit must not run a task of another: its MCP calls would carry
 * the first. An agent started with none takes any task. A task with no id yet is given a new one
 * when it is assigned, which is another work unit by construction.
 *
 * Not gated by the preview: it protects against an environment that is already set.
 */
/** What `TaskManager.assign` says when `launchWorkUnitConflicts` refuses an agent. */
export const WORK_UNIT_REUSE_REFUSAL =
  "that agent was started for another work unit, so its MCP calls would be tagged with it - dispatch this task to a new agent instead";

export function launchWorkUnitConflicts(launched: string | null | undefined, taskWorkUnit: string | null): boolean {
  return Boolean(launched) && launched !== taskWorkUnit;
}

/**
 * The work unit a session emits for `taskWorkUnit`: the id its agent was started with, while the
 * task has that same id, and otherwise none. Every reader with a task in hand uses this, so it
 * can never name a work unit the agent's environment does not carry.
 */
export function emittedWorkUnitId(launched: string | null | undefined, taskWorkUnit: string | null): string | null {
  return launched && launched === taskWorkUnit ? launched : null;
}

/**
 * `${WORK_UNIT_ID}` or `${WORK_UNIT_ID:-...}`, as the whole value: the reference the config guide
 * tells an MCP server owner to write for Claude Code (`docs/work-units.md`).
 */
const CLAUDE_REFERENCE = new RegExp(`^\\$\\{${WORK_UNIT_ENV_VAR}(?::-[^}]*)?\\}$`);

/**
 * Whether one header of an MCP config is the work unit reference: named `x-work-unit-id` in any
 * case, with a value that is only the reference. For Claude Code (`form: "claude"`) that value is
 * `${WORK_UNIT_ID}` or `${WORK_UNIT_ID:-...}`; for a Codex `env_http_headers` entry
 * (`form: "codex-env"`) it is the variable's name. A literal value an operator wrote is not the
 * reference.
 */
export function isWorkUnitHeaderReference(name: string, value: unknown, form: "claude" | "codex-env"): boolean {
  if (name.toLowerCase() !== WORK_UNIT_HEADER || typeof value !== "string") return false;
  return form === "claude" ? CLAUDE_REFERENCE.test(value) : value === WORK_UNIT_ENV_VAR;
}
