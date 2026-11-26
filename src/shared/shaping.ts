import { z } from "zod";
import { residentMcpLoopbackHost } from "./resident-mcp.ts";
import { holdsSecretShape } from "./secret-shapes.ts";
import { taskKindLaunchesHarness } from "./task.ts";
import { AGENT_TYPES, TASK_KINDS, type TaskKind } from "./types.ts";
import { boundedRecord, partialPatch } from "./zod-shapes.ts";
import {
  SHAPING_AUTH_KINDS,
  SHAPING_BUILTINS,
  SHAPING_LIFECYCLE_POINTS,
  SHAPING_ORIGINS,
  SHAPING_OUTCOMES,
  SHAPING_PROMPT_STATES,
  SHAPING_REFERENCE_KINDS,
  SHAPING_SIGN_IN_STATES,
  SHAPING_SIGN_IN_STORAGE,
  SHAPING_SKILL_STATES,
  SHAPING_STAGES,
  SHAPING_TRANSPORTS,
} from "./shaping-registry.ts";

/**
 * Task shaping: the one contract every shaper speaks, the stored config, and the pure logic
 * the daemon and the dashboard share. Browser-safe: no Node built-ins, and no wire-protocol module.
 *
 * `docs/task-shaping.md` is the author's guide and `docs/plans/task-shaping/plan.md` the
 * design. The rule that decides which shapers run lives in `resolveShapers` and nowhere else.
 */

export type ShapingStage = (typeof SHAPING_STAGES)[number];
export type ShapingTransportId = (typeof SHAPING_TRANSPORTS)[number];
export type ShapingBuiltinId = (typeof SHAPING_BUILTINS)[number]["id"];
export type ShapingOutcome = (typeof SHAPING_OUTCOMES)[number];
export type ShapingOrigin = (typeof SHAPING_ORIGINS)[number];
export type ShapingReferenceKind = (typeof SHAPING_REFERENCE_KINDS)[number];
export type ShapingLifecyclePoint = (typeof SHAPING_LIFECYCLE_POINTS)[number];
export type ShapingSkillState = (typeof SHAPING_SKILL_STATES)[number];
export type ShapingPromptState = (typeof SHAPING_PROMPT_STATES)[number];
export type ShapingAuthKind = (typeof SHAPING_AUTH_KINDS)[number];
export type ShapingSignInState = (typeof SHAPING_SIGN_IN_STATES)[number];
export type ShapingSignInStorage = (typeof SHAPING_SIGN_IN_STORAGE)[number];

export const SHAPING_PROTOCOL = 1;

const KIB = 1024;

/** Every fixed bound in one place. The configurable ones are `ShapingLimitsSchema`'s. */
export const SHAPING_LIMITS = {
  /** Registered shapers in `app_config.shaping`. */
  shapers: 32,
  /** One stored entry or one manifest, as JSON. */
  entryJsonBytes: 16 * KIB,
  /** Stored on or off choices, and the stored order, across registered and discovered ids. */
  choices: 128,
  /** One context entry, however much budget is left. */
  entryBytes: 16 * KIB,
  /** An entry with less room left than this is dropped rather than cut. */
  minEntryBytes: 1 * KIB,
  /** A repository summary handed to the selectors. FR-02 refuses a longer one. */
  summaryBytes: 4 * KIB,
  /** Entries one reply may carry. */
  replyEntries: 32,
  /** Notes one reply may carry. */
  replyNotes: 16,
  /**
   * Shaper calls in flight at once within a stage. A command call holds a process and three pipes,
   * so 32 repositories times 32 shapers must not open a thousand processes at once.
   */
  concurrentCalls: 16,
  /** Characters in one reply note. */
  replyNoteChars: 1000,
  /** Characters in an entry's id and title. */
  entryIdChars: 512,
  entryTitleChars: 512,
  /** Characters in an entry's path. */
  entryPathChars: 1024,
  /** Characters in one fact value, or in one item of a list-valued fact. */
  factValueChars: 1024,
  /** Text one reply may carry in any one string, before Mission Control applies its caps. */
  replyText: 256 * KIB,
  /** The bound on a reason recorded for an outcome. */
  reasonChars: 500,
  /** The bound on a version, declared or reported, and on the version recorded for a call. */
  versionChars: 256,
  /** Facts one repository may carry, and values in one list-valued fact. */
  facts: 64,
  /** Repositories one task may carry into a request. */
  repositories: 32,
  /** The operator's prompt as carried in a request. */
  taskChars: 1_000_000,
  /** Skills one route reply may carry, and skills one launch may announce (FR-04). */
  routedSkills: 10,
  /** Routed skills one launch's record keeps, whatever became of them. */
  recordedSkills: 32,
  /** Selected guidance ids one route request carries (D13). */
  guidanceIds: 32,
} as const;

/**
 * Set aside for "Skills for this task" before any context entry is allocated, while a router
 * applies, so guidance that fills the total cannot crowd every routed skill out. A launch whose
 * whole total is smaller reserves that total instead.
 */
export const SHAPING_SKILLS_RESERVE_BYTES = 3 * KIB;

/** Each configurable bound's default and ceiling (D8 and D9). */
export const SHAPING_LIMIT_RANGES = {
  timeoutMs: { min: 100, default: 5_000, max: 30_000 },
  deadlineMs: { min: 100, default: 10_000, max: 60_000 },
  maxBytes: { min: 1 * KIB, default: 16 * KIB, max: 64 * KIB },
  totalBytes: { min: 1 * KIB, default: 32 * KIB, max: 64 * KIB },
} as const;

// ---------------------------------------------------------------------------------------------
// Bytes

function codePointBytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** UTF-8 length, measured the way the budget is spent. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) bytes += codePointBytes(char.codePointAt(0)!);
  return bytes;
}

/** The longest prefix of at most `maxBytes` of UTF-8 that never ends inside a character. */
export function clipUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = codePointBytes(char.codePointAt(0)!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * At most `maxBytes`, cut at the last line boundary that fits. Text with no line boundary in
 * range is cut at a character boundary instead, so a long single line still contributes.
 */
export function cutAtLineBoundary(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  const clipped = clipUtf8(value, maxBytes);
  // The limit can land exactly on a line's end: then every line in `clipped` is whole.
  if (value[clipped.length] === "\n") return clipped;
  const newline = clipped.lastIndexOf("\n");
  return newline > 0 ? clipped.slice(0, newline) : clipped;
}

/** JSON with object keys sorted, so equal definitions hash and compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jsonBytesWithin(max: number) {
  return (value: unknown, ctx: z.RefinementCtx) => {
    if (utf8Length(JSON.stringify(value)) > max) {
      ctx.addIssue({ code: "custom", message: `A shaper definition is at most ${max / KIB} KiB of JSON.` });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Ids and references

/** The feature-flag id rule: kebab-case, at most 64 characters. */
export const ShaperIdSchema = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, {
  message: "A shaper id is lowercase kebab-case, at most 64 characters.",
});
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EnvNameSchema = z.string().max(128).regex(ENV_NAME, {
  message: "An environment variable name is letters, digits and underscores.",
});
const HeaderNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, {
  message: "A header name is an HTTP token.",
});

/**
 * The reference kinds that take an argument, written `{kind:ARG}`, with the argument each
 * accepts. Every other kind in `SHAPING_REFERENCE_KINDS` is written bare, `{kind}`, so a kind
 * appended to the registry is accepted here with no second list to update.
 */
const REFERENCE_ARGUMENTS: Partial<Record<ShapingReferenceKind, { pattern: RegExp; placeholder: string }>> = {
  env: { pattern: ENV_NAME, placeholder: "NAME" },
};

function isShapingReference(inner: string): boolean {
  return SHAPING_REFERENCE_KINDS.some((kind) => {
    const argument = REFERENCE_ARGUMENTS[kind];
    return argument
      ? inner.startsWith(`${kind}:`) && argument.pattern.test(inner.slice(kind.length + 1))
      : inner === kind;
  });
}

/** How each registered reference kind is written, for messages and documentation. */
export const SHAPING_REFERENCE_SPELLINGS: readonly string[] = SHAPING_REFERENCE_KINDS.map((kind) => {
  const argument = REFERENCE_ARGUMENTS[kind];
  return argument ? `{${kind}:${argument.placeholder}}` : `{${kind}}`;
});

/**
 * The references `value` names, in order, as `caller.user` or `env:NAME`. Null when its braces
 * do not spell only references `SHAPING_REFERENCE_KINDS` declares. Syntax only: nothing is
 * resolved here.
 */
export function shapingReferences(value: string): string[] | null {
  const references: string[] = [];
  const rest = value.replace(/\{([^{}]*)\}/g, (_token, inner: string) => {
    references.push(isShapingReference(inner) ? inner : "\u0000");
    return "";
  });
  if (references.includes("\u0000") || /[{}]/.test(rest)) return null;
  return references;
}

const HeaderValueSchema = z.string().max(4096)
  .refine((value) => !value.includes("\u0000") && !/[\r\n]/.test(value), { message: "A header value is one line." })
  .refine((value) => shapingReferences(value) !== null, {
    message: `A header value may only reference ${SHAPING_REFERENCE_SPELLINGS.slice(0, -1).join(", ")} or ${SHAPING_REFERENCE_SPELLINGS.at(-1)}.`,
  });
const HeadersSchema = boundedRecord(HeaderNameSchema, HeaderValueSchema, 32).default({});

const ArgSchema = z.string().max(4096).refine((value) => !value.includes("\u0000"), { message: "An argument cannot contain NUL." });
/**
 * An absolute path, a bare name resolved through the executable locator, or a `./` path inside
 * a discovered shaper's own folder. Never a shell string.
 */
const CommandSchema = z.string().min(1).max(1024).refine(
  (value) => !value.includes("\u0000")
    && (value.startsWith("/") || (value.startsWith("./") && !value.split("/").includes("..")) || /^[^\s/]+$/.test(value)),
  { message: "A command is an absolute path, a bare name, or a ./ path inside a shaper folder." },
);
const UrlSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, { message: "A URL is http or https." });

// ---------------------------------------------------------------------------------------------
// The sign-in marker

/** One scope token (RFC 6749 section 3.3): visible ASCII other than `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** Sent as written, so there is no default and no fallback to what the server advertises. */
const SignInScopeSchema = z.string().min(1).max(256).refine(
  (value) => value.split(" ").every((token) => SCOPE_TOKEN.test(token)),
  { message: "A scope is one or more scope tokens separated by single spaces. A token is visible ASCII with no \" and no \\." },
);

/** Why `value` cannot name an authorization server, or null. Form only: sign-in checks the metadata. */
function issuerProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "An issuer is a URL."; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && residentMcpLoopbackHost(url))) {
    return "An issuer is https, or plain http only to this machine's loopback.";
  }
  if (url.username || url.password) return "An issuer cannot carry a user name or password.";
  if (hasQueryString(value)) return "An issuer cannot carry a query string.";
  if (value.includes("#")) return "An issuer cannot carry a fragment.";
  return null;
}

