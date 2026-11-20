import { z } from "zod";
import { boundedRecord, partialPatch } from "./zod-shapes.ts";
import {
  SHAPING_BUILTINS,
  SHAPING_ORIGINS,
  SHAPING_OUTCOMES,
  SHAPING_REFERENCE_KINDS,
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
  /** Text one reply may carry in any one string, before Mission Control applies its caps. */
  replyText: 256 * KIB,
  /** The bound on a reason recorded for an outcome. */
  reasonChars: 500,
  /** Facts one repository may carry, and values in one list-valued fact. */
  facts: 64,
  /** Repositories one task may carry into a request. */
  repositories: 32,
  /** The operator's prompt as carried in a request. */
  taskChars: 1_000_000,
} as const;

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
  z.strictObject({ type: z.literal("http"), url: UrlSchema, headers: HeadersSchema }),
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
});

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
    label: z.string().trim().min(1).max(120),
    stage: z.enum(stages),
    protocol: z.literal(SHAPING_PROTOCOL).default(SHAPING_PROTOCOL),
    transport: ShaperTransportSchema,
    /** Task kinds this shaper serves. Empty means every kind. */
    kinds: z.array(z.string().min(1).max(64)).max(32).default([]),
    /** Repository names this shaper serves. Empty means every repository. */
    repositories: z.array(z.string().min(1).max(256)).max(64).default([]),
    /** This shaper's own call timeout. Absent means the config's default. */
    timeoutMs: z.number().int().min(SHAPING_LIMIT_RANGES.timeoutMs.min).max(SHAPING_LIMIT_RANGES.timeoutMs.max).optional(),
    /** This shaper's own share of the context budget. Absent means the config's default. */
    maxBytes: z.number().int().min(SHAPING_LIMIT_RANGES.maxBytes.min).max(SHAPING_LIMIT_RANGES.maxBytes.max).optional(),
    /** An optional content pin, sent as the request's `version`. */
    version: z.string().min(1).max(256).nullable().default(null),
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

/** Headers that carry an HTTP authentication scheme before their credential. */
const SCHEME_HEADERS = new Set(["authorization", "proxy-authorization"]);
/** The schemes such a header may name. Any other leading word is treated as the secret itself. */
export const SHAPING_AUTH_SCHEMES = ["Bearer", "Basic", "Token", "Digest"] as const;

/**
 * A credential-bearing value may hold its secret only as a reference, resolved at call time.
 * Empty is fine. Otherwise it is references only, at least one of them `{env:NAME}`. Only an
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
  return references !== null && references.some((reference) => reference.startsWith("env:"));
}

/** Name segments that say an argument names where a credential lives, not the credential itself. */
const CREDENTIAL_LOCATOR_SEGMENTS = new Set(["file", "path", "dir", "name", "id", "url", "type", "env"]);

function credentialArgumentName(name: string): boolean {
  const segments = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return credentialBearingName(name) && !segments.some((segment) => CREDENTIAL_LOCATOR_SEGMENTS.has(segment));
}

/**
 * The arguments that hand a credential over as literal text: `--token=abc`, `api_key=abc`, or a
 * credential flag such as `--api-key` followed by its value. Arguments are stored and backed up
 * as written and are never resolved, so a secret belongs in `env`, named, instead.
 */
