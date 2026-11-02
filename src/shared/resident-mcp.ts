// Resident MCP servers: the custom servers Mission Control defines, the global servers each
// harness configures, and the rules that keep their credentials out of everything the agent
// and the browser can read.
//
// Browser-safe and free of `node:` imports. The daemon validates request bodies with these
// schemas; the dashboard renders the same shapes.
//
// Secret values are write-only. A custom server's definition (`ResidentMcpCustomServer`) never
// holds one: a field marked secret stores only its name, and its value lives in the daemon's
// `resident_mcp_secrets` table, accepted on write and never returned. Reads say "set" or "not
// set" (`ResidentMcpCustomServerView`). A global server reaches the browser only as allowlisted
// metadata (`ResidentMcpGlobalServer`): its name, transport, the command's basename or the URL's
// origin, and the NAMES of its environment variables and headers.

import { z } from "zod";
import { RESIDENT_AGENTS, type ResidentAgent } from "./residents.ts";

/** Mission Control's own server: always attached, never selectable, never a custom name. */
export const RESIDENT_MCP_RESERVED_NAME = "mission-control";

export const RESIDENT_MCP_LIMITS = {
  /** Custom servers one machine may define. */
  servers: 64,
  nameLength: 64,
  commandLength: 4_096,
  args: 64,
  argLength: 4_096,
  urlLength: 4_096,
  /** Environment variables, headers or query parameters on one server. */
  fields: 64,
  fieldNameLength: 128,
  valueLength: 16_384,
} as const;

/**
 * A server's runtime name: the key every harness registers it under and the prefix of its
 * tools. Dots are allowed (`foo.bar` is one server on both harnesses, because the Codex overlay
 * writes it as a quoted TOML key).
 */
export const RESIDENT_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function residentMcpNameProblem(name: string): string | null {
  if (!name) return "an MCP server needs a name";
  if (name.length > RESIDENT_MCP_LIMITS.nameLength) {
    return `an MCP server name is at most ${RESIDENT_MCP_LIMITS.nameLength} characters`;
  }
  if (!RESIDENT_MCP_NAME_PATTERN.test(name)) {
    return "an MCP server name uses letters, digits, dot, dash and underscore, starting with a letter or digit";
  }
  if (name.toLowerCase() === RESIDENT_MCP_RESERVED_NAME) {
    return `${RESIDENT_MCP_RESERVED_NAME} is Mission Control's own server and is always attached`;
  }
  return null;
}

/**
 * Why a global server's name cannot be carried into a resident run, or null. A harness's own
 * configuration may use any key, but `__proto__` is not an ordinary key once it is copied into a
 * JavaScript object, so a server by that name could silently vanish from a launch.
 */
export function residentMcpGlobalNameProblem(name: string): string | null {
  return name === "__proto__" ? "its name __proto__ cannot be carried into a resident's configuration" : null;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters, the grammar of a header field name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const ServerName = z.string().trim().superRefine((name, ctx) => {
  const problem = residentMcpNameProblem(name);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});
const Harnesses = z
  .array(z.enum(RESIDENT_AGENTS))
  .min(1, "choose at least one harness this server applies to")
  .max(RESIDENT_AGENTS.length)
  .refine((agents) => new Set(agents).size === agents.length, "a harness is listed twice");
const Command = z.string().trim().min(1, "a stdio server needs a command").max(RESIDENT_MCP_LIMITS.commandLength);
const Args = z.array(z.string().max(RESIDENT_MCP_LIMITS.argLength)).max(RESIDENT_MCP_LIMITS.args);
const Value = z.string().max(RESIDENT_MCP_LIMITS.valueLength);

/** One stored environment variable or header: a secret one keeps only its name here. */
export const ResidentMcpStoredFieldSchema = z.discriminatedUnion("secret", [
  z.object({ name: z.string().min(1).max(RESIDENT_MCP_LIMITS.fieldNameLength), secret: z.literal(false), value: Value }),
  z.object({ name: z.string().min(1).max(RESIDENT_MCP_LIMITS.fieldNameLength), secret: z.literal(true) }),
]);
export type ResidentMcpStoredField = z.infer<typeof ResidentMcpStoredFieldSchema>;

/** A custom server's transport as stored: never a secret value, and never a URL query. */
export const ResidentMcpStoredTransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: Command,
    args: Args,
    env: z.array(ResidentMcpStoredFieldSchema).max(RESIDENT_MCP_LIMITS.fields),
  }),
  z.object({
    type: z.literal("http"),
    /** Without its query: every query value is a secret, added only by the launcher's bridge. */
    url: z.string().url().max(RESIDENT_MCP_LIMITS.urlLength),
    /** The query parameter names, in order. Every value is a secret. */
    query: z.array(z.string().min(1).max(RESIDENT_MCP_LIMITS.fieldNameLength)).max(RESIDENT_MCP_LIMITS.fields),
    headers: z.array(ResidentMcpStoredFieldSchema).max(RESIDENT_MCP_LIMITS.fields),
  }),
]);
export type ResidentMcpStoredTransport = z.infer<typeof ResidentMcpStoredTransportSchema>;