const SignInIssuerSchema = z.string().max(2048).superRefine((value, ctx) => {
  const problem = issuerProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/**
 * The `auth` marker a remote server may carry (D7): the server needs a sign-in, made in
 * Settings > Task shaping, and the scope it asks for. It names no value: the token it leads to
 * lives in the Keychain or in memory, never in a definition. `issuer` names the authorization
 * server when it is not on the server's own origin (D6).
 */
const SignInMarkerSchema = z.strictObject({
  type: z.enum(SHAPING_AUTH_KINDS),
  scope: SignInScopeSchema,
  issuer: SignInIssuerSchema.optional(),
});

/** With a marker, the sign-in sets `Authorization`, so the definition cannot configure one too. */
function signInOwnsAuthorization(value: { headers: Record<string, string>; auth?: unknown }, ctx: z.RefinementCtx): void {
  if (value.auth === undefined) return;
  for (const name of Object.keys(value.headers)) {
    if (name.toLowerCase() !== "authorization") continue;
    ctx.addIssue({
      code: "custom", path: ["headers", name],
      message: "This server signs in, and the sign-in sets the authorization header, so the shaper cannot configure one. Remove it, or remove auth.",
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Shaper definitions

const CommandTransportSchema = z.strictObject({
  type: z.literal("command"),
  command: CommandSchema,
  args: z.array(ArgSchema).max(64).default([]),
  /** Variables passed through from the daemon's environment. The rest is scrubbed. */
  env: z.array(EnvNameSchema).max(32).default([]),
});

const McpServerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: CommandSchema,
    args: z.array(ArgSchema).max(64).default([]),
    env: z.array(EnvNameSchema).max(32).default([]),
  }),
  z.strictObject({ type: z.literal("http"), url: UrlSchema, headers: HeadersSchema, auth: SignInMarkerSchema.optional() })
    .superRefine(signInOwnsAuthorization),
]);

/**
 * How the complete collected input reaches an MCP tool. `folded` calls it with exactly FR-02's
 * three arguments and states the rest inside `task`; `argument` adds a fourth, `context`. There
 * is deliberately no value that withholds any of it (constraint C2).
 */
export const MCP_CONTEXT_DELIVERY = ["folded", "argument"] as const;

const McpTransportSchema = z.strictObject({
  type: z.literal("mcp"),
  server: McpServerSchema,
  tool: z.string().min(1).max(128),
  contextDelivery: z.enum(MCP_CONTEXT_DELIVERY).default("folded"),
});

const HttpTransportSchema = z.strictObject({
  type: z.literal("http"),
  url: UrlSchema,
  headers: HeadersSchema,
  auth: SignInMarkerSchema.optional(),
}).superRefine(signInOwnsAuthorization);

const RepoRelativePathSchema = z.string().min(1).max(1024)
  .refine((value) => !value.includes("\u0000"), { message: "A path cannot contain NUL." });

/** `repository-files` reads only what these name. Phase 6 implements the reading rules. */
export const RepositoryFilesOptionsSchema = z.strictObject({
  include: z.array(z.strictObject({
    path: RepoRelativePathSchema,
    maxBytes: z.number().int().min(1).max(SHAPING_LIMITS.entryBytes).default(SHAPING_LIMITS.entryBytes),
  })).max(16).default([]),
  summary: RepoRelativePathSchema.optional(),
  facts: RepoRelativePathSchema.optional(),
});

/** One schema per built-in id. A later built-in is one appended id and one option here. */
const BuiltinTransportSchema = z.discriminatedUnion("builtin", [
  z.strictObject({
    type: z.literal("builtin"),
    builtin: z.literal("repository-files" satisfies ShapingBuiltinId),
    options: RepositoryFilesOptionsSchema.prefault({}),
  }),
]);

export const ShaperTransportSchema = z.discriminatedUnion("type", [
  CommandTransportSchema,
  McpTransportSchema,
  HttpTransportSchema,
  BuiltinTransportSchema,
]);
export type ShaperTransport = z.output<typeof ShaperTransportSchema>;

function shaperFields<const Stages extends readonly [string, ...string[]]>(stages: Stages) {
  return {
    id: ShaperIdSchema,
    label: z.string().trim().min(1).max(120).refine((value) => !value.includes("\u0000"), { message: "A label cannot contain NUL." }),
    stage: z.enum(stages),
    protocol: z.literal(SHAPING_PROTOCOL).default(SHAPING_PROTOCOL),
    transport: ShaperTransportSchema,
    /**
     * Task kinds this shaper serves. Empty means every kind Mission Control launches a harness
     * worker for (`TASK_KIND_BEHAVIOR.launch` is `harness`). A resident launch is shaped only
     * when a shaper lists the resident kind explicitly.
     */
    kinds: z.array(z.string().min(1).max(64)).max(32).default([]),
    /** Repository names this shaper serves. Empty means every repository. */
    repositories: z.array(z.string().min(1).max(256)).max(64).default([]),
    /** This shaper's own call timeout. Absent means the config's default. */
    timeoutMs: z.number().int().min(SHAPING_LIMIT_RANGES.timeoutMs.min).max(SHAPING_LIMIT_RANGES.timeoutMs.max).optional(),
    /** This shaper's own share of the context budget. Absent means the config's default. */
    maxBytes: z.number().int().min(SHAPING_LIMIT_RANGES.maxBytes.min).max(SHAPING_LIMIT_RANGES.maxBytes.max).optional(),
    /** An optional content pin, sent as the request's `version`. */
    version: z.string().min(1).max(SHAPING_LIMITS.versionChars).nullable().default(null),
  };
}


// ---------------------------------------------------------------------------------------------
// Credentials are references, never stored text

const CREDENTIAL_NAME_SEGMENTS = new Set([
  "authorization", "auth", "token", "tokens", "secret", "secrets", "password", "passwd",
  "passphrase", "credential", "credentials", "key", "keys", "apikey", "cookie", "session",
  "signature", "sig",
]);

/**
 * Whether a header or query parameter name says it carries a credential: a segment such as
 * `authorization`, `token` or `key`, split on punctuation and camelCase, or a run-together
 * suffix such as `apitoken`.
 */
export function credentialBearingName(name: string): boolean {
  const segments = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return segments.some((segment) => CREDENTIAL_NAME_SEGMENTS.has(segment))
    || /(token|secret|password|passwd|apikey|credentials?)$/.test(name.toLowerCase());
}

/**
 * Whether a header looks like it carries a credential, the rule in `plan.md`: `authorization`,
 * `proxy-authorization` or `cookie`, or a name that contains `token`, `secret`, `key`,
 * `password`, `auth` or `credential`, compared without case. A name the segment rule above
 * recognises, such as `x-session`, counts as well. The rule goes by name, so a credential under
 * an innocent-looking name is not caught.
 */
export function credentialLookingHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "proxy-authorization" || lower === "cookie"
    || /token|secret|key|password|auth|credential/.test(lower)
    || credentialBearingName(name);
}

/**
 * The field the stored config sets on an entry it removed a literal credential from. Such an
 * entry is unsupported: never resolved, run or dry-run, until the operator registers a valid
 * replacement for its id.
 */
export const CREDENTIALS_REMOVED = "credentialsRemoved";

/** Whether the stored config removed a literal credential from this entry. */
export function credentialsWereRemoved(stored: StoredShaper): boolean {
  return (stored as Record<string, unknown>)[CREDENTIALS_REMOVED] === true;
}

/** Headers that carry an HTTP authentication scheme before their credential. */
const SCHEME_HEADERS = new Set(["authorization", "proxy-authorization"]);
/** The schemes such a header may name. Any other leading word is treated as the secret itself. */
export const SHAPING_AUTH_SCHEMES = ["Bearer", "Basic", "Token", "Digest"] as const;

/**
 * A credential-bearing value may hold its secret only as a reference, resolved at call time.
 * Empty is fine. Otherwise it is `{env:NAME}` references only, as `plan.md` requires. Only an
 * `Authorization` or `Proxy-Authorization` header may put a scheme before them, and only one of
 * `SHAPING_AUTH_SCHEMES`: any other leading word, such as a key prefix, is literal secret text.
 * The config holds no secret text, so no settings snapshot can carry one.
 */
export function credentialValueIsReferenced(name: string, value: string): boolean {
  if (value.trim() === "") return true;
  const shape = /^\s*(?:([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s+)?((?:\{[^{}]*\})+)\s*$/.exec(value);
  if (!shape) return false;
  const scheme = shape[1];
  if (scheme !== undefined) {
    if (!SCHEME_HEADERS.has(name.toLowerCase())) return false;
    if (!SHAPING_AUTH_SCHEMES.some((known) => known.toLowerCase() === scheme.toLowerCase())) return false;
  }
  const references = shapingReferences(shape[2]!);
  return references !== null && references.length > 0 && references.every((reference) => reference.startsWith("env:"));
}

/** Name segments that say an argument names where a credential lives, not the credential itself. */
const CREDENTIAL_LOCATOR_SEGMENTS = new Set(["file", "path", "dir", "name", "id", "url", "type", "env"]);

/** Whether a name says it locates a credential, such as `token_file` or `type`, not holds one. */
function credentialLocatorName(name: string): boolean {
  const segments = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return segments.some((segment) => CREDENTIAL_LOCATOR_SEGMENTS.has(segment));
}

function credentialArgumentName(name: string): boolean {
  return credentialBearingName(name) && !credentialLocatorName(name);
}

/**
 * The arguments that hand a credential over as literal text: `--token=abc`, `api_key=abc`, or a
 * credential flag such as `--api-key` followed by its value. Arguments are stored and backed up
 * as written and are never resolved, so a secret belongs in `env`, named, instead.
 */
/** Flags whose value is an HTTP header, as `Name: value` (curl's `-H`, `--header`). */
const HEADER_FLAGS = new Set(["H", "header", "proxy-header"]);
/** Flags whose value is a credential whatever it is called (curl's `--user`, `--oauth2-bearer`). */
const CREDENTIAL_VALUE_FLAGS = new Set(["user", "proxy-user", "oauth2-bearer", "basic-auth"]);
/** Short flags that take `user:password` (curl's `-u`, `-U`). Only a value with a colon counts. */
const USERINFO_FLAGS = new Set(["u", "U"]);
/**
 * Flags whose value is a request body: `name=value` fields or a JSON document (curl's `-d`,
 * `--data*`, `-F`, `--form`, `--json`).
 */
const FIELD_FLAGS = new Set(["d", "data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "F", "form", "form-string", "json"]);
/** Flags whose value is a cookie, which is a session credential (curl's `-b`, `--cookie`). */
const COOKIE_FLAGS = new Set(["b", "cookie"]);
/** Short flags that may carry their value attached, as in `-HAuthorization: x` or `-dtoken=x`. */
const ATTACHED_FLAGS = new Set(["H", "u", "U", "d", "F"]);
/**
 * curl's short options that take a value. curl reads a single-dash argument as a group of
 * short options: switches such as `-s` or `-v` come first, and the first option that takes a
 * value takes the rest of the argument, or the next argument when nothing is left. So
 * `-sH "Authorization: x"`, `-svuname:pass`, `-bsession=x` and `-xsocks5://user:pass@host` all
 * hand over a value. Only for curl, because for any other program `-backup=x` or `-sH` may be a
 * flag of its own, and reading it the way curl does would refuse it wrongly.
 */
const CURL_VALUE_SHORT_FLAGS = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz");
/**
 * curl's long options, among those this check judges, that take a value. curl gives such an
 * option the next argument whatever it looks like, so `--user -name:pass` and
 * `--header "-X-Api-Key: x"` hand over their value even though it starts with a dash.
 */
const CURL_VALUE_LONG_FLAGS = new Set([
  "header", "proxy-header", "user", "proxy-user", "oauth2-bearer", "pass", "proxy-pass",
  "data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "form", "form-string", "json",
  "cookie", "proxy", "preproxy", "url", "cert", "proxy-cert", "tlsuser", "proxy-tlsuser",
  "tlspassword", "proxy-tlspassword", "login-options", "sasl-authzid",
]);
/** curl's flags whose value is a secret whatever it is called: a private key's passphrase. */
const CURL_CREDENTIAL_VALUE_FLAGS = new Set(["pass", "proxy-pass"]);
/** curl's client-certificate flags, which take `file:password` (`-E`, `--cert`). */
const CURL_CERT_FLAGS = new Set(["E", "cert", "proxy-cert"]);

/** Whether a command names curl, by its file name, wherever it is installed. */
function isCurl(command: unknown): boolean {
  return typeof command === "string" && /(?:^|\/)curl$/.test(command);
}

/** A single-dash argument read the way curl reads it: a group of short options, see above. */
function curlShortGroup(args: readonly string[], index: number): { name: string; value?: string; at: number } {
  const body = args[index]!.slice(1);
  for (let at = 0; at < body.length; at++) {
    const letter = body[at]!;
    if (!CURL_VALUE_SHORT_FLAGS.has(letter)) continue;
    const rest = body.slice(at + 1);
    // curl takes the next argument as the value whatever it looks like, a leading dash included.
    return rest !== "" ? { name: letter, value: rest, at: index } : { name: letter, value: args[index + 1], at: index + 1 };
  }
  return { name: body, at: index };
}

/** One argument read as a flag: its name, and the value it carries and where, if any. */
function argumentParts(
  args: readonly string[], index: number, curl = false,
): { name: string; value?: string; at: number } | null {
  const arg = args[index]!;
  if (curl && arg.length > 1 && arg.startsWith("-") && !arg.startsWith("--")) return curlShortGroup(args, index);
  const next = args[index + 1];
  const following = next !== undefined && !next.startsWith("-") ? next : undefined;
  if (arg.startsWith("--")) {
    const body = arg.slice(2);
    // Split at the first "=" and judge the name alone: a value may hold anything, line breaks
    // included, and must not decide whether the argument is recognised.
    const equals = body.indexOf("=");
    if (equals > 0) return { name: body.slice(0, equals), value: body.slice(equals + 1), at: index };
    if (curl && CURL_VALUE_LONG_FLAGS.has(body)) return { name: body, value: next, at: index + 1 };
    return { name: body, value: following, at: index + 1 };
  }
  if (arg.startsWith("-") && arg.length > 1) {
    const body = arg.slice(1);
    // An attached short value comes first: `-HAuthorization: x`, `-uuser:pass`, `-dtoken=x`.
    // The letter is followed by text with a colon, an equals sign or a space.
    if (body.length > 1 && ATTACHED_FLAGS.has(body[0]!) && /[:=\s]/.test(body.slice(1))) {
      return { name: body[0]!, value: body.slice(1), at: index };
    }
    const equals = body.indexOf("=");
    if (equals > 0) return { name: body.slice(0, equals), value: body.slice(equals + 1), at: index };
    return { name: body, value: following, at: index + 1 };
  }
  const equals = arg.indexOf("=");
  if (equals > 0) return { name: arg.slice(0, equals), value: arg.slice(equals + 1), at: index };
  return null;
}

/** Whether a body is a JSON document, judged as one rather than as `name=value` fields. */
function looksLikeJson(text: string): boolean {
  const body = text.trim();
  return body.startsWith("{") || body.startsWith("[");
}

/**
 * Whether a JSON document names a credential field with a value, at any depth: `{"token":"x"}`,
 * `{"auth":{"password":"x"}}`, `[{"api_key":1}]`, `{"token":{"value":"x"}}`. An empty string,
 * null or a boolean is no secret.
 * Text shaped like JSON that does not parse is judged by its quoted keys instead, so a body curl
 * would still send cannot slip past by being slightly malformed.
 */
function jsonCarriesCredential(text: string): boolean {
  const body = text.trim();
  if (!looksLikeJson(body)) return false;
  try {
    // Only a gate: valid JSON is judged by its text below, every member occurrence included.
    JSON.parse(body);
  } catch {
    const keys = body.matchAll(/(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*:\s*(?!""|''|null\b|true\b|false\b)[^\s,}\]]/g);
    return Array.from(keys).some((match) => credentialArgumentName(match[2]!));
  }
  return jsonMembersCarryCredential(body);
}

/**
 * Whether valid JSON text gives a credential-named member a value, judged over the text itself
 * rather than over what `JSON.parse` builds: the parsed object keeps only the last of a
 * repeated key, so `{"token":"sk-1","token":""}` would look empty while the argument stored and
 * backed up still holds `sk-1`. Every occurrence of every member counts.
 *
 * Everything under a credential-named key is credential, `{"password":{"value":"x"}}`, except
 * what a locator name such as `type` or `env` holds: `{"auth":{"type":"bearer"}}` hands over
 * nothing. A non-empty string or a number is a secret; an empty string, null or a boolean is
 * not. Scanned with an explicit stack, so no nesting depth can overflow it, in one pass.
 */
function jsonMembersCarryCredential(text: string): boolean {
  type Frame = { object: boolean; credential: boolean; key: string | null };
  const stack: Frame[] = [];
  /** Whether a value in the current position sits under a credential. */
  const underCredential = (): boolean => {
    const frame = stack[stack.length - 1];
    if (!frame) return false;
    if (!frame.object) return frame.credential;
    const key = frame.key ?? "";
    return credentialArgumentName(key) || (frame.credential && !credentialLocatorName(key));
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "{" || char === "[") {
      stack.push({ object: char === "{", credential: underCredential(), key: null });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ",") {
      const frame = stack[stack.length - 1];
      if (frame?.object) frame.key = null;
    } else if (char === "\"") {
      let end = at + 1;
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      const decoded = JSON.parse(text.slice(at, end + 1)) as string;
      at = end;
      const frame = stack[stack.length - 1];
      if (frame?.object && frame.key === null) frame.key = decoded;
      else if (decoded.trim() !== "" && underCredential()) return true;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      while (at + 1 < text.length && /[0-9eE+.-]/.test(text[at + 1]!)) at++;
      if (underCredential()) return true;
    }
    // Whitespace, ":", true, false and null carry nothing.
  }
  return false;
}

/**
 * Whether a transport URL carries a query string, an empty one included. `URL.search` is empty
 * for a bare trailing `?`, but the separator is still part of what was written, so registration
 * and the stored config judge the raw text before any fragment the same way.
 */
function hasQueryString(raw: string): boolean {
  return raw.split("#", 1)[0]!.includes("?");
}

/** Whether `value` is a URL, of any scheme, that carries userinfo or a credential query parameter. */
/**
 * `value` without the leading and trailing C0 controls and spaces the URL parser strips, so a check
 * that inspects a URL's text sees what the parser will: "  https://user:pass@host" is a URL.
 */
export function trimUrlText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

function urlCarriesCredential(value: string): boolean {
  const trimmed = trimUrlText(value);
  // Any scheme: a proxy URL such as socks5://user:pass@host carries credentials as well as http.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return Boolean(url.username || url.password) || Array.from(url.searchParams.keys()).some(credentialBearingName);
  } catch {
    return false;
  }
}

/**
 * The arguments that hand a credential over as literal text. Arguments are stored and backed up
 * as written and are never resolved, so a secret belongs in `env`, named, instead. Recognised:
 * - a credential-named flag and its value, `--token=abc`, `api_key=abc`, `--api-key abc`;
 * - a header flag whose header carries a credential, `-H "Authorization: Bearer x"`, refused
 *   whatever the value, since an argument's `{env:NAME}` would never be resolved;
 * - a credential flag such as `--user name:pass` or `--oauth2-bearer x`, and `-u name:pass`;
 * - a data or form field named as a credential, `-d token=x`, `--form password=x`, and a JSON
 *   body, or a field holding one, that names one, `--json '{"token":"x"}'`;
 * - a cookie, `-b session=x`;
 * - for curl, any of these as a short option grouped after switches, `-sH "Authorization: x"`,
 *   `-svuname:pass`, `-bsession=x`, `-xsocks5://user:pass@host`, read as curl reads them, and
 *   as a long option's next argument even when it starts with a dash, `--user -name:pass`;
 * - for curl, a key passphrase, `--pass x`, and a certificate password, `--cert file:x`, `-E file:x`;
 * - a URL with a user name, a password or a credential query parameter, alone or as a value;
 * - any argument, positional ones included, that holds a well-known credential's shape, such
 *   as a GitHub, AWS, Slack or OpenAI token or a private key header. A bare value that matches
 *   no known shape cannot be told apart from configuration and stays the operator's to name in
 *   `env`.
 */
function literalCredentialArguments(args: readonly string[], command?: unknown): number[] {
  const found = new Set<number>();
  const curl = isCurl(command);
  args.forEach((arg, index) => {
    if (urlCarriesCredential(arg) || holdsSecretShape(arg)) found.add(index);
    const parts = argumentParts(args, index, curl);
    if (!parts || parts.value === undefined || parts.value === "") return;
    const name = parts.name;
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) return;
    if (urlCarriesCredential(parts.value)) { found.add(parts.at); return; }
    if (FIELD_FLAGS.has(name)) {
      if (looksLikeJson(parts.value)) { if (jsonCarriesCredential(parts.value)) found.add(parts.at); return; }
      const fields = parts.value.split("&").map((field) => {
        const equals = field.indexOf("=");
        return equals < 0 ? { name: field.trim(), value: "" } : { name: field.slice(0, equals).trim(), value: field.slice(equals + 1) };
      });
      if (fields.some((field) => (field.name !== "" && credentialArgumentName(field.name)) || jsonCarriesCredential(field.value))) {
        found.add(parts.at);
      }
      return;
    }
    if (COOKIE_FLAGS.has(name)) { if (parts.value.includes("=")) found.add(parts.at); return; }
    if (HEADER_FLAGS.has(name)) {
      const header = parts.value.split(":")[0]!.trim();
      if (header && credentialLookingHeader(header)) found.add(parts.at);
      return;
    }
    if (curl && CURL_CERT_FLAGS.has(name)) {
      // `file:password`, where a PKCS#11 URI's own colon is no password.
      if (/:/.test(parts.value) && !/^pkcs11:/i.test(parts.value)) found.add(parts.at);
      return;
    }
    if (CREDENTIAL_VALUE_FLAGS.has(name) || (curl && CURL_CREDENTIAL_VALUE_FLAGS.has(name))) found.add(parts.at);
    else if (USERINFO_FLAGS.has(name)) { if (parts.value.includes(":")) found.add(parts.at); }
    else if (credentialArgumentName(name)) found.add(parts.at);
  });
  return [...found].sort((a, b) => a - b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The same entry with every literal credential emptied: a credential-bearing header value that
 * is not a reference, a transport URL's userinfo and its whole query string, and a credential
 * argument. The query goes whole, even from an entry this build cannot run: `plan.md` allows a
 * transport URL no query string, so this build cannot tell which parameter of one holds a
 * secret, and a parameter it does not recognise is treated as one. Such an entry is marked
 * removed, and its replacement names the secret as `{env:NAME}` in a header. A definition this build writes can hold none of these, because the strict schema
 * refuses them. This covers everything else the config may be handed - a settings restore, or
 * an entry a newer build stored - so no path leaves secret text in `app_config.shaping` or in
 * the `shaping` domain of a snapshot. Every other field is kept exactly as written, unless the
 * marked entry would no longer fit `SHAPING_LIMITS.entryJsonBytes`: then only its id, label,
 * stage and transport type are kept, so the result always parses again.
 */
export function withoutLiteralCredentials(stored: StoredShaper): StoredShaper {
  const transport = stored.transport as Record<string, unknown>;
  const fromServer = transport.type === "mcp" && isRecord(transport.server);
  const holder = { ...(fromServer ? transport.server as Record<string, unknown> : transport) };
  let changed = false;
  if (isRecord(holder.headers)) {
    const headers: Record<string, unknown> = { ...holder.headers };
    for (const [name, value] of Object.entries(headers)) {
      if (credentialLookingHeader(name) && !(typeof value === "string" && credentialValueIsReferenced(name, value))) {
        headers[name] = "";
        changed = true;
      }
    }
    holder.headers = headers;
  }
  if (typeof holder.url === "string") {
    try {
      const url = new URL(holder.url);
      const before = url.href;
      url.username = "";
      url.password = "";
      // A transport URL carries no query string at all, as `plan.md` requires.
      url.search = "";
      if (url.href !== before) {
        holder.url = url.href;
        changed = true;
      }
    } catch {
      // Not a URL this build can read; there is nothing to recognise in it.
    }
  }
  if (Array.isArray(holder.args)) {
    const args = holder.args.map((arg) => (typeof arg === "string" ? arg : ""));
    const literal = new Set(literalCredentialArguments(args, holder.command));
    if (literal.size > 0) {
      holder.args = holder.args.map((arg, index) => (literal.has(index) ? "" : arg));
      changed = true;
    }
  }
  if (!changed) return stored;
  const nextTransport = fromServer ? { ...transport, server: holder } : { ...transport, ...holder };
  // Marked, because the definition no longer says what its author wrote: an emptied argument or
  // header would otherwise run with changed meaning. It stays unsupported until replaced.
  const stripped = { ...stored, transport: nextTransport as StoredShaper["transport"], [CREDENTIALS_REMOVED]: true };
  if (utf8Length(JSON.stringify(stripped)) <= SHAPING_LIMITS.entryJsonBytes) return stripped;
  // The mark, or a URL this build re-serialised, pushed an entry that was at the limit past it,
  // and the next parse of the config would refuse it. Keep only what identifies the entry: it
  // is unsupported either way, and its replacement is a whole new definition.
  return {
    id: stored.id, label: stored.label, stage: stored.stage,
    transport: { type: stored.transport.type } as StoredShaper["transport"], [CREDENTIALS_REMOVED]: true,
  } as StoredShaper;
}

/** The credential rule over a whole definition's headers, URLs and arguments. */
function credentialsAreReferences(value: unknown, ctx: z.RefinementCtx): void {
  const transport = (value as { transport?: Record<string, unknown> }).transport;
  if (!transport) return;
  const server = transport.type === "mcp" ? transport.server as Record<string, unknown> | undefined : undefined;
  const at = server ? ["transport", "server"] : ["transport"];
  const holder = server ?? transport;
  const args = Array.isArray(holder.args) ? holder.args.filter((arg): arg is string => typeof arg === "string") : [];
  for (const index of literalCredentialArguments(args, holder.command)) {
    ctx.addIssue({
      code: "custom", path: [...at, "args", index],
      message: "This argument hands over a credential as literal text, which would be stored and backed up. Name the variable in env instead, so the secret is passed from the daemon's environment.",
    });
  }
  const headers = (holder.headers ?? {}) as Record<string, string>;
  for (const [name, header] of Object.entries(headers)) {
    if (credentialLookingHeader(name) && !credentialValueIsReferenced(name, header)) {
      ctx.addIssue({
        code: "custom", path: [...at, "headers", name],
        message: `The "${name}" header carries a credential, so its secret must be a reference such as {env:NAME}, never literal text. It is resolved at call time and never stored or backed up.`,
      });
    }
  }
  if (typeof holder.url !== "string") return;
  let url: URL;
  try { url = new URL(holder.url); } catch { return; }
  if (url.username || url.password) {
    ctx.addIssue({ code: "custom", path: [...at, "url"], message: "A URL cannot carry a user name or password. Send a credential in a header as {env:NAME}." });
  }
  if (hasQueryString(holder.url)) {
    ctx.addIssue({
      code: "custom", path: [...at, "url"],
      message: "A URL cannot carry a query string, which may hold a credential that would be stored and backed up. Send a credential in a header as {env:NAME}.",
    });
  }
}

/** A built-in runs only at a stage its registry entry declares, such as `repository-files` at gather. */
function builtinStageDeclared(value: unknown, ctx: z.RefinementCtx): void {
  const { stage, transport } = value as { stage?: unknown; transport?: { type?: unknown; builtin?: unknown } };
  if (transport?.type !== "builtin") return;
  const declared = SHAPING_BUILTINS.find((builtin) => builtin.id === transport.builtin);
  if (declared && !(declared.stages as readonly string[]).includes(String(stage))) {
    ctx.addIssue({
      code: "custom", path: ["stage"],
      message: `This built-in runs only at the ${declared.stages.join(" or ")} stage.`,
    });
  }
}

/**
 * A registered shaper has no folder, so a `./` command has nothing to resolve against and could
 * never run. Only a manifest in the shapers folder may name one.
 */
function registeredCommandResolvable(value: unknown, ctx: z.RefinementCtx): void {
  const transport = (value as { transport?: Record<string, unknown> }).transport;
  const server = transport?.type === "mcp" ? transport.server as Record<string, unknown> | undefined : undefined;
  const holder = server?.type === "stdio" ? server : transport?.type === "command" ? transport : undefined;
  if (typeof holder?.command === "string" && holder.command.startsWith("./")) {
    ctx.addIssue({
      code: "custom", path: server ? ["transport", "server", "command"] : ["transport", "command"],
      message: "A registered shaper has no folder to resolve a ./ command against. Use an absolute path or a command name; only a shaper in the shapers folder may use ./.",
    });
  }
}

const ShaperObjectSchema = z.strictObject(shaperFields(SHAPING_STAGES));

/** The strict definition this build understands. Stored entries are checked against it. */
export const ShaperSchema = ShaperObjectSchema
  .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
  .superRefine(credentialsAreReferences)
  .superRefine(builtinStageDeclared)
  .superRefine(registeredCommandResolvable);
export type Shaper = z.output<typeof ShaperSchema>;

/**
 * What one sign-in covers, a connection: the server's URL, the scope and the authorization
 * server the marker names, `issuer` null when it names none. Two shapers with the same three
 * values share one sign-in.
 */
export interface SignInTarget {
  url: string;
  scope: string;
  issuer: string | null;
}

/**
 * The connection a shaper's `auth` marker names, or null for a shaper with no marker. The one
 * reader of a shaper's sign-in target: the transports, the sign-in service and Settings all ask
 * here.
 */
export function shaperSignInTarget(shaper: Shaper): SignInTarget | null {
  const transport = shaper.transport;
  const remote = transport.type === "http" ? transport
    : transport.type === "mcp" && transport.server.type === "http" ? transport.server
      : null;
  if (!remote?.auth) return null;
  return { url: remote.url, scope: remote.auth.scope, issuer: remote.auth.issuer ?? null };
}

/**
 * One connection's sign-in as it leaves the daemon. It never holds a token, a code, a `state`,
 * a verifier or an authorization URL.
 */
export interface ShapingSignInView {
  /** The connection id the daemon derives from the target. */
  id: string;
  url: string;
  scope: string;
  issuer: string | null;
  state: ShapingSignInState;
  storage: ShapingSignInStorage;
  /** Epoch milliseconds when the access token expires, or null when none is held. */
  expiresAt: number | null;
  /**
   * While `state` is `pending`, which attempt is pending: the `attempt` of the
   * `POST /api/shaping/sign-in` reply that started it. Null otherwise. No two attempts of one
   * daemon share one, so a sign-in that replaces a pending one changes it. A restarted daemon
   * counts from a new random point, which makes repeating an earlier daemon's number very
   * unlikely but not impossible. A plain number, not a secret: it opens nothing and the callback
   * never reads it.
   */
  attempt: number | null;
  /** One of `SIGN_IN_REASONS`, or null when there is nothing to say. */
  reason: string | null;
  /** The ids of the known shapers that name this connection. Empty for an unused one. */
  shapers: string[];
}

/**
 * Why a shaper that signs in was not called. Fixed sentences: a reason is shown as written and
 * never names a value. Each points to Settings > Task shaping, where the sign-in is made.
 */
export const SIGN_IN_REASONS = Object.freeze({
  flagOff: "This shaper signs in to its server, and the Shaper sign-in feature flag (shaper-sign-in) is off, so it was not called. Turn the flag on, then sign in at Settings > Task shaping.",
  signedOut: "This shaper is not signed in to its server, so it was not called. Sign in at Settings > Task shaping.",
  renewing: "This shaper's sign-in is being renewed, so it was not called. If it does not recover, sign in again at Settings > Task shaping.",
  refused: "This shaper's server refused its sign-in, so its reply was not used. The sign-in is being renewed; if it does not recover, sign in again at Settings > Task shaping.",
  memoryOnly: "This sign-in could not be saved, so it is kept in memory only and a restart will need a new sign-in at Settings > Task shaping.",
  signInAgain: "The authorization server ended this sign-in, so this shaper is not called until you sign in again at Settings > Task shaping.",
} as const);
export type SignInReason = keyof typeof SIGN_IN_REASONS;

/** The most client registrations `app_config` key `shaping.signIn` keeps. */
export const SHAPING_SIGN_IN_CLIENTS = 16;

/**
 * One dynamic registration Mission Control made with an authorization server: a public client,
 * reused only by a sign-in with the same issuer, redirect URI and scope. Not a secret.
 */
export const ShapingSignInClientSchema = z.strictObject({
  issuer: z.string().min(1).max(2048),
  clientId: z.string().min(1).max(1024),
  redirectUri: z.string().min(1).max(2048),
  scope: z.string().min(1).max(256),
  registeredAt: z.number().nonnegative(),
});
export type ShapingSignInClient = z.output<typeof ShapingSignInClientSchema>;

/**
 * `app_config.shaping.signIn`: the client registrations the sign-in service keeps, at most
 * `SHAPING_SIGN_IN_CLIENTS`. Its own key, because `ShapingConfigSchema` drops unknown keys and
 * an older build would delete it on its next write. It holds no token.
 */
export const ShapingSignInConfigSchema = z.object({
  clients: z.array(ShapingSignInClientSchema).max(SHAPING_SIGN_IN_CLIENTS).default([]),
}).prefault({});
export type ShapingSignInConfig = z.output<typeof ShapingSignInConfigSchema>;

/**
 * A manifest in the shapers folder: the strict definition plus whether it starts switched on.
 * Unlike a registered shaper it may name a `./` command, resolved against its own folder.
 */
export const ShaperManifestSchema = ShaperObjectSchema
  .extend({ enabled: z.boolean().optional() })
  .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
  .superRefine(credentialsAreReferences)
  .superRefine(builtinStageDeclared);
export type ShaperManifest = z.output<typeof ShaperManifestSchema>;

/**
 * A discovered shaper's definition, as the resolver reads a manifest once its own fields are
 * stripped: the strict definition, where a `./` command resolves against the manifest's folder.
 */
export const DiscoveredDefinitionSchema = ShaperObjectSchema
  .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
  .superRefine(credentialsAreReferences)
  .superRefine(builtinStageDeclared);

/**
 * The strict definition over a different stage tuple, so a test can model another build. The
 * discovered variant leaves out the registered-only `./` rule, as `DiscoveredDefinitionSchema` does.
 */
export function shaperSchemaForStages(stages: readonly [string, ...string[]], options: { discovered?: boolean } = {}): z.ZodType<Shaper> {
  const schema = z.strictObject(shaperFields(stages))
    .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
    .superRefine(credentialsAreReferences)
    .superRefine(builtinStageDeclared);
  return (options.discovered ? schema : schema.superRefine(registeredCommandResolvable)) as unknown as z.ZodType<Shaper>;
}

/** What a pure function reads from the registry. Tests pass their own. */
export interface ShapingDefinitions {
  readonly stages: readonly string[];
  /** A registered shaper's definition. */
  readonly shaper: z.ZodType<Shaper>;
  /** A discovered shaper's definition. Absent, the registered one is used. */
  readonly discovered?: z.ZodType<Shaper>;
}
export const SHAPING_DEFINITIONS: ShapingDefinitions = Object.freeze({
  stages: SHAPING_STAGES, shaper: ShaperSchema, discovered: DiscoveredDefinitionSchema as unknown as z.ZodType<Shaper>,
});

/** Bounded JSON, for the fields of a stored entry this build may not understand. */
export const ShapingJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(SHAPING_LIMITS.entryJsonBytes),
  z.array(ShapingJsonValueSchema).max(256),
  boundedRecord(z.string().max(256), ShapingJsonValueSchema, 256),
]));