function literalCredentialArguments(args: readonly string[]): number[] {
  const found: number[] = [];
  args.forEach((arg, index) => {
    const assigned = /^-{0,2}([A-Za-z][A-Za-z0-9_.-]*)=(.+)$/.exec(arg);
    if (assigned && credentialArgumentName(assigned[1]!)) found.push(index);
    const flag = /^-{1,2}([A-Za-z][A-Za-z0-9_.-]*)$/.exec(arg);
    const next = args[index + 1];
    if (flag && credentialArgumentName(flag[1]!) && next !== undefined && !next.startsWith("-")) found.push(index + 1);
  });
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The same entry with every literal credential emptied: a credential-bearing header value that
 * is not a reference, a URL's userinfo and credential query parameters, and a credential
 * argument. A definition this build writes can hold none of these, because the strict schema
 * refuses them. This covers everything else the config may be handed - a settings restore, or
 * an entry a newer build stored - so no path leaves secret text in `app_config.shaping` or in
 * the `shaping` domain of a snapshot. Every other field is kept exactly as written.
 */
export function withoutLiteralCredentials(stored: StoredShaper): StoredShaper {
  const transport = stored.transport as Record<string, unknown>;
  const fromServer = transport.type === "mcp" && isRecord(transport.server);
  const holder = { ...(fromServer ? transport.server as Record<string, unknown> : transport) };
  let changed = false;
  if (isRecord(holder.headers)) {
    const headers: Record<string, unknown> = { ...holder.headers };
    for (const [name, value] of Object.entries(headers)) {
      if (credentialBearingName(name) && !(typeof value === "string" && credentialValueIsReferenced(name, value))) {
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
      // A copy of the names first: deleting while iterating the live list would skip entries.
      const names = Array.from(url.searchParams.keys());
      for (const name of names) if (credentialBearingName(name)) url.searchParams.delete(name);
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
    const literal = new Set(literalCredentialArguments(args));
    if (literal.size > 0) {
      holder.args = holder.args.map((arg, index) => (literal.has(index) ? "" : arg));
      changed = true;
    }
  }
  if (!changed) return stored;
  const nextTransport = fromServer ? { ...transport, server: holder } : { ...transport, ...holder };
  return { ...stored, transport: nextTransport as StoredShaper["transport"] };
}

/** The credential rule over a whole definition's headers, URLs and arguments. */
function credentialsAreReferences(value: unknown, ctx: z.RefinementCtx): void {
  const transport = (value as { transport?: Record<string, unknown> }).transport;
  if (!transport) return;
  const server = transport.type === "mcp" ? transport.server as Record<string, unknown> | undefined : undefined;
  const at = server ? ["transport", "server"] : ["transport"];
  const holder = server ?? transport;
  const args = Array.isArray(holder.args) ? holder.args.filter((arg): arg is string => typeof arg === "string") : [];
  for (const index of literalCredentialArguments(args)) {
    ctx.addIssue({
      code: "custom", path: [...at, "args", index],
      message: "This argument hands over a credential as literal text, which would be stored and backed up. Name the variable in env instead, so the secret is passed from the daemon's environment.",
    });
  }
  const headers = (holder.headers ?? {}) as Record<string, string>;
  for (const [name, header] of Object.entries(headers)) {
    if (credentialBearingName(name) && !credentialValueIsReferenced(name, header)) {
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
  for (const name of url.searchParams.keys()) {
    if (credentialBearingName(name)) {
      ctx.addIssue({
        code: "custom", path: [...at, "url"],
        message: `The URL's "${name}" parameter looks like a credential. Send it in a header as {env:NAME}, so no secret is stored or backed up.`,
      });
    }
  }
}

const ShaperObjectSchema = z.strictObject(shaperFields(SHAPING_STAGES));

/** The strict definition this build understands. Stored entries are checked against it. */
export const ShaperSchema = ShaperObjectSchema
  .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
  .superRefine(credentialsAreReferences);
export type Shaper = z.output<typeof ShaperSchema>;

/** A manifest in the shapers folder: the strict definition plus whether it starts switched on. */
export const ShaperManifestSchema = ShaperObjectSchema
  .extend({ enabled: z.boolean().optional() })
  .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
  .superRefine(credentialsAreReferences);
export type ShaperManifest = z.output<typeof ShaperManifestSchema>;

/** The strict definition over a different stage tuple, so a test can model another build. */
export function shaperSchemaForStages(stages: readonly [string, ...string[]]): z.ZodType<Shaper> {
  return z.strictObject(shaperFields(stages))
    .superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes))
    .superRefine(credentialsAreReferences) as unknown as z.ZodType<Shaper>;
}

/** What a pure function reads from the registry. Tests pass their own. */
export interface ShapingDefinitions {
  readonly stages: readonly string[];
  readonly shaper: z.ZodType<Shaper>;
}
export const SHAPING_DEFINITIONS: ShapingDefinitions = Object.freeze({ stages: SHAPING_STAGES, shaper: ShaperSchema });

/** Bounded JSON, for the fields of a stored entry this build may not understand. */
export const ShapingJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(SHAPING_LIMITS.entryJsonBytes),
  z.array(ShapingJsonValueSchema).max(256),
  boundedRecord(z.string().max(256), ShapingJsonValueSchema, 256),
]));