/** A custom server definition, as stored in `app_config` and carried by settings snapshots. */
export const ResidentMcpCustomServerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(RESIDENT_MCP_LIMITS.nameLength),
  harnesses: Harnesses,
  transport: ResidentMcpStoredTransportSchema,
  /** Every save increments it; a write names the revision it read (compare-and-set). */
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ResidentMcpCustomServer = z.infer<typeof ResidentMcpCustomServerSchema>;

/** The `residents.mcpServers` app_config document. */
export const ResidentMcpServersDocumentSchema = z
  .object({
    servers: z.array(ResidentMcpCustomServerSchema).max(RESIDENT_MCP_LIMITS.servers).default([]),
  })
  .superRefine(({ servers }, ctx) => {
    if (new Set(servers.map((server) => server.id)).size !== servers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["servers"], message: "custom MCP server ids must be unique" });
    }
    if (new Set(servers.map((server) => server.name.toLowerCase())).size !== servers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["servers"], message: "custom MCP server names must be unique" });
    }
  });
export type ResidentMcpServersDocument = z.infer<typeof ResidentMcpServersDocumentSchema>;

// ---- write requests: secrets accepted, never echoed ----

/**
 * One environment variable or header in a write. A non-secret one carries its value. A secret
 * one carries a value to set it, or no value to keep the value already stored (an update) or
 * leave it not set (a create). There is no way to read a secret back, so there is nothing to
 * round-trip.
 */
export const ResidentMcpFieldInputSchema = z
  .object({
    name: z.string().trim().min(1).max(RESIDENT_MCP_LIMITS.fieldNameLength),
    secret: z.boolean(),
    value: Value.optional(),
  })
  .strict()
  .refine((field) => field.secret || field.value !== undefined, "a field that is not secret needs a value");
export type ResidentMcpFieldInput = z.infer<typeof ResidentMcpFieldInputSchema>;

/** One URL query parameter in a write. Its value is always a secret; omit it to keep it. */
export const ResidentMcpQueryInputSchema = z
  .object({
    name: z.string().min(1).max(RESIDENT_MCP_LIMITS.fieldNameLength),
    value: Value.optional(),
  })
  .strict();

export const ResidentMcpTransportInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      command: Command,
      args: Args.default([]),
      env: z.array(ResidentMcpFieldInputSchema).max(RESIDENT_MCP_LIMITS.fields).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      /** May carry a query: its parameters join `query` below, every value a secret. */
      url: z.string().trim().min(1, "an HTTP server needs a URL").max(RESIDENT_MCP_LIMITS.urlLength),
      query: z.array(ResidentMcpQueryInputSchema).max(RESIDENT_MCP_LIMITS.fields).default([]),
      headers: z.array(ResidentMcpFieldInputSchema).max(RESIDENT_MCP_LIMITS.fields).default([]),
    })
    .strict(),
]);
export type ResidentMcpTransportInput = z.infer<typeof ResidentMcpTransportInputSchema>;

/** `POST /api/residents/mcp-servers`. */
export const CreateResidentMcpServerSchema = z
  .object({ name: ServerName, harnesses: Harnesses, transport: ResidentMcpTransportInputSchema })
  .strict();
export type CreateResidentMcpServer = z.infer<typeof CreateResidentMcpServerSchema>;

/** `PUT /api/residents/mcp-servers/:id`, compare-and-set on the revision the editor read. */
export const UpdateResidentMcpServerSchema = CreateResidentMcpServerSchema.extend({
  expectedRevision: z.number().int().positive(),
}).strict();
export type UpdateResidentMcpServer = z.infer<typeof UpdateResidentMcpServerSchema>;

/** `DELETE /api/residents/mcp-servers/:id`. */
export const DeleteResidentMcpServerSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