/** How deeply a stored entry may nest, checked before anything recursive reads it. */
export const SHAPING_MAX_NESTING = 32;

/**
 * Whether `value` nests no deeper than `max`, walked with an explicit stack: the point is to
 * answer before a recursive validator could exhaust the call stack on a crafted entry.
 */
export function nestsWithin(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (depth >= max) return false;
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1]);
  }
  return true;
}

const StoredShaperObjectSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(200),
  stage: z.string().min(1).max(64),
  transport: z.object({ type: z.string().min(1).max(64) }).catchall(ShapingJsonValueSchema),
}).catchall(ShapingJsonValueSchema).superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes));

/**
 * The envelope `app_config.shaping` stores. A stage or transport id this build has never heard
 * of is valid here, so one such entry invalidates neither the config nor any other shaper.
 * Every field beyond the four named ones is kept exactly as it was written.
 *
 * Its nesting is checked first: a deeply nested field that fits in 16 KiB is refused as a
 * validation error, so a config read takes the store's unreadable-config path instead of
 * throwing out of a recursive parse.
 */
export const StoredShaperSchema = z.unknown().superRefine((value, ctx) => {
  if (!nestsWithin(value, SHAPING_MAX_NESTING)) {
    ctx.addIssue({ code: "custom", message: `A shaper definition nests at most ${SHAPING_MAX_NESTING} levels deep.` });
  }
}).pipe(StoredShaperObjectSchema);
export type StoredShaper = z.output<typeof StoredShaperSchema>;