/**
 * The envelope `app_config.shaping` stores. A stage or transport id this build has never heard
 * of is valid here, so one such entry invalidates neither the config nor any other shaper.
 * Every field beyond the four named ones is kept exactly as it was written.
 */
export const StoredShaperSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(200),
  stage: z.string().min(1).max(64),
  transport: z.object({ type: z.string().min(1).max(64) }).catchall(ShapingJsonValueSchema),
}).catchall(ShapingJsonValueSchema).superRefine(jsonBytesWithin(SHAPING_LIMITS.entryJsonBytes));
export type StoredShaper = z.output<typeof StoredShaperSchema>;

export type ClassifiedShaper =
  | { kind: "known"; stored: StoredShaper; shaper: Shaper }
  | { kind: "unsupported"; stored: StoredShaper; reason: string };

function issueSentence(error: z.ZodError, maxChars: number = SHAPING_LIMITS.reasonChars): string {
  const issue = error.issues[0];
  if (!issue) return "The definition is not valid.";
  const at = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${at}${issue.message}`.slice(0, maxChars);
}

/** A known shaper, or an unsupported entry with the reason this build cannot run it. */
export function classifyShaper(
  stored: StoredShaper,
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ClassifiedShaper {
  if (!definitions.stages.includes(stored.stage)) {
    return { kind: "unsupported", stored, reason: `This build does not support the "${stored.stage}" stage.` };
  }
  if (!(SHAPING_TRANSPORTS as readonly string[]).includes(stored.transport.type)) {
    return { kind: "unsupported", stored, reason: `This build does not support the "${stored.transport.type}" transport.` };
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

/** Set or not set, per `{env:NAME}` any shaper references. Never a value. */
export type ShapingReferenceStatus = Record<string, "set" | "unset">;

// ---------------------------------------------------------------------------------------------
// Intents

export const ShapingIntentSchema = z.discriminatedUnion("kind", [
  /** Create or replace a registered shaper. Only a definition this build understands. */
  z.object({ kind: z.literal("upsert"), shaper: ShaperSchema }),
  z.object({ kind: z.literal("remove"), id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("enable"), id: z.string().min(1).max(64), enabled: z.boolean() }),
  z.object({ kind: z.literal("reorder"), order: z.array(z.string().min(1).max(64)).max(SHAPING_LIMITS.choices) }),
  z.object({
    kind: z.literal("settings"),
    caller: partialPatch(ShapingCallerObjectSchema).optional(),
    limits: partialPatch(ShapingLimitsObjectSchema).optional(),
  }),
]);
export type ShapingIntent = z.infer<typeof ShapingIntentSchema>;

export type ShapingIntentError =
  | "unknown_shaper"
  | "unsupported_shaper"
  | "invalid_shaper"
  | "too_many_shapers";

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
  definitions: ShapingDefinitions = SHAPING_DEFINITIONS,
): ShapingIntentResult {
  const refuse = (error: ShapingIntentError, reason: string): ShapingIntentResult => ({ ok: false, error, reason });
  const shapers = [...config.shapers];
  const overrides = { ...config.overrides };
  let order = [...config.order];
  const index = (id: string) => shapers.findIndex((entry) => entry.id === id);
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
        // A new registered shaper is off until the operator switches it on, whatever an earlier
        // choice for the same id said.
        delete overrides[parsed.data.id];
      } else {
        const existing = classifyShaper(shapers[at]!, definitions);
        if (existing.kind === "unsupported") {
          return refuse("unsupported_shaper", `"${parsed.data.id}" is stored in a form this build does not understand, so it can only be switched off or removed. ${existing.reason}`);
        }
        shapers[at] = stored.data;
      }
      break;
    }
    case "remove": {
      if (index(intent.id) === -1) return refuse("unknown_shaper", `No registered shaper has the id "${intent.id}".`);
      for (let at = index(intent.id); at !== -1; at = index(intent.id)) shapers.splice(at, 1);
      delete overrides[intent.id];
      order = order.filter((id) => id !== intent.id);
      break;
    }
    case "enable": {
      const at = index(intent.id);
      const found = discovered.find((entry) => entry.id === intent.id);
      if (at === -1 && !found) return refuse("unknown_shaper", `No shaper has the id "${intent.id}".`);
      if (intent.enabled) {
        if (at !== -1) {
          const classified = classifyShaper(shapers[at]!, definitions);
          if (classified.kind === "unsupported") return refuse("unsupported_shaper", classified.reason);
        } else if (found && found.state !== "ok") {
          return refuse("unsupported_shaper", found.problem ?? `The shaper "${intent.id}" cannot run.`);
        }
      }
      if (!Object.hasOwn(overrides, intent.id) && Object.keys(overrides).length >= SHAPING_LIMITS.choices) {
        // Choices for ids that no longer exist make room before a live one is refused.
        const live = new Set([...shapers.map((entry) => entry.id), ...discovered.map((entry) => entry.id)]);
        for (const id of Object.keys(overrides)) if (!live.has(id)) delete overrides[id];
      }
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
      enabled: Object.hasOwn(config.overrides, entry.shaper.id) ? config.overrides[entry.shaper.id]! : false,
    });
  });
  for (const entry of discovered) {
    // A registered shaper wins an id clash, whatever the scan reported.
    if (entry.state !== "ok" || !entry.shaper || registered.has(entry.id) || entry.shaper.id !== entry.id) continue;
    if (out.some((candidate) => candidate.shaper.id === entry.id)) continue;
    const parsed = definitions.shaper.safeParse(stripManifestFields(entry.shaper));
    if (!parsed.success) continue;
    out.push({
      shaper: parsed.data, origin: "discovered", stored: null, sha256: entry.sha256, root: entry.path,
      position: Number.MAX_SAFE_INTEGER,
      enabled: Object.hasOwn(config.overrides, entry.id) ? config.overrides[entry.id]! : entry.shaper.enabled !== false,
    });
  }
  return out;
}

function stripManifestFields(manifest: ShaperManifest): unknown {
  const { enabled: _enabled, ...shaper } = manifest;
  return shaper;
}

/**
 * The ordering rule: stage order, then the stored `order`, then unlisted registered shapers in
 * stored order, then unlisted discovered shapers by id.
 */
function compareCandidates(order: readonly string[], stages: readonly string[]) {
  const rank = new Map(order.map((id, at) => [id, at]));
  return (a: Candidate, b: Candidate): number => {
    const stage = stages.indexOf(a.shaper.stage) - stages.indexOf(b.shaper.stage);
    if (stage !== 0) return stage;
    const ra = rank.get(a.shaper.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.shaper.id) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    if (a.position !== b.position) return a.position - b.position;
    return a.shaper.id < b.shaper.id ? -1 : a.shaper.id > b.shaper.id ? 1 : 0;
  };
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
  return candidates(config, discovered, definitions)
    .filter((candidate) => candidate.enabled)
    .filter((candidate) => candidate.shaper.kinds.length === 0 || candidate.shaper.kinds.includes(input.kind))
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

const FactValueSchema = z.union([
  z.string().max(1024),
  z.array(z.string().max(1024)).max(SHAPING_LIMITS.facts),
]);
export const ShapingFactsSchema = boundedRecord(z.string().min(1).max(128), FactValueSchema, SHAPING_LIMITS.facts);
export type ShapingFacts = z.output<typeof ShapingFactsSchema>;

export const ShapingRepositoryRefSchema = z.object({
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
  caller: z.object({
    user: z.string().max(256).nullable(),
    agent: z.string().max(64).nullable(),
    conversation: z.string().max(128).nullable(),
  }),
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
  version: z.string().max(256).optional(),
  context: ShapingContextSchema,
  limits: z.object({ maxBytes: z.number().int().positive(), deadlineMs: z.number().int().nonnegative() }),
});
export type ShapingRequest = z.output<typeof ShapingRequestSchema>;

export const ShapingEntrySchema = z.object({
  id: z.string().min(1).max(512),
  path: z.string().max(1024).optional(),
  title: z.string().max(512).optional(),
  body: z.string().max(SHAPING_LIMITS.replyText),
  truncated: z.boolean().optional(),
});
export type ShapingEntry = z.output<typeof ShapingEntrySchema>;

/**
 * The one result shape, at every stage and over every transport: FR-02's `get_guidance` reply
 * plus fields a shaper may omit. Unknown fields are ignored (`protocol: 1` compatibility).
 */
export const ShapingResultSchema = z.object({
  version: z.string().max(256).nullable().optional(),
  guidance: z.array(ShapingEntrySchema).max(SHAPING_LIMITS.replyEntries).default([]),
  truncated: z.boolean().optional(),
  degraded: z.boolean().optional(),
  repo: z.object({
    facts: ShapingFactsSchema.optional(),
    summary: z.string().max(SHAPING_LIMITS.replyText).optional(),
  }).optional(),
  notes: z.array(z.string().max(1000)).max(16).optional(),
});
export type ShapingResult = z.output<typeof ShapingResultSchema>;

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
  version: z.string().max(256).nullable(),
});
export type ShapingShaperSummary = z.output<typeof ShapingShaperSummarySchema>;

/** What a launch records. Absent when no shaper applied. */
export const TaskShapingSchema = z.object({
  state: z.enum(["ok", "degraded"]),
  at: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  shapers: z.array(ShapingShaperSummarySchema).max(SHAPING_LIMITS.shapers * 2),
});
export type TaskShaping = z.output<typeof TaskShapingSchema>;

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
    const worst = calls.reduce((a, b) => (OUTCOME_SEVERITY.indexOf(b.outcome) < OUTCOME_SEVERITY.indexOf(a.outcome) ? b : a));
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

/** One line for a task read, such as `degraded: acme-guidance timed out`. */
export function shapingSummaryLine(summary: TaskShaping): string {
  const entries = `${summary.entries} ${summary.entries === 1 ? "entry" : "entries"}`;
  if (summary.state === "ok") {
    return `ok: ${entries} from ${summary.shapers.length} ${summary.shapers.length === 1 ? "shaper" : "shapers"}${summary.truncated ? ", truncated" : ""}`;
  }
  const problems = summary.shapers.filter((shaper) => shaper.outcome !== "ok")
    .map((shaper) => `${shaper.id} ${OUTCOME_WORDS[shaper.outcome]}`);
  return `degraded: ${problems.join(", ")}; ${entries}`;
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
 * omitted. An item that does not fit with less than `minEntryBytes` left is dropped.
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
  let used = 0;
  for (const item of items) {
    const overhead = Math.max(0, item.overhead ?? 0);
    const full = utf8Length(item.body);
    const groupUsed = groups.get(item.group) ?? 0;
    const room = Math.min(totalBytes - used, item.groupBytes - groupUsed) - overhead;
    const cap = Math.min(room, limits.entryBytes);
    let body = item.body;
    let omittedBytes = 0;
    if (full > cap) {
      if (cap < limits.minEntryBytes) {
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
// The dry run

/** `POST /api/shaping/test`: run one shaper against a repository, as dispatch would. */
export const ShapingTestRequestSchema = z.object({
  id: z.string().min(1).max(64),
  /** An absolute path to a local repository checkout. */
  repository: z.string().min(1).max(4096).refine((value) => value.startsWith("/"), { message: "The repository is an absolute path." }),
  prompt: z.string().max(SHAPING_LIMITS.taskChars).optional(),
  kind: z.string().min(1).max(64).optional(),
});
export type ShapingTestRequest = z.infer<typeof ShapingTestRequestSchema>;