/** `POST /api/residents/mcp-catalog/refresh`. */
export const RefreshResidentMcpCatalogSchema = z.object({}).strict();

/**
 * `POST /api/residents/mcp/redeem`: the scoped launcher trading its single-use ticket for its
 * own server's definition. The run and server name come from the launcher's arguments and must
 * match what the ticket was bound to.
 */
export const RedeemResidentMcpTicketSchema = z
  .object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "a launch ticket is 32 random bytes"),
    runId: z.string().uuid(),
    server: z.string().min(1).max(RESIDENT_MCP_LIMITS.nameLength),
  })
  .strict();

// ---- reads ----

/** A stored field as the browser sees it: a secret one says only whether it is set. */
export type ResidentMcpFieldView =
  | { name: string; secret: false; value: string }
  | { name: string; secret: true; set: boolean };

export type ResidentMcpTransportView =
  | { type: "stdio"; command: string; args: string[]; env: ResidentMcpFieldView[] }
  | { type: "http"; url: string; query: Array<{ name: string; set: boolean }>; headers: ResidentMcpFieldView[] };

/** A custom server as every route returns it. No secret value is reachable from here. */
export interface ResidentMcpCustomServerView {
  id: string;
  name: string;
  harnesses: ResidentAgent[];
  transport: ResidentMcpTransportView;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A global server as the catalog projects it: allowlisted metadata only. Never its arguments,
 * its full command or URL, or any environment or header value, all of which may be credentials
 * that native configuration does not mark.
 */
export interface ResidentMcpGlobalServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  /** The last path segment of a stdio command. */
  commandBasename: string | null;
  /** The scheme, host and port of an HTTP server's URL. */
  urlOrigin: string | null;
  envNames: string[];
  headerNames: string[];
  /** False when the harness's own configuration disables it, so it is not a default. */
  enabled: boolean;
  /** Why a resident cannot use this server, naming the field, or null when it can. */
  unavailable: string | null;
}

export interface ResidentMcpHarnessCatalog {
  agent: ResidentAgent;
  /**
   * Whether a measured per-launch control pins this harness's MCP set
   * (`HARNESS_CAPABILITIES[agent].mcpSelection`). When false the editor offers no MCP choice.
   */
  selectable: boolean;
  servers: ResidentMcpGlobalServer[];
  /** Why the harness's configuration could not be read, or null. */
  problem: string | null;
  readAt: number;
}

/** `GET /api/residents/mcp-catalog`: on demand and on refresh, never an SSE collection. */
export interface ResidentMcpCatalog {
  harnesses: ResidentMcpHarnessCatalog[];
  custom: ResidentMcpCustomServerView[];
}

// ---- credential-form detection ----

/** Name segments that mark a value as a credential when they name a flag or a pair. */
const CREDENTIAL_SEGMENTS = new Set([
  "token", "key", "apikey", "secret", "password", "passwd", "pwd", "pass", "passphrase",
  "auth", "authorization", "bearer", "credential", "credentials", "cookie",
]);
/** Substrings that mark a run-together name (`accesstoken`, `clientsecret`). */
const CREDENTIAL_PARTS = ["token", "secret", "password", "passwd", "apikey", "bearer", "credential", "authorization"];

/** Whether a flag or pair name says its value is a credential. */
export function credentialName(name: string): boolean {
  const lower = name.toLowerCase().replace(/^-+/, "");
  if (!lower) return false;
  if (lower.split(/[-_.]+/).some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  return CREDENTIAL_PARTS.some((part) => lower.includes(part));
}

function urlCredential(text: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.username || url.password) return "a URL with a user name or password";
    if (url.search.length > 1) return "a URL with a query";
  } catch {
    return null;
  }
  return null;
}

/** A flag's name alone: up to `=` or whitespace, so `--token abc` names `--token` and nothing more. */
const FLAG_NAME = /^-{1,2}[A-Za-z][A-Za-z0-9_.-]*/;

/**
 * Why one command-line argument looks like a credential, or null.
 *
 * A guard, not a proof: an argument that passes may still hold a secret, which is why the
 * editor says arguments are stored and backed up as written. What it refuses is the shapes that
 * put a credential on a command line every process can read:
 *
 * - a flag or `name=value` pair whose name indicates a token, key, secret, password or
 *   authorization (`--api-key`, `--token=abc`, `GITHUB_TOKEN=abc`);
 * - a URL with userinfo or a query;
 * - a bearer or basic credential.
 */