export type ClassifiedShaper =
  | { kind: "known"; stored: StoredShaper; shaper: Shaper }
  | { kind: "unsupported"; stored: StoredShaper; reason: string };

function issueSentence(error: z.ZodError, maxChars: number = SHAPING_LIMITS.reasonChars): string {
  const issue = error.issues[0];
  if (!issue) return "The definition is not valid.";
  const at = issue.path.length ? `${issue.path.join(".")}: ` : "";
  // Zod names an unrecognised key in its message, and a key is whatever the entry's writer
  // chose, a credential-shaped one included. The reason leaves the daemon in the config view,
  // so it names where the field is, never the key itself.
  const message = issue.code === "unrecognized_keys"
    ? "This build does not recognise a field this entry names."
    : issue.message;
  return `${at}${message}`.slice(0, maxChars);
}

/**
 * A schema failure as one sentence that names where the problem is and never a value, for a
 * manifest in the shapers folder as for a stored entry.
 */
export function describeShapingIssue(error: z.ZodError): string {
  return issueSentence(error);
}

/** A known shaper, or an unsupported entry with the reason this build cannot run it. */
export function classifyShaper(
  stored: StoredShaper,
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ClassifiedShaper {
  if (credentialsWereRemoved(stored)) {
    return {
      kind: "unsupported", stored,
      reason: "A literal credential was removed from this shaper's definition when it was stored, so it no longer runs as written. Register a replacement that names the secret as {env:NAME}.",
    };
  }
  if (!definitions.stages.includes(stored.stage)) {
    return { kind: "unsupported", stored, reason: "stage: This build does not support the stage this entry names." };
  }
  if (!(SHAPING_TRANSPORTS as readonly string[]).includes(stored.transport.type)) {
    return { kind: "unsupported", stored, reason: "transport.type: This build does not support the transport this entry names." };
  }
  const parsed = definitions.shaper.safeParse(stored);
  return parsed.success
    ? { kind: "known", stored, shaper: parsed.data }
    : { kind: "unsupported", stored, reason: issueSentence(parsed.error) };
}

/** Every stored entry, classified. A repeated id is unsupported: the first entry owns the id. */
export function classifyShapers(
  config: ShapingConfig,
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ClassifiedShaper[] {
  const seen = new Set<string>();
  return config.shapers.map((stored) => {
    if (seen.has(stored.id)) return { kind: "unsupported", stored, reason: `Another stored shaper already has the id "${stored.id}".` };
    seen.add(stored.id);
    return classifyShaper(stored, definitions);
  });
}

/** An entry this build cannot run, as it may leave the daemon: never its raw envelope. */
export interface UnsupportedShaperView {
  id: string;
  label: string;
  /** Why, naming the failing field and never a stored value. */
  unsupported: string;
  /**
   * Present, and true, only when an import under this id replaces the entry: the daemon's own
   * upsert rule, which accepts a replacement for an entry it emptied a literal credential in and
   * refuses one for any other entry this build cannot run.
   */
  replaceable?: true;
}

/** The config as it leaves the daemon: the HTTP reply, and Phase 3's snapshot field and event. */
export type ShapingConfigView = Omit<ShapingConfig, "shapers"> & {
  shapers: Array<Shaper | UnsupportedShaperView>;
  /**
   * Each registered id's revision, derived by the daemon's keyed `ShapingReviser` from every definition stored
   * under it. A window sends it back as `expect` with an intent that acts on a shaper it showed.
   * Opaque to the browser: two stored definitions that look the same in the view - an unsupported
   * entry's id, label and reason, say - still have different revisions.
   */
  revisions: Record<string, string>;
  /**
   * The daemon process that published this view, random per process. A window sends it back with
   * each write (`SHAPING_WRITE_ORDER_HEADER`), so a write made against a daemon that has since
   * restarted, whose ordering it no longer holds, is refused rather than applied out of order.
   * Absent from a view a daemon older than it sends.
   */
  instance?: string;
  /**
   * The commit of the daemon process `instance` names that this view shows: it grows with every
   * commit that changes the view, by any writer. A write's answer carries the commit it made, so
   * a window can tell when the event stream has reached it, or gone past it. Absent from a view a
   * daemon older than it sends.
   */
  commit?: number;
};

/**
 * The config view: known shapers in full, and each unsupported entry reduced to its id, label
 * and reason. The raw envelope of an entry this build cannot run may hold anything a newer
 * build or a foreign snapshot wrote, so it stays in the daemon's storage and its settings
 * backup and never leaves the daemon otherwise.
 */
export function shapingConfigView(
  config: ShapingConfig,
  revise: ShapingReviser,
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ShapingConfigView {
  const classified = classifyShapers(config, definitions);
  // One revision per id, over every entry stored under it: the first owns the id and a repeat has
  // no row of its own to act on, but removing the owner removes the repeats too. Grouped in a
  // Map, never by probing a plain object: an id such as `constructor` would find the object's
  // inherited property.
  const groups = new Map<string, StoredShaper[]>();
  for (const entry of classified) {
    const group = groups.get(entry.stored.id);
    if (group) group.push(entry.stored);
    else groups.set(entry.stored.id, [entry.stored]);
  }
  const owned = new Map([...groups].map(([id, entries]) => [id, revise(entries)] as const));
  return {
    ...config,
    shapers: classified.map((entry) => entry.kind === "known"
      ? entry.shaper
      : {
        id: entry.stored.id, label: entry.stored.label, unsupported: entry.reason,
        // The upsert rule is the owning entry's: an import under an id replaces the first stored
        // entry with it, so only that one may say it is replaceable, never a repeat behind it.
        ...(groups.get(entry.stored.id)![0] === entry.stored && credentialsWereRemoved(entry.stored)
          ? { replaceable: true as const } : {}),
      }),
    revisions: Object.fromEntries(owned),
  };
}

/**
 * The revision a config view reports for `id`, or null when it reports none. Only an own,
 * string-valued entry counts, so an id that names an inherited property, such as `constructor`,
 * never reads a function that JSON would drop from the intent that carries it.
 */
export function shapingViewRevision(view: { readonly revisions?: unknown }, id: string): string | null {
  if (!shapingViewHasRevisions(view) || !Object.hasOwn(view.revisions, id)) return null;
  const revision: unknown = view.revisions[id];
  return typeof revision === "string" ? revision : null;
}

/**
 * Whether a view carries the daemon's revision map. An open dashboard can meet one that does not:
 * a daemon rolled back to a build older than the dashboard sends its view without one. Every
 * reader asks this first, and an action bound to a revision is unavailable until one arrives.
 */
export function shapingViewHasRevisions(view: { readonly revisions?: unknown }): view is { revisions: Record<string, unknown> } {
  const map = view.revisions;
  return typeof map === "object" && map !== null && !Array.isArray(map);
}

/**
 * Derives the revision of everything stored under one id, given those entries in stored order.
 * Only the daemon holds one (`src/server/shaping/revisions.ts`): it is keyed with a secret of the
 * daemon's, so a revision published in the view can be compared but never recomputed, and so
 * cannot confirm a guess at a field the view hides. Any change to what is stored under the id -
 * a field the view never shows, or a repeat - changes it. The daemon refuses an intent whose
 * `expect` no longer matches, so a click never acts on a replacement written meanwhile.
 */
export type ShapingReviser = (entries: readonly StoredShaper[]) => string;

/** The revision of every stored entry with this id, or null when none is stored. */
export function registeredShaperRevision(config: ShapingConfig, id: string, revise: ShapingReviser): string | null {
  const entries = config.shapers.filter((stored) => stored.id === id);
  return entries.length > 0 ? revise(entries) : null;
}

/** What moving one shaper within its stage comes to: the order to store, or why it cannot be. */
export type ShapingMoveResult = { ok: true; order: string[] } | { ok: false; reason: string };

/**
 * The stored order after placing `id` right after `after` (or first, for null) among `rows`, its
 * stage's rows in their current run order. Idempotent: placing a shaper where it already is
 * changes nothing, so a repeated or late intent never moves it twice.
 *
 * The rows already listed in `order` keep their slots, filled with the rows in their new
 * sequence, and the rest follow after every stored id. Every other id - another stage's, or a
 * shaper the rows do not include - keeps its slot, so nothing outside the move changes place.
 *
 * The stored order holds at most `SHAPING_LIMITS.choices` ids. When the move would pass that,
 * stored ids `keep` says place nothing are left out, the oldest kept first. Without `keep`, or
 * when the order still cannot fit, the move is refused with the reason.
 */
export function moveInShapingOrder(input: {
  rows: readonly string[];
  order: readonly string[];
  id: string;
  after: string | null;
  keep?: (id: string) => boolean;
}): ShapingMoveResult {
  const { rows, id, after, keep } = input;
  const others = rows.filter((row) => row !== id);
  const at = after === null ? 0 : others.indexOf(after) + 1;
  const sequence = [...others.slice(0, at), id, ...others.slice(at)];
  const members = new Set(sequence);
  const order = [...new Set(input.order)];
  let next = 0;
  const filled = order.map((stored) => (members.has(stored) ? sequence[next++]! : stored));
  const result = [...filled, ...sequence.slice(next)];
  const limit = SHAPING_LIMITS.choices;
  if (result.length <= limit) return { ok: true, order: result };
  const full = `The stored run order is full: it holds at most ${limit} shaper ids.`;
  if (!keep) return { ok: false, reason: full };
  const needed = result.filter((stored) => members.has(stored) || keep(stored)).length;
  let room = limit - needed;
  if (room < 0) return { ok: false, reason: `${full} This move needs ${needed}.` };
  return { ok: true, order: result.filter((stored) => members.has(stored) || keep(stored) || room-- > 0) };
}

/** Whether a shaper may be sent local paths: it runs on this machine, as the operator. */
export function shaperIsLocal(shaper: Shaper): boolean {
  switch (shaper.transport.type) {
    case "command":
    case "builtin":
      return true;
    case "mcp":
      return shaper.transport.server.type === "stdio";
    case "http":
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The stored config

const ShapingLimitsObjectSchema = z.object({
  timeoutMs: z.number().int().min(SHAPING_LIMIT_RANGES.timeoutMs.min).max(SHAPING_LIMIT_RANGES.timeoutMs.max)
    .default(SHAPING_LIMIT_RANGES.timeoutMs.default),
  deadlineMs: z.number().int().min(SHAPING_LIMIT_RANGES.deadlineMs.min).max(SHAPING_LIMIT_RANGES.deadlineMs.max)
    .default(SHAPING_LIMIT_RANGES.deadlineMs.default),
  maxBytes: z.number().int().min(SHAPING_LIMIT_RANGES.maxBytes.min).max(SHAPING_LIMIT_RANGES.maxBytes.max)
    .default(SHAPING_LIMIT_RANGES.maxBytes.default),
  totalBytes: z.number().int().min(SHAPING_LIMIT_RANGES.totalBytes.min).max(SHAPING_LIMIT_RANGES.totalBytes.max)
    .default(SHAPING_LIMIT_RANGES.totalBytes.default),
});
export const ShapingLimitsSchema = ShapingLimitsObjectSchema.prefault({});
export type ShapingLimits = z.output<typeof ShapingLimitsSchema>;

const ShapingCallerObjectSchema = z.object({
  /** The operator's declared identity, `{caller.user}`. Free text, unverified, not a secret. */
  user: z.string().trim().max(256).default(""),
});

export const ShapingConfigSchema = z.object({
  caller: ShapingCallerObjectSchema.prefault({}),
  limits: ShapingLimitsSchema,
  shapers: z.array(StoredShaperSchema).max(SHAPING_LIMITS.shapers).default([]),
  /** A stored on or off per shaper id, registered or discovered. Always wins. */
  overrides: boundedRecord(z.string().min(1).max(64), z.boolean(), SHAPING_LIMITS.choices).default({}),
  /** Shaper ids in run order. An unlisted id sorts after the listed ones of its stage. */
  order: z.array(z.string().min(1).max(64)).max(SHAPING_LIMITS.choices).default([]),
}).transform((config) => ({ ...config, shapers: config.shapers.map(withoutLiteralCredentials) })).prefault({});
export type ShapingConfig = z.output<typeof ShapingConfigSchema>;

export const SHAPING_CONFIG_DEFAULTS: ShapingConfig = ShapingConfigSchema.parse({});

export function sameShapingConfig(a: ShapingConfig, b: ShapingConfig): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------------------------
// Discovery (filled by the shapers folder)

/** What the folder scan says about one entry. Only `ok` can run. Not persisted. */
export const SHAPING_DISCOVERY_STATES = ["ok", "invalid", "refused", "shadowed"] as const;

export const DiscoveredShaperSchema = z.object({
  id: z.string().min(1).max(256),
  path: z.string().max(4096),
  state: z.enum(SHAPING_DISCOVERY_STATES),
  problem: z.string().max(SHAPING_LIMITS.reasonChars).nullable(),
  sha256: z.string().max(64).nullable(),
  shaper: ShaperManifestSchema.nullable(),
});
export type DiscoveredShaper = z.output<typeof DiscoveredShaperSchema>;

/** Where the folder scan looked, and how many entries beyond its bound it left unread. */
export interface ShapingFolderStatus {
  path: string;
  ignored: number;
}

/** Set or not set, per `{env:NAME}` any shaper references. Never a value. */
export type ShapingReferenceStatus = Record<string, "set" | "unset">;

/** What `GET /api/shaping` answers. */
export interface ShapingReply {
  config: ShapingConfigView;
  discovered: DiscoveredShaper[];
  /** The folder that was scanned. Absent from a daemon older than the shapers folder. */
  folder?: ShapingFolderStatus;
  references: ShapingReferenceStatus;
}

// ---------------------------------------------------------------------------------------------
// Intents

/** A stored shaper's revision, as `shapingConfigView` reports it: 16 lowercase hex digits. */
const ShapingRevisionSchema = z.string().regex(/^[0-9a-f]{16}$/, { message: "A revision is 16 hexadecimal digits." });

export const ShapingSettingsIntentSchema = z.object({
  kind: z.literal("settings"),
  caller: partialPatch(ShapingCallerObjectSchema).optional(),
  limits: partialPatch(ShapingLimitsObjectSchema).optional(),
});

export const ShapingIntentSchema = z.discriminatedUnion("kind", [
  /** Create or replace a registered shaper. Only a definition this build understands. */
  z.object({ kind: z.literal("upsert"), shaper: ShaperSchema }),
  /**
   * `expect`, when sent, is the revision the config view reported for the registered entry the sender showed.
   * The intent is refused if the stored entry has changed since, so it never removes or switches
   * a replacement written meanwhile.
   */
  z.object({ kind: z.literal("remove"), id: z.string().min(1).max(64), expect: ShapingRevisionSchema.optional() }),
  /**
   * `manifest`, when sent, is the SHA-256 of the folder manifest the sender showed. Switching on
   * is refused once the folder holds another manifest for the id, or a registered shaper has
   * taken the id, so a click never switches on a definition the operator was not shown.
   */
  z.object({
    kind: z.literal("enable"), id: z.string().min(1).max(64), enabled: z.boolean(), expect: ShapingRevisionSchema.optional(),
    manifest: z.string().regex(/^[0-9a-f]{64}$/, { message: "A manifest hash is 64 hexadecimal digits." }).optional(),
  }),
  z.object({ kind: z.literal("reorder"), order: z.array(z.string().min(1).max(64)).max(SHAPING_LIMITS.choices) }),
  /**
   * Place a registered shaper right after another of its stage, or first for null, applied to
   * the order as it is stored when the intent arrives, so moves from two windows compose.
   * Unbound: kept for a client that sends no revision.
   */
  z.object({ kind: z.literal("move"), id: z.string().min(1).max(64), after: z.string().min(1).max(64).nullable() }),
  /**
   * A move bound to the definition the sender showed, which the dashboard sends: once that is
   * replaced, even into another stage, it is refused rather than placing the replacement. A kind
   * of its own, never an `expect` added to `move`: a daemon older than this kind strips a field
   * it does not know and would apply the move by id alone, but refuses a kind it does not know,
   * so a placement in flight across a rollback is refused there instead of reordering a
   * replacement the operator never saw.
   */
  z.object({
    kind: z.literal("place"), id: z.string().min(1).max(64), after: z.string().min(1).max(64).nullable(),
    expect: ShapingRevisionSchema,
  }),
  ShapingSettingsIntentSchema,
]);
export type ShapingIntent = z.infer<typeof ShapingIntentSchema>;

export type ShapingIntentError =
  | "unknown_shaper"
  | "unsupported_shaper"
  | "invalid_shaper"
  | "too_many_shapers"
  /** The entry an intent named by its revision has changed since the sender showed it. */
  | "shaper_changed"
  /** A move cannot fit the stored order's bound. */
  | "order_full";

export type ShapingIntentResult =
  | { ok: true; config: ShapingConfig }
  | { ok: false; error: ShapingIntentError; reason: string };

/**
 * Apply one operator intent. Every other stored entry, unsupported ones and their unknown fields
 * included, is carried through unchanged: the list is rewritten from the envelopes, never from a
 * re-parse. `discovered` names the folder's entries, so they can be switched on or off.
 */
export function applyShapingIntent(
  config: ShapingConfig,
  intent: ShapingIntent,
  discovered: readonly DiscoveredShaper[] = [],
  options: {
    /** The daemon's reviser. Required for an intent that carries `expect`. */
    revise?: ShapingReviser;
    definitions?: ShapingDefinitions;
  } = {},
): ShapingIntentResult {
  const { revise, definitions = SHAPING_DEFINITIONS } = options;
  const refuse = (error: ShapingIntentError, reason: string): ShapingIntentResult => ({ ok: false, error, reason });
  const shapers = [...config.shapers];
  const overrides = { ...config.overrides };
  let order = [...config.order];
  const index = (id: string) => shapers.findIndex((entry) => entry.id === id);
  /** Whether the registered entry differs from the revision the sender showed. */
  const stale = (id: string, expect: string | undefined): boolean => {
    if (expect === undefined) return false;
    // A programming error, never an operator's: a revision is only ever checked by the daemon.
    if (!revise) throw new Error("A revision-bound shaping intent needs the daemon's reviser.");
    return registeredShaperRevision(config, id, revise) !== expect;
  };
  const changed = (id: string): ShapingIntentResult => refuse("shaper_changed",
    `"${id}" changed in another window since it was shown here, so nothing was done. Review it again first.`);
  /** Choices for ids that no longer exist make room before a live one is stored. */
  const makeRoomForChoice = (id: string): void => {
    if (Object.hasOwn(overrides, id) || Object.keys(overrides).length < SHAPING_LIMITS.choices) return;
    const live = new Set([...shapers.map((entry) => entry.id), ...discovered.map((entry) => entry.id)]);
    for (const key of Object.keys(overrides)) if (!live.has(key)) delete overrides[key];
  };
  switch (intent.kind) {
    case "upsert": {
      const parsed = definitions.shaper.safeParse(intent.shaper);
      if (!parsed.success) return refuse("invalid_shaper", issueSentence(parsed.error));
      const stored = StoredShaperSchema.safeParse(parsed.data);
      if (!stored.success) return refuse("invalid_shaper", issueSentence(stored.error));
      const at = index(parsed.data.id);
      if (at === -1) {
        if (shapers.length >= SHAPING_LIMITS.shapers) {
          return refuse("too_many_shapers", `At most ${SHAPING_LIMITS.shapers} shapers can be registered.`);
        }
        shapers.push(stored.data);
      } else {
        const existing = classifyShaper(shapers[at]!, definitions);
        if (existing.kind === "unsupported" && !credentialsWereRemoved(shapers[at]!)) {
          return refuse("unsupported_shaper", `"${parsed.data.id}" is stored in a form this build does not understand, so it can only be switched off or removed. ${existing.reason}`);
        }
        shapers[at] = stored.data;
      }
      // Every upsert stores off for its id, an explicit `false`, a replacement as much as a new
      // definition: a choice to run applies to the definition the operator reviewed, not to
      // whatever is written over it later with a different command, arguments or transport, nor
      // to a discovered shaper that happened to hold the id.
      makeRoomForChoice(parsed.data.id);
      overrides[parsed.data.id] = false;
      break;
    }
    case "remove": {
      if (index(intent.id) === -1) return refuse("unknown_shaper", `No registered shaper has the id "${intent.id}".`);
      if (stale(intent.id, intent.expect)) return changed(intent.id);
      for (let at = index(intent.id); at !== -1; at = index(intent.id)) shapers.splice(at, 1);
      if (discovered.some((entry) => entry.id === intent.id)) {
        // A shaper in the folder has this id, and the registration was shadowing it. Removing the
        // registration must not switch it on: it is stored off, in its place in the order, and
        // runs only once the operator switches it on.
        makeRoomForChoice(intent.id);
        overrides[intent.id] = false;
      } else {
        delete overrides[intent.id];
        order = order.filter((id) => id !== intent.id);
      }
      break;
    }
    case "move":
    case "place": {
      // A placement checks the definition it was sent for first: one replaced since, even by an
      // entry this build cannot run, is "changed", which tells the sender to review it.
      if (intent.kind === "place" && index(intent.id) !== -1 && stale(intent.id, intent.expect)) return changed(intent.id);
      const known = classifyShapers(config, definitions).flatMap((entry, position) => entry.kind === "known"
        ? [{ id: entry.shaper.id, stage: entry.shaper.stage, position }] : []);
      const moved = known.find((entry) => entry.id === intent.id);
      if (!moved) {
        return refuse(index(intent.id) === -1 ? "unknown_shaper" : "unsupported_shaper",
          `No registered shaper this build can run has the id "${intent.id}".`);
      }
      const rows = known.filter((entry) => entry.stage === moved.stage).sort(compareShapingOrder(config.order, definitions.stages))
        .map((entry) => entry.id);
      if (intent.after !== null && (intent.after === intent.id || !rows.includes(intent.after))) {
        return refuse("unknown_shaper", `"${intent.after}" is not another registered shaper at the same stage.`);
      }
      const live = new Set([...shapers.map((entry) => entry.id), ...discovered.map((entry) => entry.id)]);
      const placed = moveInShapingOrder({ rows, order, id: intent.id, after: intent.after, keep: (id) => live.has(id) });
      if (!placed.ok) return refuse("order_full", placed.reason);
      order = placed.order;
      break;
    }
    case "enable": {
      const at = index(intent.id);
      const found = discovered.find((entry) => entry.id === intent.id);
      if (at === -1 && !found) return refuse("unknown_shaper", `No shaper has the id "${intent.id}".`);
      if (stale(intent.id, intent.expect)) return changed(intent.id);
      // Bound to the manifest the sender showed: switching on what replaced it, or a registration
      // that took its id, needs a fresh look first. Switching off is always safe.
      if (intent.enabled && intent.manifest !== undefined && (at !== -1 || found?.sha256 !== intent.manifest)) {
        return refuse("shaper_changed", at !== -1
          ? `A registered shaper now has the id "${intent.id}", so the folder's shaper was not switched on. Review it again first.`
          : `"${intent.id}" changed in the shapers folder since it was shown here, so it was not switched on. Review it again first.`);
      }
      if (intent.enabled) {
        if (at !== -1) {
          const classified = classifyShaper(shapers[at]!, definitions);
          if (classified.kind === "unsupported") return refuse("unsupported_shaper", classified.reason);
        } else if (found && found.state !== "ok") {
          return refuse("unsupported_shaper", found.problem ?? `The shaper "${intent.id}" cannot run.`);
        }
      }
      makeRoomForChoice(intent.id);
      overrides[intent.id] = intent.enabled;
      break;
    }
    case "reorder":
      order = [...new Set(intent.order)];
      break;
    case "settings":
      return {
        ok: true,
        config: ShapingConfigSchema.parse({
          ...config,
          shapers,
          caller: { ...config.caller, ...intent.caller },
          limits: { ...config.limits, ...intent.limits },
        }),
      };
  }
  return { ok: true, config: { caller: config.caller, limits: config.limits, shapers, overrides, order } };
}

// ---------------------------------------------------------------------------------------------
// Which shapers run

/** One shaper that applies to a run, with what the record needs to say which definition ran. */
export interface ResolvedShaper {
  shaper: Shaper;
  origin: ShapingOrigin;
  /** The stored envelope a registered shaper was read from, hashed for the record. */
  stored: StoredShaper | null;
  /** The manifest's SHA-256, for a discovered shaper. */
  sha256: string | null;
  /** The folder a discovered shaper was found in. Null for a registered one. */
  root: string | null;
  /** Names of the task's repositories this shaper is called for, in task order. */
  repositories: string[];
}

/** What `resolveShapers` reads about a task. */
export interface ShapingResolveInput {
  kind: string;
  repositories: readonly { name: string }[];
  /**
   * Which turn is being launched. A launch is shaped; an `iteration`, a resident's wake turn, is
   * never shaped, whatever a shaper lists. Absent means a launch.
   */
  turn?: "launch" | "iteration";
}

/**
 * Whether a shaper with no `kinds` serves `kind`: every kind whose launch is `harness`, read from
 * the task-kind registry, so a future harness-launched kind joins without a second list. A
 * resident or pipeline kind, and any kind this build does not know, is served only when listed.
 */
export function shapedByDefault(kind: string): boolean {
  return (TASK_KINDS as readonly string[]).includes(kind) && taskKindLaunchesHarness(kind as TaskKind);
}

type Candidate = Omit<ResolvedShaper, "repositories"> & { enabled: boolean; position: number };

function candidates(
  config: ShapingConfig,
  discovered: readonly DiscoveredShaper[],
  definitions: ShapingDefinitions,
): Candidate[] {
  const out: Candidate[] = [];
  const registered = new Set<string>();
  classifyShapers(config, definitions).forEach((entry, position) => {
    registered.add(entry.stored.id);
    if (entry.kind !== "known") return;
    out.push({
      shaper: entry.shaper, origin: "registered", stored: entry.stored, sha256: null, root: null, position,
      enabled: shaperSwitchedOn(config, entry.shaper.id, "registered"),
    });
  });
  for (const entry of discovered) {
    // A registered shaper wins an id clash, whatever the scan reported.
    if (entry.state !== "ok" || !entry.shaper || registered.has(entry.id) || entry.shaper.id !== entry.id) continue;
    if (out.some((candidate) => candidate.shaper.id === entry.id)) continue;
    // A manifest's definition, which may name a `./` command resolved against its folder.
    const parsed = (definitions.discovered ?? definitions.shaper).safeParse(stripManifestFields(entry.shaper));
    if (!parsed.success) continue;
    out.push({
      shaper: parsed.data, origin: "discovered", stored: null, sha256: entry.sha256, root: entry.path,
      position: Number.MAX_SAFE_INTEGER,
      enabled: shaperSwitchedOn(config, entry.id, "discovered", entry.shaper.enabled),
    });
  }
  return out;
}

function stripManifestFields(manifest: ShaperManifest): unknown {
  const { enabled: _enabled, ...shaper } = manifest;
  return shaper;
}

/**
 * Whether a shaper is switched on, before its filters: the enablement rule's one statement. A
 * stored choice in `overrides`, on or off, always wins. With none, a registered shaper is off
 * and a discovered one is on unless its manifest says `"enabled": false`. Settings reads the
 * same answer for its pills, so the list and a launch never disagree about a shaper.
 */
export function shaperSwitchedOn(
  config: Pick<ShapingConfig, "overrides">,
  id: string,
  origin: ShapingOrigin,
  manifestEnabled?: boolean,
): boolean {
  if (Object.hasOwn(config.overrides, id)) return config.overrides[id]!;
  return origin === "discovered" && manifestEnabled !== false;
}

/** What the ordering rule reads about one shaper: its id, its stage, and where it is stored. */
export interface ShapingOrderKey {
  id: string;
  stage: string;
  /** Its index in the stored list. A discovered shaper has none and sorts after every stored one. */
  position: number;
}

/**
 * The ordering rule: stage order, then the stored `order`, then unlisted registered shapers in
 * stored order, then unlisted discovered shapers by id. The resolver and the Settings list both
 * sort with it, so the list shows exactly the order a launch runs in.
 */
export function compareShapingOrder(order: readonly string[], stages: readonly string[] = SHAPING_STAGES) {
  const rank = new Map(order.map((id, at) => [id, at]));
  return (a: ShapingOrderKey, b: ShapingOrderKey): number => {
    const stage = stages.indexOf(a.stage) - stages.indexOf(b.stage);
    if (stage !== 0) return stage;
    const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

function compareCandidates(order: readonly string[], stages: readonly string[]) {
  const compare = compareShapingOrder(order, stages);
  return (a: Candidate, b: Candidate): number => compare(
    { id: a.shaper.id, stage: a.shaper.stage, position: a.position },
    { id: b.shaper.id, stage: b.shaper.stage, position: b.position },
  );
}

function applicableRepositories(shaper: Shaper, input: ShapingResolveInput): string[] {
  return input.repositories.map((repo) => repo.name)
    .filter((name) => shaper.repositories.length === 0 || shaper.repositories.includes(name));
}

/**
 * The shapers that run for this task, in run order. The one place the enablement rule lives:
 * a stored choice in `overrides`, on or off, always wins. With no stored choice a registered
 * shaper is off, and a discovered one runs unless its manifest says `"enabled": false`. An
 * unsupported, invalid, refused or shadowed entry never runs, whatever is stored for its id.
 */
export function resolveShapers(
  config: ShapingConfig,
  discovered: readonly DiscoveredShaper[],
  input: ShapingResolveInput,
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ResolvedShaper[] {
  // A resident's wake turn is never shaped.
  if (input.turn === "iteration") return [];
  return candidates(config, discovered, definitions)
    .filter((candidate) => candidate.enabled)
    .filter((candidate) => (candidate.shaper.kinds.length === 0 ? shapedByDefault(input.kind) : candidate.shaper.kinds.includes(input.kind)))
    .sort(compareCandidates(config.order, definitions.stages))
    .map(({ enabled: _enabled, position: _position, ...candidate }) => ({
      ...candidate, repositories: applicableRepositories(candidate.shaper, input),
    }))
    .filter((resolved) => resolved.repositories.length > 0);
}

export type ShaperLookup =
  | { ok: true; resolved: ResolvedShaper }
  | { ok: false; error: "unknown_shaper" | "unsupported_shaper"; reason: string };

/**
 * One shaper by id for a dry run, whatever its stored choice and its filters: the operator asked
 * for exactly this one. An entry that could never run is still refused.
 */
export function resolveShaperById(
  config: ShapingConfig,
  discovered: readonly DiscoveredShaper[],
  id: string,
  input: ShapingResolveInput,
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ShaperLookup {
  const found = candidates(config, discovered, definitions).find((candidate) => candidate.shaper.id === id);
  if (found) {
    const { enabled: _enabled, position: _position, ...resolved } = found;
    return { ok: true, resolved: { ...resolved, repositories: input.repositories.map((repo) => repo.name) } };
  }
  const stored = classifyShapers(config, definitions).find((entry) => entry.stored.id === id);
  if (stored?.kind === "unsupported") return { ok: false, error: "unsupported_shaper", reason: stored.reason };
  const folder = discovered.find((entry) => entry.id === id);
  if (folder) return { ok: false, error: "unsupported_shaper", reason: folder.problem ?? `The shaper "${id}" cannot run.` };
  return { ok: false, error: "unknown_shaper", reason: `No shaper has the id "${id}".` };
}

// ---------------------------------------------------------------------------------------------
// The contract: one request, one result

export const ShapingFactValueSchema = z.union([
  z.string().max(SHAPING_LIMITS.factValueChars),
  z.array(z.string().max(SHAPING_LIMITS.factValueChars)).max(SHAPING_LIMITS.facts),
]);
export const ShapingFactsSchema = boundedRecord(z.string().min(1).max(128), ShapingFactValueSchema, SHAPING_LIMITS.facts);
export type ShapingFacts = z.output<typeof ShapingFactsSchema>;

/**
 * A repository's slot within one task (D17): `repo-01` for the primary, then `repo-02` onward in
 * attachment order. It tells two attached worktrees of one repository apart, which a name cannot.
 */
export const ShapingSlotSchema = z.string().regex(/^repo-\d{2}$/, { message: "A slot is repo-NN." });

/** The slot at a position in the ordered list: the primary first, then attachment order. */
export function shapingSlot(position: number): string {
  return `repo-${String(position + 1).padStart(2, "0")}`;
}

export const ShapingRepositoryRefSchema = z.object({
  slot: ShapingSlotSchema,
  name: z.string().min(1).max(256),
  role: z.enum(["primary", "additional"]),
  branch: z.string().max(256).nullable(),
  baseSha: z.string().max(64).nullable(),
  /** Local shapers only. */
  path: z.string().max(4096).optional(),
});

/** Everything Mission Control collected about the task besides the prompt (constraint C2). */
export const ShapingContextSchema = z.object({
  /** Null in a dry run. */
  taskId: z.string().max(128).nullable(),
  title: z.string().max(1024),
  kind: z.string().max(64),
  /** Null in a dry run. */
  harness: z.string().max(64).nullable(),
  runtime: z.string().max(64).nullable(),
  afterWork: z.object({ workflowId: z.string().max(128), name: z.string().max(256) }).nullable(),
  labels: z.array(z.string().max(128)).max(64),
  priority: z.string().max(64).nullable(),
  repositories: z.array(ShapingRepositoryRefSchema).max(SHAPING_LIMITS.repositories),
  /** The slot of the repository this call is about (D17), one of `repositories`. */
  target: ShapingSlotSchema,
  caller: z.object({
    user: z.string().max(256).nullable(),
    agent: z.string().max(64).nullable(),
    conversation: z.string().max(128).nullable(),
  }),
  /**
   * Route requests only (D13): the entries the select stage put into the section for the
   * target repository, as `{ shaper, id }`, ids only. Absent at every other stage.
   */
  guidance: z.array(z.object({
    shaper: z.string().max(64),
    id: z.string().max(SHAPING_LIMITS.entryIdChars),
  })).max(SHAPING_LIMITS.guidanceIds).optional(),
});
export type ShapingContext = z.output<typeof ShapingContextSchema>;

export const ShapingRequestSchema = z.object({
  protocol: z.literal(SHAPING_PROTOCOL),
  stage: z.enum(SHAPING_STAGES),
  /** The operator's prompt, verbatim, and nothing else. */
  task: z.string().max(SHAPING_LIMITS.taskChars),
  repo: z.object({
    name: z.string().min(1).max(256),
    /** Local shapers only. */
    path: z.string().max(4096).optional(),
    /** Absent in a gather request. */
    facts: ShapingFactsSchema.optional(),
    summary: z.string().max(SHAPING_LIMITS.summaryBytes).optional(),
  }),
  version: z.string().max(SHAPING_LIMITS.versionChars).optional(),
  context: ShapingContextSchema,
  limits: z.object({ maxBytes: z.number().int().positive(), deadlineMs: z.number().int().nonnegative() }),
});
export type ShapingRequest = z.output<typeof ShapingRequestSchema>;

export const ShapingEntrySchema = z.object({
  id: z.string().min(1).max(SHAPING_LIMITS.entryIdChars),
  path: z.string().max(SHAPING_LIMITS.entryPathChars).optional(),
  title: z.string().max(SHAPING_LIMITS.entryTitleChars).optional(),
  body: z.string().max(SHAPING_LIMITS.replyText),
  truncated: z.boolean().optional(),
});
export type ShapingEntry = z.output<typeof ShapingEntrySchema>;

/**
 * The one result shape, at every stage and over every transport: FR-02's `get_guidance` reply
 * plus fields a shaper may omit. Unknown fields are ignored (`protocol: 1` compatibility).
 */
export const ShapingResultSchema = z.object({
  version: z.string().max(SHAPING_LIMITS.versionChars).nullable().optional(),
  guidance: z.array(ShapingEntrySchema).max(SHAPING_LIMITS.replyEntries).default([]),
  truncated: z.boolean().optional(),
  degraded: z.boolean().optional(),
  repo: z.object({
    facts: ShapingFactsSchema.optional(),
    summary: z.string().max(SHAPING_LIMITS.replyText).optional(),
  }).optional(),
  notes: z.array(z.string().max(SHAPING_LIMITS.replyNoteChars)).max(SHAPING_LIMITS.replyNotes).optional(),
});
export type ShapingResult = z.output<typeof ShapingResultSchema>;

/**
 * A routed skill's name: what Mission Control puts after the harness's sigil. Lower-case
 * letters, digits, `-`, `_` and `:`, starting with a letter or digit, so a router can never
 * spell a flag, a path or a Markdown construct. The words around it are Mission Control's.
 */
export const ShapingSkillNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_:-]*$/, {
  message: "A skill name is lower-case letters, digits, -, _ and :.",
});

/** Why a router chose a skill, as an identifier the router owns. Never shown to a worker. */
export const ShapingReasonIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9_:./-]+$/, {
  message: "A reason id is lower-case letters, digits, -, _, :, . and /.",
});

/**
 * A router's reply (FR-04 section 4): skills, not guidance. Unknown fields are ignored.
 * `lifecycle_point` is any bounded string, so a point this build does not know makes that one
 * skill `unsupported` and leaves the reply valid; any other mismatch is the `invalid` outcome.
 */
export const ShapingRouteResultSchema = z.object({
  version: z.string().max(SHAPING_LIMITS.versionChars).nullable().optional(),
  skills: z.array(z.object({
    name: ShapingSkillNameSchema,
    lifecycle_point: z.string().min(1).max(64),
    reason_id: ShapingReasonIdSchema,
  })).max(SHAPING_LIMITS.routedSkills),
  truncated: z.boolean().optional(),
  degraded: z.boolean().optional(),
  notes: z.array(z.string().max(SHAPING_LIMITS.replyNoteChars)).max(SHAPING_LIMITS.replyNotes).optional(),
});
export type ShapingRouteResult = z.output<typeof ShapingRouteResultSchema>;

/** A shaper's reply in words, for the `invalid` outcome. */
/**
 * A shaper's reply in words, for the `invalid` outcome. Not clipped: the path can hold a key the
 * shaper chose, so the caller redacts the whole sentence first and only then cuts it to length.
 * Clipping first could split a value the redactor would then fail to recognise.
 */
export function describeInvalidResult(error: z.ZodError): string {
  return `The reply does not match the shaping result: ${issueSentence(error, Infinity)}`;
}

// ---------------------------------------------------------------------------------------------
// The record of a run

export const ShapingShaperSummarySchema = z.object({
  id: z.string().max(64),
  label: z.string().max(200),
  stage: z.string().max(64),
  origin: z.enum(SHAPING_ORIGINS),
  sha256: z.string().max(64).nullable(),
  outcome: z.enum(SHAPING_OUTCOMES),
  reason: z.string().max(SHAPING_LIMITS.reasonChars).nullable(),
  durationMs: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** A transport removed a credential value from this shaper's data or reason (Phase 5 sets it). */
  redacted: z.boolean().default(false),
  version: z.string().max(SHAPING_LIMITS.versionChars).nullable(),
});
export type ShapingShaperSummary = z.output<typeof ShapingShaperSummarySchema>;

/** One routed skill as a launch records it, whatever became of it. */
export const ShapingSkillSummarySchema = z.object({
  name: z.string().max(64),
  /** As the router sent it: a point this build does not know is kept, and the skill is `unsupported`. */
  lifecyclePoint: z.string().max(64),
  reasonId: z.string().max(128),
  /** The router whose reply first named it. */
  shaper: z.string().max(64),
  /** The repositories it was routed for, by name, less any the repository's own task skill took (D14). */
  repositories: z.array(z.string().max(256)).max(SHAPING_LIMITS.repositories),
  state: z.enum(SHAPING_SKILL_STATES),
  /** True for a skill from Mission Control's catalog that was checked; false for a name taken as given (D15). */
  verified: z.boolean(),
  /** Why it is not announced. Null for an announced skill. */
  reason: z.string().max(SHAPING_LIMITS.reasonChars).nullable(),
});
export type ShapingSkillSummary = z.output<typeof ShapingSkillSummarySchema>;

/** What a launch records. Absent when no shaper applied. */
export const TaskShapingSchema = z.object({
  state: z.enum(["ok", "degraded"]),
  at: z.number().int().nonnegative(),
  /** The session the record was delivered to. The engine leaves it unset; Phase 2 sets it. */
  sessionId: z.string().min(1).max(256).optional(),
  /**
   * The turn-one delivery the record describes: the id written to the task's binding
   * (`Task.shapingDelivery`) in the same transaction as this record. The engine leaves it unset;
   * the commit stamps it. A record from an earlier delivery carries an earlier id, so it is told
   * apart from this one even when both name the same session.
   */
  deliveryId: z.string().min(1).max(64).optional(),
  durationMs: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  shapers: z.array(ShapingShaperSummarySchema).max(SHAPING_LIMITS.shapers * 2),
  /**
   * Routed skills, in merge order. Present only when a router applied to the launch, so a launch
   * no router applied to records exactly what it did before routing existed.
   */
  skills: z.array(ShapingSkillSummarySchema).max(SHAPING_LIMITS.recordedSkills).optional(),
  /**
   * Set by dispatch when this launch's delivery path left the section less room than
   * `limits.totalBytes`: how many bytes it allowed, and why. Absent when the configured total
   * applied. Truncation it caused is recorded as truncation, never as degradation.
   */
  limit: z.object({
    bytes: z.number().int().nonnegative(),
    reason: z.string().max(SHAPING_LIMITS.reasonChars),
  }).optional(),
});
export type TaskShaping = z.output<typeof TaskShapingSchema>;

/** What the reader rule reads of a task: its record and its binding, the session and the delivery. */
export interface ShapingBinding {
  shaping?: TaskShaping | null;
  sessionId: string | null;
  shapingDelivery?: string | null;
}

/**
 * The one reader rule for a task's shaping record: it counts only while it describes the
 * delivery the task is bound to now - it names the session the task is executing on, and
 * carries the delivery id that binding was written with (`Task.shapingDelivery`). A record left
 * by an earlier launch describes a session this task no longer shows; one left by an earlier
 * delivery to the SAME session, such as a handover back to the agent it already ran on whose
 * own commit failed, carries an earlier delivery id. Every reader - task reads, the shaping
 * route, MCP, the board and rail markers, the chip and the viewer - sees nothing for either,
 * rather than another delivery's context or `degraded`. A record or a binding without a
 * delivery id never counts.
 */
export function currentShaping(task: ShapingBinding): TaskShaping | null {
  const record = task.shaping;
  if (!record?.sessionId || !record.deliveryId || !task.sessionId || !task.shapingDelivery) return null;
  return record.sessionId === task.sessionId && record.deliveryId === task.shapingDelivery ? record : null;
}

/**
 * A task as a read returns it: `shaping` kept only while `currentShaping` shows it, and absent
 * otherwise, so no read carries a record that describes another delivery.
 */
export function withCurrentShaping<T extends ShapingBinding>(task: T): T {
  if (task.shaping === undefined || currentShaping(task)) return task;
  const { shaping: _stale, ...rest } = task;
  return rest as T;
}

/** A launch that is shaping context right now: the step has started and nothing is committed yet. */
export interface ShapingInProgress {
  state: "shaping";
  startedAt: number;
}

/**
 * The second stable reader, for a surface that has to show the wait as well as the outcome:
 * `{ state: "shaping" }` while a dispatch or handover is running the step - the derived,
 * unpersisted `shapingContext` mark that rides `task_upsert` - and `currentShaping(task)`
 * otherwise. `state` is always `shaping`, `ok` or `degraded`; null when there is nothing to show.
 */
export function shapingView(task: ShapingBinding & {
  shapingContext?: { startedAt: number } | null;
}): ShapingInProgress | TaskShaping | null {
  if (task.shapingContext) return { state: "shaping", startedAt: task.shapingContext.startedAt };
  return currentShaping(task);
}

/**
 * One launch's after-work prompt (`task_skill_prompts`), as task reads and the viewer carry it.
 * `skills` are the names it prompted, or was to prompt, in order.
 */
export const TaskSkillPromptSchema = z.object({
  sessionId: z.string().min(1).max(256),
  state: z.enum(SHAPING_PROMPT_STATES),
  reason: z.string().max(SHAPING_LIMITS.reasonChars).nullable(),
  skills: z.array(z.string().max(64)).max(SHAPING_LIMITS.routedSkills),
  createdAt: z.number().int().nonnegative(),
  deliveredAt: z.number().int().nonnegative().nullable(),
});
export type TaskSkillPrompt = z.output<typeof TaskSkillPromptSchema>;

/**
 * What a task read carries: the state, the session it describes, and one line. `skills` appears
 * only when a router applied, and `afterWork` only once an after-work prompt row exists.
 */
export interface TaskShapingRead {
  state: TaskShaping["state"];
  sessionId: string;
  summary: string;
  skills?: ShapingSkillSummary[];
  afterWork?: TaskSkillPrompt;
}

/**
 * `shaping` in a task read, or null when `currentShaping` shows nothing. `afterWork` is attached
 * only while it names the record's session.
 */
export function taskShapingRead(
  task: ShapingBinding,
  afterWork: TaskSkillPrompt | null = null,
): TaskShapingRead | null {
  const record = currentShaping(task);
  if (!record?.sessionId) return null;
  return {
    state: record.state,
    sessionId: record.sessionId,
    summary: shapingSummaryLine(record),
    ...(record.skills ? { skills: record.skills } : {}),
    ...(afterWork && afterWork.sessionId === record.sessionId ? { afterWork } : {}),
  };
}

/** One entry as it would be injected, for the record, the viewer and the dry run. */
export interface ShapingInjectedEntry {
  shaperId: string;
  label: string;
  stage: string;
  repo: string;
  id: string;
  title: string | null;
  path: string | null;
  body: string;
  truncated: boolean;
  omittedBytes: number;
}

/** What one run comes to, and what `POST /api/shaping/test` answers. */
export interface ShapingRun {
  /** Null when no shaper applied. */
  summary: TaskShaping | null;
  /** The section for turn one: the task context, then the skills for this task. Empty when nothing was kept. */
  section: string;
  entries: ShapingInjectedEntry[];
  /** The routed skills, as the summary records them. The engine always sets it, empty when no router applied. */
  skills?: ShapingSkillSummary[];
}

/** One call: one shaper, one repository. What `summariseShaping` folds per shaper. */
export interface ShapingCallRecord {
  shaper: { id: string; label: string; stage: string };
  origin: ShapingOrigin;
  sha256: string | null;
  repo: string;
  outcome: ShapingOutcome;
  reason: string | null;
  durationMs: number;
  version: string | null;
  /** The transport removed a credential value from what this call's record was built from. */
  redacted: boolean;
}

/** What the budget kept, per shaper. */
export interface ShapingKeptEntry {
  shaperId: string;
  bytes: number;
  truncated: boolean;
}

// Worst first: the outcome a shaper reports when its calls disagree.
const OUTCOME_SEVERITY: readonly ShapingOutcome[] = ["failed", "timed_out", "invalid", "unavailable", "degraded", "ok"];

/**
 * Fold per-call records and the budget's result into the task's summary: one row per shaper,
 * in run order, with the worst outcome across its repositories. Null when no shaper applied.
 */
export function summariseShaping(input: {
  calls: readonly ShapingCallRecord[];
  kept: readonly ShapingKeptEntry[];
  /** Shapers whose entries the budget dropped or cut. */
  truncatedShapers: ReadonlySet<string>;
  at: number;
  durationMs: number;
  multiRepo: boolean;
}): TaskShaping | null {
  if (input.calls.length === 0) return null;
  const ids: string[] = [];
  const byShaper = new Map<string, ShapingCallRecord[]>();
  for (const call of input.calls) {
    if (!byShaper.has(call.shaper.id)) { byShaper.set(call.shaper.id, []); ids.push(call.shaper.id); }
    byShaper.get(call.shaper.id)!.push(call);
  }
  const shapers = ids.map((id): ShapingShaperSummary => {
    const calls = byShaper.get(id)!;
    // The worst outcome; on a tie, the first call that gives a reason, so a redaction note from one
    // repository is never hidden behind another's silent success.
    const worst = calls.reduce((a, b) => {
      const order = OUTCOME_SEVERITY.indexOf(b.outcome) - OUTCOME_SEVERITY.indexOf(a.outcome);
      if (order !== 0) return order < 0 ? b : a;
      return a.reason === null && b.reason !== null ? b : a;
    });
    const kept = input.kept.filter((entry) => entry.shaperId === id);
    const reason = worst.reason === null ? null
      : (input.multiRepo ? `${worst.repo}: ${worst.reason}` : worst.reason).slice(0, SHAPING_LIMITS.reasonChars);
    return {
      id, label: worst.shaper.label, stage: worst.shaper.stage, origin: worst.origin, sha256: worst.sha256,
      outcome: worst.outcome, reason,
      durationMs: Math.max(...calls.map((call) => Math.max(0, Math.round(call.durationMs)))),
      entries: kept.length,
      bytes: kept.reduce((sum, entry) => sum + entry.bytes, 0),
      truncated: input.truncatedShapers.has(id),
      redacted: calls.some((call) => call.redacted),
      version: calls.find((call) => call.version !== null)?.version ?? null,
    };
  });
  return {
    state: shapers.every((shaper) => shaper.outcome === "ok") ? "ok" : "degraded",
    at: input.at,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    entries: shapers.reduce((sum, shaper) => sum + shaper.entries, 0),
    bytes: shapers.reduce((sum, shaper) => sum + shaper.bytes, 0),
    truncated: shapers.some((shaper) => shaper.truncated),
    shapers,
  };
}

const OUTCOME_WORDS: Record<ShapingOutcome, string> = {
  ok: "answered",
  degraded: "reported degraded",
  failed: "failed",
  timed_out: "timed out",
  invalid: "returned an invalid reply",
  unavailable: "was unavailable",
};

/** The skills a record announced in turn one, in order. */
export function announcedSkills(summary: Pick<TaskShaping, "skills">): ShapingSkillSummary[] {
  return (summary.skills ?? []).filter((skill) => skill.state === "announced");
}

/** `, 2 skills (ship, retro)`, or nothing when no skill was announced. */
function skillsClause(summary: TaskShaping): string {
  const names = announcedSkills(summary).map((skill) => skill.name);
  if (names.length === 0) return "";
  return `, ${names.length} ${names.length === 1 ? "skill" : "skills"} (${names.join(", ")})`;
}

/**
 * One line for a task read, such as `degraded: guidance-service timed out; 0 entries`. A launch
 * that announced routed skills names them, as in `ok: 3 entries from 2 shapers, 2 skills (ship,
 * retro)`; one that announced none reads exactly as it did before routing existed.
 */
export function shapingSummaryLine(summary: TaskShaping): string {
  const entries = `${summary.entries} ${summary.entries === 1 ? "entry" : "entries"}`;
  if (summary.state === "ok") {
    return `ok: ${entries} from ${summary.shapers.length} ${summary.shapers.length === 1 ? "shaper" : "shapers"}${skillsClause(summary)}${summary.truncated ? ", truncated" : ""}`;
  }
  const problems = summary.shapers.filter((shaper) => shaper.outcome !== "ok")
    .map((shaper) => `${shaper.id} ${OUTCOME_WORDS[shaper.outcome]}`);
  return `degraded: ${problems.join(", ")}; ${entries}${skillsClause(summary)}`;
}

// ---------------------------------------------------------------------------------------------
// The context budget

/** One thing to fit. `group` shares `groupBytes` (a shaper's `maxBytes`) across its entries. */
export interface BudgetItem {
  group: string;
  groupBytes: number;
  body: string;
  /** Bytes the item costs beyond its body, such as its heading. Counted, never cut. */
  overhead?: number;
  /**
   * What makes two items the same, such as an entry id or a body within one repository. An item
   * whose key a kept item already claimed is skipped as a duplicate, neither kept nor dropped.
   * Keys are claimed only when an item is kept, so a dropped one never hides a later copy that
   * fits.
   */
  keys?: readonly string[];
}

export interface BudgetSlot<T extends BudgetItem> {
  item: T;
  body: string;
  /** Body plus overhead, as charged. */
  bytes: number;
  truncated: boolean;
  omittedBytes: number;
}

export interface BudgetAllocation<T extends BudgetItem> {
  kept: BudgetSlot<T>[];
  dropped: { item: T; bytes: number }[];
  /** Bytes charged against the total. */
  bytes: number;
}

function truncationMarker(omitted: number): string {
  return `\n[truncated: ${omitted} bytes omitted]`;
}

/**
 * Fill `totalBytes` in the order given, which is pipeline order: stage, list, then the order a
 * shaper returned. Reads no config: a later step outside shaping (FR-06 lessons) calls it with
 * what the shaping stages left. An item is cut to at most `entryBytes`, to what is left of its
 * group and of the total, at the last line boundary that fits, and marked with how much was
 * omitted. An item that does not fit with less than `minEntryBytes` left is dropped. An item
 * that shares a key with one already kept is skipped as a duplicate.
 */
export function allocateBudget<T extends BudgetItem>(
  items: readonly T[],
  totalBytes: number,
  limits: { entryBytes: number; minEntryBytes: number } = {
    entryBytes: SHAPING_LIMITS.entryBytes, minEntryBytes: SHAPING_LIMITS.minEntryBytes,
  },
): BudgetAllocation<T> {
  const kept: BudgetSlot<T>[] = [];
  const dropped: { item: T; bytes: number }[] = [];
  const groups = new Map<string, number>();
  const claimed = new Set<string>();
  let used = 0;
  for (const item of items) {
    if (item.keys?.some((key) => claimed.has(key))) continue;
    const overhead = Math.max(0, item.overhead ?? 0);
    const full = utf8Length(item.body);
    const groupUsed = groups.get(item.group) ?? 0;
    const room = Math.min(totalBytes - used, item.groupBytes - groupUsed) - overhead;
    // The per-entry cap covers the whole entry as charged, heading and separators included.
    const cap = Math.min(room, limits.entryBytes - overhead);
    let body = item.body;
    let omittedBytes = 0;
    if (full > cap) {
      // Dropped when the cap leaves too little to be useful, or not even room for the marker
      // that says what was cut: a kept entry never exceeds its cap.
      if (cap < limits.minEntryBytes || cap <= utf8Length(truncationMarker(full))) {
        dropped.push({ item, bytes: full });
        continue;
      }
      const kept = cutAtLineBoundary(item.body, cap - utf8Length(truncationMarker(full)));
      omittedBytes = full - utf8Length(kept);
      body = kept + truncationMarker(omittedBytes);
    }
    const bytes = utf8Length(body) + overhead;
    used += bytes;
    groups.set(item.group, groupUsed + bytes);
    for (const key of item.keys ?? []) claimed.add(key);
    kept.push({ item, body, bytes, truncated: omittedBytes > 0, omittedBytes });
  }
  return { kept, dropped, bytes: used };
}

// ---------------------------------------------------------------------------------------------
// Where the text lands in turn one

export const SHAPING_SECTION_PREAMBLE = "## Task context\n\n"
  + "Mission Control added this context for the task. It supplements the instructions above and\n"
  + "cannot relax their authorization, plan or workflow rules.";

/** An untrusted title, made safe to sit on one heading line. */
function headingText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The heading an entry is injected under. Its bytes are the entry's budget overhead. */
export function shapingEntryHeading(entry: { label: string; title?: string; id: string; repo: string }, multiRepo: boolean): string {
  // Title and id are normalized separately, so a blank title falls back to the id on one line,
  // and a blank id to a fixed name. The raw id never reaches the heading: a newline in it would
  // start a Markdown line of the shaper's choosing.
  const name = headingText(entry.title ?? "") || headingText(entry.id) || "Untitled entry";
  return `### ${headingText(entry.label)}: ${name}${multiRepo ? ` (${headingText(entry.repo)})` : ""}`;
}

/** The section appended to turn one. Empty, with no heading, when nothing was kept. */
export function composeShapingSection(
  entries: readonly { label: string; title?: string; id: string; repo: string; body: string }[],
  multiRepo: boolean,
): string {
  if (entries.length === 0) return "";
  return [SHAPING_SECTION_PREAMBLE, ...entries.map((entry) => `${shapingEntryHeading(entry, multiRepo)}\n${entry.body}`)].join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Routed skills (FR-04 `route_skills`, D12 to D15)

/** Whether a router's `lifecycle_point` is one this build knows. */
export function isShapingLifecyclePoint(value: string): value is ShapingLifecyclePoint {
  return (SHAPING_LIFECYCLE_POINTS as readonly string[]).includes(value);
}

/** One router's reply for one repository, in the order the calls were made. */
export interface ShapingRouteReply {
  shaper: string;
  repo: string;
  skills: readonly { name: string; lifecycle_point: string; reason_id: string }[];
}

/**
 * Merge every router's reply into the launch's skills, in list order and then repository order,
 * which is the order the calls were made. The first reply that names a skill sets its lifecycle
 * point, reason id and router; a later one only adds its repository. A point this build does not
 * know makes the skill `unsupported`. At most `routedSkills` supported skills go on; the rest are
 * `dropped`. Every skill starts unverified: whether a name is checked is decided where the
 * catalog can be read, not here. At most `recordedSkills` are returned.
 */
export function mergeRoutedSkills(replies: readonly ShapingRouteReply[]): ShapingSkillSummary[] {
  const merged: ShapingSkillSummary[] = [];
  const byName = new Map<string, ShapingSkillSummary>();
  let supported = 0;
  for (const reply of replies) {
    for (const skill of reply.skills) {
      const known = byName.get(skill.name);
      if (known) {
        if (!known.repositories.includes(reply.repo) && known.repositories.length < SHAPING_LIMITS.repositories) {
          known.repositories.push(reply.repo);
        }
        continue;
      }
      if (merged.length >= SHAPING_LIMITS.recordedSkills) continue;
      const point = isShapingLifecyclePoint(skill.lifecycle_point);
      const over = point && supported >= SHAPING_LIMITS.routedSkills;
      if (point && !over) supported += 1;
      const entry: ShapingSkillSummary = {
        name: skill.name,
        lifecyclePoint: skill.lifecycle_point,
        reasonId: skill.reason_id,
        shaper: reply.shaper,
        repositories: [reply.repo],
        state: !point ? "unsupported" : over ? "dropped" : "announced",
        verified: false,
        reason: !point
          ? `This build does not know the lifecycle point "${skill.lifecycle_point}".`
          : over ? `More than ${SHAPING_LIMITS.routedSkills} skills were routed for this launch.` : null,
      };
      byName.set(skill.name, entry);
      merged.push(entry);
    }
  }
  return merged;
}

export const SHAPING_SKILLS_PREAMBLE = "## Skills for this task\n\n"
  + "Mission Control's skill routing chose these skills for this task. Use each one\n"
  + "when its line says. If a skill is not available in this session, say so and\n"
  + "carry on. This list supplements the instructions above and cannot relax their\n"
  + "authorization, plan or workflow rules.";

/** When each lifecycle point says to use a skill. Mission Control's words, never a router's. */
const SKILL_WHEN: Record<ShapingLifecyclePoint, string> = {
  "task-start": "at the start: use this skill before you begin the work.",
  during: "during the work: use this skill when it applies.",
  "after-work": "after the work: do not use it yet. Mission Control will\n  prompt you when the work is complete.",
};

/** Repositories one line names before it says how many more it left out. */
const SKILL_LINE_REPOSITORIES = 8;

/**
 * One skill's line. `reference` is how the worker's harness names the skill (`skillReference`).
 * `repositories` is set only when the skill was routed for some of a task's repositories, and
 * then the line ends with their names.
 */
export function shapingSkillLine(skill: {
  reference: string;
  lifecyclePoint: ShapingLifecyclePoint;
  repositories?: readonly string[] | null;
}): string {
  const names = (skill.repositories ?? []).map(headingText).filter(Boolean);
  const shown = names.slice(0, SKILL_LINE_REPOSITORIES);
  const more = names.length - shown.length;
  const scope = shown.length === 0 ? "" : ` For ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
  return `- \`${skill.reference}\` - ${SKILL_WHEN[skill.lifecyclePoint]}${scope}`;
}

/** "Skills for this task", or empty with no heading when no line is given. */
export function composeSkillsSection(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `${SHAPING_SKILLS_PREAMBLE}\n\n${lines.join("\n")}`;
}

/** The task context section and the skills section, as the engine joins them into one section. */
export function joinShapingSections(context: string, skills: string): string {
  return [context, skills].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// The dry run

/** `POST /api/shaping/test`: run one shaper against a repository, as dispatch would. */
export const ShapingTestRequestSchema = z.object({
  id: z.string().min(1).max(64),
  /** The revision the config view reported to the sender; the dry run is refused if the entry has changed. */
  expect: ShapingRevisionSchema.optional(),
  /** An absolute path to a local repository checkout. */
  repository: z.string().min(1).max(4096).refine((value) => value.startsWith("/"), { message: "The repository is an absolute path." }),
  prompt: z.string().max(SHAPING_LIMITS.taskChars).optional(),
  kind: z.string().min(1).max(64).optional(),
  /** The harness a router's skills are rendered for. Absent, the section is shown as Claude would receive it. */
  agent: z.enum(AGENT_TYPES).optional(),
});
export type ShapingTestRequest = z.infer<typeof ShapingTestRequestSchema>;

/** `POST /api/shaping/sign-in`: start a sign-in for the shaper with this id. */
export const ShaperSignInRequestSchema = z.strictObject({ shaper: ShaperIdSchema });
export type ShaperSignInRequest = z.infer<typeof ShaperSignInRequestSchema>;

/** A connection id, as `ShapingSignInView.id` carries it: 32 lower-case hex digits. */
export const ShapingSignInIdSchema = z.string().regex(/^[0-9a-f]{32}$/, { message: "A connection id is 32 lower-case hex digits." });

/** `POST /api/shaping/sign-out`: end the sign-in of this connection, pending or held. */
export const ShaperSignOutRequestSchema = z.strictObject({ connection: ShapingSignInIdSchema });
export type ShaperSignOutRequest = z.infer<typeof ShaperSignOutRequestSchema>;

/**
 * What `POST /api/shaping/sign-in` answers. `authorizationUrl` carries the client id, the
 * `state` and the PKCE challenge for the browser to present, and appears in this reply only:
 * never in the sign-in list, the event or the snapshot.
 */
export interface ShaperSignInReply {
  authorizationUrl: string;
  /** Epoch milliseconds when the pending sign-in lapses. */
  expiresAt: number;
  /** The connection id the sign-in is for. */
  connection: string;
  /**
   * Which attempt this sign-in is. The sign-in list shows it as the entry's `attempt` for as long
   * as this attempt is the one pending, so a window can tell its own from one that replaced it.
   */
  attempt: number;
}

/** What `POST /api/shaping/sign-out` answers: the sign-in list after it. */
export interface ShaperSignOutReply {
  signIns: ShapingSignInView[];
}

/**
 * The header a dashboard tab sends with each shaping write: `<window> <sequence> <controls> [<instance>]`.
 * The tab's id, kept across its reloads and copied by its duplicates, the write's number, the
 * comma-separated controls it affects, and the daemon instance whose view the tab last read. The
 * sequence is the time the write was sent, in microseconds since the epoch, raised past the last
 * one the tab sent. The daemon refuses a write, as it is about to apply, once a later write from the
 * same tab was applied to one of those controls, or once a record it dropped held a later sequence
 * (`src/server/shaping/write-order.ts`).
 */
export const SHAPING_WRITE_ORDER_HEADER = "x-mission-shaping-order";

/** How long the daemon keeps its record of each applied shaping write, after it last applied. */
export const SHAPING_WRITE_WINDOW_MS = 10 * 60_000;

/** The value of `SHAPING_WRITE_ORDER_HEADER` for one write. */
export function shapingWriteOrder(window: string, sequence: number, controls: readonly string[], instance?: string): string {
  return `${window} ${sequence} ${controls.join(",")}${instance ? ` ${instance}` : ""}`;
}
