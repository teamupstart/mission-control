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