export function credentialFormArgument(arg: string): string | null {
  const text = arg.trim();
  if (!text) return null;
  if (/^(bearer|basic)\s+\S/i.test(text) || /^authorization\s*:/i.test(text)) return "a bearer or basic credential";
  const url = urlCredential(text);
  if (url) return url;
  const pair = /^(-{0,2}[A-Za-z0-9][A-Za-z0-9_.-]*)=(.*)$/s.exec(text);
  if (pair) {
    if (credentialName(pair[1]!)) return "a credential-named value";
    const inner = urlCredential(pair[2]!);
    if (inner) return inner;
    return null;
  }
  const flag = FLAG_NAME.exec(text)?.[0];
  if (flag && credentialName(flag)) return "a credential-named flag";
  return null;
}

/** The first credential-form argument, with its position, or null. */
export function credentialFormArgs(args: readonly string[]): { index: number; arg: string; reason: string } | null {
  for (const [index, arg] of args.entries()) {
    const reason = credentialFormArgument(arg);
    if (reason) return { index, arg, reason };
  }
  return null;
}

/**
 * The refusal an editor or launch shows for a credential-form argument: its position and form,
 * and for a credential-named flag or pair the flag's name, which is never part of a value. No
 * other part of the argument is echoed, because the refusal reaches the browser and the log.
 */
export function credentialArgumentProblem(found: { index: number; arg: string; reason: string }): string {
  const pair = /^(-{0,2}[A-Za-z0-9][A-Za-z0-9_.-]*)=/s.exec(found.arg.trim());
  const name = found.reason === "a credential-named value" && pair
    ? pair[1]
    : found.reason === "a credential-named flag"
      ? FLAG_NAME.exec(found.arg.trim())?.[0] ?? null
      : null;
  const shown = name ? ` (${name})` : "";
  return `argument ${found.index + 1}${shown} looks like ${found.reason}; put the credential in a secret environment variable instead`;
}

/** Whether a URL names this machine, where plain http never leaves the loopback interface. */
export function residentMcpLoopbackHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Why a URL may not carry an MCP server's credentials, or null. Secret headers and query values
 * travel only over https, or over plain http to this machine; anywhere else they would cross
 * the network unencrypted.
 */
export function plaintextCredentialProblem(url: URL): string | null {
  return url.protocol === "http:" && !residentMcpLoopbackHost(url)
    ? "it would send its credentials over plain http to another host; use https"
    : null;
}

export function residentMcpEnvNameProblem(name: string): string | null {
  return ENV_NAME.test(name) ? null : `${name} is not an environment variable name`;
}

export function residentMcpHeaderNameProblem(name: string): string | null {
  return HEADER_NAME.test(name) ? null : `${name} is not a header name`;
}

/** Project a stored custom server to what a route may return: names and "set", never values. */
export function residentMcpCustomServerView(
  server: ResidentMcpCustomServer,
  isSet: (field: string) => boolean,
): ResidentMcpCustomServerView {
  const fields = (kind: "env" | "header", rows: readonly ResidentMcpStoredField[]): ResidentMcpFieldView[] =>
    rows.map((row) => row.secret
      ? { name: row.name, secret: true, set: isSet(residentMcpSecretField(kind, row.name)) }
      : { name: row.name, secret: false, value: row.value });
  const transport: ResidentMcpTransportView = server.transport.type === "stdio"
    ? {
        type: "stdio",
        command: server.transport.command,
        args: [...server.transport.args],
        env: fields("env", server.transport.env),
      }
    : {
        type: "http",
        url: server.transport.url,
        query: server.transport.query.map((name) => ({ name, set: isSet(residentMcpSecretField("query", name)) })),
        headers: fields("header", server.transport.headers),
      };
  return {
    id: server.id,
    name: server.name,
    harnesses: [...server.harnesses],
    transport,
    revision: server.revision,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

/** The secrets-table key of one secret field: its kind and its name. */
export function residentMcpSecretField(kind: "env" | "header" | "query", name: string): string {
  return `${kind}:${name}`;
}

/**
 * What the scoped launcher receives for one server when it redeems its ticket: that server's
 * whole definition, secrets included, and nothing about any other server. It travels only over
 * the daemon's loopback answer to that one launcher process, which starts the server with it.
 */
export type ResidentMcpLauncherDefinition =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string | null }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> };

/** The credential file a launcher entry names: owner-only, created exclusively, read once. */
export interface ResidentMcpCredentialFile {
  ticket: string;
  expiresAt: number;
  redeemUrl: string;
}
