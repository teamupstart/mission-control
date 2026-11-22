// Task shaping's shared contract: registry data, schemas, the enablement and ordering rule,
// every intent, the stored entries this build does not understand, the budget and the section.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as registry from "../src/shared/shaping-registry.ts";
import {
  allocateBudget,
  applyShapingIntent,
  canonicalJson,
  classifyShaper,
  classifyShapers,
  clipUtf8,
  composeShapingSection,
  cutAtLineBoundary,
  resolveShaperById,
  resolveShapers,
  SHAPING_CONFIG_DEFAULTS,
  SHAPING_DEFINITIONS,
  SHAPING_LIMITS,
  SHAPING_SECTION_PREAMBLE,
  credentialBearingName,
  credentialLookingHeader,
  credentialValueIsReferenced,
  credentialsWereRemoved,
  ShaperIdSchema,
  shaperIsLocal,
  ShaperManifestSchema,
  shapedByDefault,
  shapingSlot,
  ShapingRequestSchema,
  TaskShapingSchema,
  ShaperSchema,
  shaperSchemaForStages,
  ShapingConfigSchema,
  ShapingIntentSchema,
  ShapingResultSchema,
  SHAPING_MAX_NESTING,
  nestsWithin,
  SHAPING_REFERENCE_SPELLINGS,
  shapingEntryHeading,
  shapingReferences,
  shapingSummaryLine,
  StoredShaperSchema,
  summariseShaping,
  utf8Length,
  withoutLiteralCredentials,
  type DiscoveredShaper,
  type ShapingConfig,
  type ShapingIntent,
  type StoredShaper,
  announcedSkills,
  composeSkillsSection,
  joinShapingSections,
  mergeRoutedSkills,
  SHAPING_SKILLS_RESERVE_BYTES,
  shapingSkillLine,
  ShapingRouteResultSchema,
  ShapingSkillNameSchema,
  taskShapingRead,
  type ShapingSkillSummary,
  type TaskShaping,
} from "../src/shared/shaping.ts";
import { skillReference } from "../src/shared/harness-capabilities.ts";
import { daemonShapingView } from "../src/server/shaping/revisions.ts";

const command = (id: string, stage: "gather" | "select" = "gather", extra: Record<string, unknown> = {}) => ShaperSchema.parse({
  id, label: id.toUpperCase(), stage, transport: { type: "command", command: "/usr/bin/true" }, ...extra,
});
const config = (patch: Partial<ShapingConfig> = {}): ShapingConfig => ShapingConfigSchema.parse({ ...patch });
const task = { kind: "ship", repositories: [{ name: "billing-api" }, { name: "ledger" }] };
function discovered(id: string, enabled?: boolean, state: DiscoveredShaper["state"] = "ok"): DiscoveredShaper {
  return {
    id, path: `/state/shapers/${id}`, state, problem: state === "ok" ? null : "Refused.", sha256: "a".repeat(64),
    shaper: ShaperManifestSchema.parse({
      id, label: id, stage: "select", transport: { type: "http", url: "https://example.test/shape" },
      ...(enabled === undefined ? {} : { enabled }),
    }),
  };
}
function apply(base: ShapingConfig, intent: ShapingIntent, found: DiscoveredShaper[] = []) {
  const result = applyShapingIntent(base, intent, found);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { config: ShapingConfig }).config;
}
const ids = (resolved: { shaper: { id: string } }[]) => resolved.map((entry) => entry.shaper.id);

/** A shaper written by a later build: a stage and a transport this one has never heard of. */
const future: StoredShaper = StoredShaperSchema.parse({
  id: "skill-router", label: "Skill router", stage: "audit",
  transport: { type: "grpc", endpoint: "dns:///router", deadline: { ms: 4000 } },
  protocol: 1, kinds: [], futureField: { nested: [1, "two", null] },
});

test("registry data is append-only tuples, unique, and disjoint from its tombstones", () => {
  assert.deepEqual(Object.keys(registry).sort(), [
    "RETIRED_SHAPING_BUILTINS", "RETIRED_SHAPING_LIFECYCLE_POINTS", "RETIRED_SHAPING_PROMPT_STATES",
    "RETIRED_SHAPING_SKILL_STATES", "RETIRED_SHAPING_STAGES", "RETIRED_SHAPING_TRANSPORTS",
    "SHAPING_BUILTINS", "SHAPING_LIFECYCLE_POINTS", "SHAPING_ORIGINS", "SHAPING_OUTCOMES",
    "SHAPING_PROMPT_STATES", "SHAPING_REFERENCE_KINDS", "SHAPING_SKILL_STATES",
    "SHAPING_STAGES", "SHAPING_TRANSPORTS",
  ]);
  // `route` is appended after the two stages it follows, never inserted between them.
  assert.deepEqual(registry.SHAPING_STAGES, ["gather", "select", "route"]);
  assert.deepEqual(registry.SHAPING_LIFECYCLE_POINTS, ["task-start", "during", "after-work"]);
  assert.deepEqual(registry.SHAPING_SKILL_STATES, ["announced", "superseded", "unavailable", "unsupported", "dropped"]);
  assert.deepEqual(registry.SHAPING_PROMPT_STATES, ["held", "queued", "delivered", "skipped", "not_delivered"]);
  assert.deepEqual(registry.SHAPING_TRANSPORTS, ["command", "mcp", "http", "builtin"]);
  assert.deepEqual(registry.SHAPING_BUILTINS, [{ id: "repository-files", stages: ["gather"] }]);
  assert.deepEqual(registry.SHAPING_OUTCOMES, ["ok", "degraded", "failed", "timed_out", "invalid", "unavailable"]);
  assert.deepEqual(registry.SHAPING_ORIGINS, ["registered", "discovered"]);
  for (const [live, retired] of [
    [registry.SHAPING_STAGES, registry.RETIRED_SHAPING_STAGES],
    [registry.SHAPING_LIFECYCLE_POINTS, registry.RETIRED_SHAPING_LIFECYCLE_POINTS],
    [registry.SHAPING_SKILL_STATES, registry.RETIRED_SHAPING_SKILL_STATES],
    [registry.SHAPING_PROMPT_STATES, registry.RETIRED_SHAPING_PROMPT_STATES],
    [registry.SHAPING_TRANSPORTS, registry.RETIRED_SHAPING_TRANSPORTS],
    [registry.SHAPING_BUILTINS.map((builtin) => builtin.id), registry.RETIRED_SHAPING_BUILTINS],
  ] as const) {
    assert.equal(new Set(live).size, live.length);
    assert.ok(live.every((id) => !(retired as readonly string[]).includes(id)));
  }
  for (const builtin of registry.SHAPING_BUILTINS) {
    assert.ok(builtin.stages.every((stage) => (registry.SHAPING_STAGES as readonly string[]).includes(stage)));
  }
});

test("the shared modules are browser-safe: no node: imports and no protocol.ts", () => {
  for (const file of ["src/shared/shaping.ts", "src/shared/shaping-registry.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /["'](?:node:|[^"']*protocol\.ts)/, file);
  }
  assert.doesNotMatch(readFileSync("src/shared/shaping-registry.ts", "utf8"), /^import /m, "the registry is data only");
});

test("id rules match the feature-flag rule", () => {
  for (const id of ["acme-guidance", "a", "repo-files-2", "a".repeat(64)]) assert.equal(ShaperIdSchema.safeParse(id).success, true, id);
  for (const id of ["", "Upper", "has_space", "-leading", "trailing-", "two--dashes", "9lives", "a".repeat(65)]) {
    assert.equal(ShaperIdSchema.safeParse(id).success, false, id);
    assert.equal(ShapingIntentSchema.safeParse({ kind: "upsert", shaper: { ...command("x"), id } }).success, false, id);
  }
});

test("the strict definition covers all four transports and fills defaults", () => {
  const stdio = ShaperSchema.parse({ id: "guide", label: "Guide", stage: "select",
    transport: { type: "mcp", server: { type: "stdio", command: "guide-server" }, tool: "get_guidance" } });
  assert.equal(stdio.transport.type === "mcp" && stdio.transport.contextDelivery, "folded");
  assert.deepEqual({ ...stdio, transport: undefined }, {
    id: "guide", label: "Guide", stage: "select", protocol: 1, transport: undefined, kinds: [], repositories: [], version: null,
  });
  const remote = ShaperSchema.parse({ id: "acme", label: "Acme", stage: "select", transport: { type: "mcp", tool: "get_guidance",
    contextDelivery: "argument", server: { type: "http", url: "https://context.acme.example/mcp",
      headers: { "x-acme-user-id": "{caller.user}", authorization: "Bearer {env:ACME_CONTEXT_TOKEN}" } } } });
  assert.equal(remote.transport.type === "mcp" && remote.transport.contextDelivery, "argument");
  assert.equal(ShaperSchema.safeParse({ ...remote, transport: { ...remote.transport, contextDelivery: "none" } }).success, false,
    "no delivery mode withholds the collected input");
  const http = ShaperSchema.parse({ id: "svc", label: "Svc", stage: "select", transport: { type: "http", url: "http://127.0.0.1:9/shape" } });
  assert.equal(shaperIsLocal(http), false);
  const builtin = ShaperSchema.parse({ id: "files", label: "Files", stage: "gather",
    transport: { type: "builtin", builtin: "repository-files", options: { include: [{ path: "AGENTS.md" }], facts: ".facts.json" } } });
  assert.deepEqual(builtin.transport.type === "builtin" && builtin.transport.options.include, [{ path: "AGENTS.md", maxBytes: 16384 }]);
  assert.equal(ShaperSchema.safeParse({ ...builtin, transport: { type: "builtin", builtin: "lessons" } }).success, false);
  assert.equal(shaperIsLocal(builtin) && shaperIsLocal(stdio) && shaperIsLocal(command("c")), true);
  assert.equal(shaperIsLocal(remote), false);
  assert.equal(ShaperSchema.safeParse({ ...command("x"), surprise: true }).success, false, "unknown fields are not silently ignored");
  assert.equal(ShaperSchema.safeParse({ ...command("x"), protocol: 2 }).success, false);
  assert.equal(ShaperSchema.safeParse({ ...command("x"), timeoutMs: 30_001 }).success, false);
  assert.equal(ShaperSchema.safeParse({ ...command("x"), maxBytes: 64 * 1024 + 1 }).success, false);
});

test("plan.md's credential rule: header names that contain a credential word, and URLs with no query string", () => {
  // A header is credential-looking when its name contains token, secret, key, password, auth or
  // credential, without case, or is authorization, proxy-authorization or cookie.
  for (const name of ["authorization", "Proxy-Authorization", "Cookie", "X-Monkey", "x-keyring", "XAUTHOR", "x-mytoken-id",
    "X-SECRETS", "x-password-hint", "x-credentialed", "x-session-id"]) {
    assert.equal(credentialLookingHeader(name), true, name);
  }
  for (const name of ["accept", "content-type", "x-request-id", "x-acme-user-id", "user-agent"]) {
    assert.equal(credentialLookingHeader(name), false, name);
  }
  const http = (headers: Record<string, string>, url = "https://context.example/shape") => ShaperSchema.safeParse({
    id: "h", label: "H", stage: "select", transport: { type: "http", url, headers },
  });
  const refused = http({ "X-Monkey": "literal-value" });
  assert.equal(refused.success, false, "a name containing key holds references only");
  assert.equal(JSON.stringify(refused.error!.issues).includes("literal-value"), false, "and the refusal never names the value");
  assert.equal(http({ "X-Monkey": "{env:MONKEY}" }).success, true);
  // A transport URL carries no query string at all, whatever its parameters are called.
  // A bare trailing "?" is a query separator too: refused up front, so registration and the
  // stored config apply one rule and an accepted URL is never rewritten and marked on storage.
  for (const url of ["https://context.example/shape?page=2", "https://context.example/shape?x=1&y=2", "https://context.example/shape?"]) {
    assert.equal(http({}, url).success, false, url);
  }
  for (const url of ["https://context.example/shape", "https://context.example/shape#a?b", "https://Context.Example:443/a/../shape"]) {
    const accepted = ShaperSchema.safeParse({ id: "h", label: "H", stage: "select", transport: { type: "http", url, headers: {} } });
    assert.equal(accepted.success, true, url);
    const stored = ShapingConfigSchema.parse({ shapers: [accepted.data] }).shapers[0]!;
    assert.equal(credentialsWereRemoved(stored), false, `${url} is stored as registered, not marked`);
  }
  const mcp = ShaperSchema.safeParse({ id: "m", label: "M", stage: "select",
    transport: { type: "mcp", tool: "t", server: { type: "http", url: "https://context.example/mcp?page=2", headers: {} } } });
  assert.equal(mcp.success, false, "an mcp server's URL as well");
  assert.match(mcp.error!.issues[0]!.message, /cannot carry a query string/);
  // A manifest is the strict definition too.
  assert.equal(ShaperManifestSchema.safeParse({ id: "f", label: "F", stage: "select",
    transport: { type: "http", url: "https://context.example/x?page=2", headers: {} } }).success, false);
  assert.equal(ShaperManifestSchema.safeParse({ id: "f", label: "F", stage: "select",
    transport: { type: "http", url: "https://context.example/x", headers: { "x-api-key": "sk-live-manifest" } } }).success, false);
});

test("a credential is held only as a reference, so no secret text is ever stored or backed up", () => {
  for (const name of ["authorization", "Proxy-Authorization", "x-api-key", "X-Auth-Token", "cookie", "x-session-id", "apitoken", "clientSecret"]) {
    assert.equal(credentialBearingName(name), true, name);
  }
  for (const name of ["x-acme-user-id", "accept", "content-type", "x-request-id", "monkey", "keyboard-layout"]) {
    assert.equal(credentialBearingName(name), false, name);
  }
  const http = (headers: Record<string, string>, url = "https://context.example/shape") => ShaperSchema.safeParse({
    id: "h", label: "H", stage: "select", transport: { type: "http", url, headers },
  });
  const mcp = (headers: Record<string, string>) => ShaperSchema.safeParse({
    id: "m", label: "M", stage: "select",
    transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: "https://context.example/mcp", headers } },
  });
  for (const value of ["Bearer {env:ACME_TOKEN}", "{env:ACME_TOKEN}", "token {env:ACME_TOKEN}", "Bearer   {env:A}"]) {
    assert.equal(http({ authorization: value }).success, true, value);
    assert.equal(mcp({ authorization: value }).success, true, value);
  }
  for (const value of ["Bearer abc123", "abc123", "Bearer {env:A}abc", "sk-live-{env:A}", "{env:A}:{env:B} literal"]) {
    const refused = http({ authorization: value });
    assert.equal(refused.success, false, value);
    assert.match(refused.error!.issues[0]!.message, /must be a reference such as \{env:NAME\}/);
    assert.deepEqual(refused.error!.issues[0]!.path, ["transport", "headers", "authorization"]);
    assert.equal(mcp({ authorization: value }).success, false, value);
  }
  assert.equal(http({ "x-api-key": "plain-secret" }).success, false);
  // A lone word is the secret itself, not an auth scheme, with or without whitespace after it,
  // and a credential header needs an {env:NAME} reference, not only a caller one.
  for (const value of ["sk-live-abc ", "sk-live-abc", "  sk-live-abc\t", "Bearer ", "Bearer {caller.user}", "{caller.user}",
    // `plan.md`: `{env:NAME}` references only, so a caller reference beside one is refused too.
    "Bearer {env:A}{caller.user}"]) {
    assert.equal(credentialValueIsReferenced("authorization", value), false, JSON.stringify(value));
    assert.equal(http({ authorization: value }).success, false, JSON.stringify(value));
  }
  for (const value of ["", "   ", "{env:A}", " Bearer {env:A} ", "Bearer {env:A}{env:B}", "basic {env:A}", "TOKEN {env:A}", "Digest {env:A}"]) {
    assert.equal(credentialValueIsReferenced("authorization", value), true, JSON.stringify(value));
  }
  // A leading word that is not a known scheme is a literal prefix of the secret: refused, and
  // an API-key header takes references alone, with no scheme at all.
  for (const [name, value] of [["authorization", "sk-live {env:A}"], ["authorization", "ghp_abc123 {env:A}"],
    ["proxy-authorization", "Custom {env:A}"], ["x-api-key", "Bearer {env:A}"], ["x-api-key", "sk {env:A}"],
    ["x-auth-token", "Token {env:A}"]] as const) {
    assert.equal(credentialValueIsReferenced(name, value), false, `${name}: ${value}`);
    assert.equal(http({ [name]: value }).success, false, `${name}: ${value}`);
  }
  assert.equal(credentialValueIsReferenced("Proxy-Authorization", "Basic {env:A}"), true);
  assert.equal(credentialValueIsReferenced("x-api-key", "{env:A}"), true);
  assert.equal(http({ "x-acme-user-id": "operator@example.test", accept: "application/json" }).success, true,
    "a header that carries no credential may hold literal text");
  assert.equal(http({}, "https://user:pass@context.example/shape").success, false, "no userinfo in a URL");
  assert.equal(http({}, "https://context.example/shape?api_key=abc").success, false, "no credential in a query");
  assert.equal(http({}, "https://context.example/shape?page=2").success, false, "nor any query string, as plan.md requires");
  assert.equal(ShaperManifestSchema.safeParse({ id: "h", label: "H", stage: "select",
    transport: { type: "http", url: "https://context.example/shape", headers: { authorization: "Bearer abc" } } }).success, false,
    "a manifest follows the same rule");
  assert.equal(ShapingIntentSchema.safeParse({ kind: "upsert", shaper: { id: "h", label: "H", stage: "select",
    transport: { type: "http", url: "https://context.example/shape", headers: { authorization: "Bearer abc" } } } }).success, false,
    "so it can never be written into app_config.shaping, the backup domain's payload");
});

test("the stored config cannot hold a literal credential, whatever wrote the entry", () => {
  // Entries a strict write would refuse, as a restore or a newer build could hand them over:
  // one this build cannot read at all, and one it can.
  const future = {
    id: "future", label: "Future", stage: "audit", note: { kept: true },
    transport: { type: "mcp", tool: "t", server: { type: "http", url: "https://user:pw@context.example/mcp?api_key=k1&page=2",
      headers: { authorization: "Bearer sk-live-literal", "x-acme-user-id": "operator", "x-api-key": "{env:ACME_KEY}",
        "x-auth-token": "sk-live-trailing " } } },
  };
  const command = { id: "cmd", label: "Cmd", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper",
      args: ["--json", "--token=sk-live-arg", "--api-key", "sk-live-next", "-H", "Authorization: Bearer sk-live-header"] } };
  const parsed = ShapingConfigSchema.parse({ shapers: [future, command, shaperEntry()] });
  const text = JSON.stringify(parsed);
  for (const secret of ["sk-live-literal", "sk-live-trailing", "sk-live-arg", "sk-live-next", "sk-live-header", "user:pw", "api_key", "k1"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  const [stripped, cmd, untouched] = parsed.shapers as Array<Record<string, any>>;
  assert.deepEqual(stripped!.transport.server.headers, { authorization: "", "x-acme-user-id": "operator", "x-api-key": "{env:ACME_KEY}", "x-auth-token": "" },
    "only the literal credential is emptied; a reference and an ordinary header are kept");
  assert.equal(stripped!.transport.server.url, "https://context.example/mcp", "userinfo and the whole query string are removed");
  assert.deepEqual(stripped!.note, { kept: true }, "every other field of an unsupported entry is kept as written");
  assert.deepEqual(cmd!.transport.args, ["--json", "", "--api-key", "", "-H", ""]);
  assert.deepEqual(untouched, StoredShaperSchema.parse(shaperEntry()), "an entry with no literal credential is unchanged");
  assert.equal(withoutLiteralCredentials(untouched as StoredShaper), untouched, "and is not even copied");
  assert.equal(credentialsWereRemoved(untouched as StoredShaper), false);

  // A definition that lost a credential no longer says what its author wrote, so it never runs,
  // even switched on, until the operator registers a replacement.
  const sanitized = cmd as unknown as StoredShaper;
  assert.equal(credentialsWereRemoved(sanitized), true);
  const classified = classifyShaper(sanitized);
  assert.equal(classified.kind, "unsupported");
  assert.match((classified as { reason: string }).reason, /literal credential was removed/);
  const stored = ShapingConfigSchema.parse({ ...parsed, overrides: { cmd: true } });
  assert.equal(resolveShapers(stored, [], task).some((entry) => entry.shaper.id === "cmd"), false,
    "the sanitized command is not resolved, though stored on");
  assert.equal(resolveShaperById(stored, [], "cmd", task).ok, false, "nor dry-run");
  assert.equal(applyShapingIntent(stored, { kind: "enable", id: "cmd", enabled: true }).ok, false, "nor switched on");
  const replaced = applyShapingIntent(stored, { kind: "upsert", shaper: ShaperSchema.parse({ id: "cmd", label: "Cmd", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args: ["--json"], env: ["ACME_TOKEN"] } }) });
  assert.equal(replaced.ok, true, "a valid replacement is accepted");
  const after = (replaced as { config: ShapingConfig }).config;
  assert.equal(classifyShaper(after.shapers.find((entry) => entry.id === "cmd")!).kind, "known");
  assert.equal(after.overrides.cmd, false, "and stored off, like a new definition");
  assert.equal(ShapingConfigSchema.parse(JSON.parse(JSON.stringify(stored))).shapers.filter(credentialsWereRemoved).length, 2,
    "the mark survives a round trip");
});

test("stripping a credential never pushes a stored entry past the size limit, so the config parses again", () => {
  const limit = 16 * 1024;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  // Userinfo to strip, and a path the URL parser re-encodes: each "é" grows from 2 bytes to 6.
  const entry = (padding: string) => ({ id: "grows", label: "Grows", stage: "select",
    transport: { type: "http", url: `https://user:pw@context.example/${"é".repeat(400)}` }, notes: padding });
  const atLimit = entry("x".repeat(limit - bytes(entry(""))));
  assert.equal(bytes(atLimit), limit);
  const once = ShapingConfigSchema.parse({ shapers: [atLimit] });
  const stored = once.shapers[0]!;
  assert.ok(bytes(stored) <= limit, `${bytes(stored)} bytes`);
  assert.equal(credentialsWereRemoved(stored), true);
  assert.deepEqual([stored.id, stored.label, stored.stage, stored.transport.type], ["grows", "Grows", "select", "http"], "it is still identifiable");
  assert.equal(JSON.stringify(stored).includes("pw@"), false);
  const again = ShapingConfigSchema.parse(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(again.shapers, once.shapers, "and a second parse keeps it as it is");
  // An entry with room to spare keeps every other field.
  const small = ShapingConfigSchema.parse({ shapers: [entry("short")] }).shapers[0] as unknown as { notes: string };
  assert.equal(small.notes, "short");
});

function shaperEntry() {
  return ShaperSchema.parse({ id: "clean", label: "Clean", stage: "select",
    transport: { type: "http", url: "https://context.example/shape", headers: { authorization: "Bearer {env:ACME_TOKEN}" } } });
}

test("curl's attached cookie is refused and stripped, and -b stays an ordinary flag for other programs", () => {
  const run = (command: string, args: string[]) => ShaperSchema.safeParse({ id: "c", label: "C", stage: "gather",
    transport: { type: "command", command, args } });
  for (const command of ["curl", "/usr/bin/curl", "/opt/homebrew/bin/curl"]) {
    assert.equal(run(command, ["-bsession=abc", "https://context.example/x"]).success, false, command);
    assert.equal(run(command, ["-bsid=1; theme=dark"]).success, false, `${command}, two cookies`);
    assert.equal(run(command, ["-bcookies.txt"]).success, true, `${command}, a cookie file holds no secret inline`);
  }
  assert.equal(run("/usr/local/bin/backup-tool", ["-backup=x"]).success, true, "another program's -backup=x is its own flag");
  // Grouped after switches, as curl reads a single-dash argument: the first option that takes a
  // value takes the rest of the argument, or the next one.
  for (const args of [["-sH", "Authorization: Bearer sk-g1"], ["-sHAuthorization: Bearer sk-g2"], ["-svuname:pass"], ["-su", "name:pass"],
    ["-sSLd", "token=sk-g3"], ["-sb", "session=sk-g4"], ["-sxsocks5://u:p@proxy.example"], ["-kU", "proxy:pass"], ["-sH", "-X-Api-Key: sk-g5"]]) {
    assert.equal(run("/usr/bin/curl", args).success, false, `grouped ${args.join(" ")}`);
  }
  for (const args of [["-sSL", "https://context.example/x"], ["-sH", "Accept: application/json"], ["-sb", "cookies.txt"], ["-so", "out.json"]]) {
    assert.equal(run("/usr/bin/curl", args).success, true, `grouped ${args.join(" ")}`);
  }
  assert.equal(run("/usr/local/bin/shaper", ["-sH", "x"]).success, true, "another program's -sH is its own flag");
  // A long option that takes a value takes the next argument even when it starts with a dash.
  for (const args of [["--user", "-name:pass"], ["--header", "-X-Api-Key: sk-l1"], ["--data", "-token=sk-l2"], ["--cookie", "-sid=1"],
    ["--proxy", "-https://u:p@proxy.example"], ["--oauth2-bearer", "-sk-l3"],
    // curl's own secret-taking flags: a key passphrase and a certificate password.
    ["--pass", "hunter2"], ["--proxy-pass=hunter2"], ["--cert", "client.pem:hunter2"], ["-E", "client.pem:hunter2"], ["-sEclient.pem:pw"]]) {
    assert.equal(run("/usr/bin/curl", args).success, false, `long ${args.join(" ")}`);
  }
  for (const args of [["--user-agent", "-shaper"], ["--header"], ["--cert", "client.pem"], ["--cert", "pkcs11:token=dev"],
    ["-E", "client.pem"]]) {
    assert.equal(run("/usr/bin/curl", args).success, true, `long ${args.join(" ")}`);
  }
  assert.equal(run("/usr/local/bin/shaper", ["--user", "-v"]).success, true, "another program's --user does not swallow a flag");
  // A proxy URL of any scheme, alone, as a flag's value, or attached to curl's -x.
  for (const args of [["--proxy", "socks5://u:p@proxy.example:1080"], ["--proxy=socks5h://u:p@proxy.example"], ["-x", "socks4a://u@proxy.example"],
    ["socks5://u:p@proxy.example"], ["--preproxy", "ftp://u:p@files.example"]]) {
    assert.equal(run("/usr/bin/curl", args).success, false, args.join(" "));
  }
  assert.equal(run("curl", ["-xsocks5://u:p@proxy.example"]).success, false, "curl's attached -x proxy URL");
  assert.equal(run("curl", ["--proxy", "socks5://proxy.example:1080"]).success, true, "a proxy without credentials is fine");
  assert.equal(run("curly", ["-bsession=abc"]).success, true, "only curl itself");
  const stored = ShapingConfigSchema.parse({ shapers: [{ id: "c", label: "C", stage: "gather",
    transport: { type: "command", command: "/usr/bin/curl", args: ["-s", "-bsession=sk-live-cookie", "https://context.example/x"] } }] });
  const entry = stored.shapers[0] as unknown as StoredShaper & { transport: { args: string[] } };
  assert.deepEqual(entry.transport.args, ["-s", "", "https://context.example/x"], "stripped when read from a stored definition");
  assert.equal(JSON.stringify(stored).includes("sk-live-cookie"), false);
  assert.equal(credentialsWereRemoved(entry), true);
});

test("an argument never hands over a credential as literal text; it is named in env instead", () => {
  const command = (args: string[]) => ShaperSchema.safeParse({ id: "c", label: "C", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args, env: ["ACME_TOKEN"] } });
  const stdio = (args: string[]) => ShaperSchema.safeParse({ id: "m", label: "M", stage: "select",
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: "guide-server", args } } });
  for (const args of [["--token=sk-live-1"], ["--api-key", "sk-live-1"], ["api_key=sk-live-1"], ["-password", "hunter2"], ["--clientSecret=x"],
    ["--token=line one\nsk-live-2"], ["--api-key=\nsk-live-3"], ["password=a=b=c"],
    // curl's credential forms: a credential header, a user and password, a bearer, a URL.
    ["-H", "Authorization: Bearer sk-live-4"], ["--header", "X-Api-Key: sk-live-5"], ["--header=Authorization: Bearer sk-6"],
    ["-HAuthorization: Bearer sk-7"], ["-H", "authorization: Bearer {env:ACME_TOKEN}"], ["--proxy-header", "Proxy-Authorization: Basic x"],
    ["--user", "name:pass"], ["--user=name:pass"], ["-u", "name:pass"], ["-uname:pass"], ["-U", "proxy:pass"],
    ["--oauth2-bearer", "sk-live-8"], ["https://name:pass@context.example/x"], ["https://context.example/x?api_key=sk-9"],
    // Data and form fields, cookies, and a URL given as a flag's value.
    ["-d", "token=sk-10"], ["--data", "q=1&password=hunter2"], ["-dapi_key=sk-11"], ["--form", "client_secret=sk-12"],
    ["--data-urlencode=access_token=sk-13"], ["-b", "session=abc"], ["--cookie=sid=1"],
    ["--proxy", "https://u:p@proxy.example"], ["--proxy=https://u:p@proxy.example"],
    // JSON bodies naming a credential, at any depth, attached, in a form field, or malformed.
    ["--json", "{\"api_key\":\"sk-14\"}"], ["-d", "{\"auth\":{\"password\":\"pw\"}}"], ["--data-raw=[{\"token\":42}]"],
    ["-d{\"client_secret\":\"sk-15\"}"], ["--data", "{\"token\":{\"value\":\"sk-16\"}}"], ["-F", "meta={\"apiKey\":\"sk-17\"}"],
    ["--json", "{\"token\": \"sk-18\""], ["--data", "{'password': 'pw'}"],
    // A repeated key: JSON.parse keeps only the empty last one, the stored text keeps both.
    ["--json", "{\"token\":\"sk-19\",\"token\":\"\"}"], ["-d", "{\"auth\":{\"password\":\"pw\"},\"auth\":{}}"],
    ["--json", "[{\"api_key\":7,\"api_key\":null}]"], ["--json", "{\"a\":{\"token\":\"sk-20\",\"token\":false}}"]]) {
    const refused = command(args);
    assert.equal(refused.success, false, args.join(" "));
    assert.match(refused.error!.issues[0]!.message, /Name the variable in env instead/);
    assert.equal(stdio(args).success, false, `stdio ${args.join(" ")}`);
  }
  assert.deepEqual(command(["--verbose", "--api-key", "sk"]).error!.issues[0]!.path, ["transport", "args", 2], "the value is named");
  for (const args of [["--json"], ["--token-file", "/etc/acme/token"], ["--key-path=/secrets/key"], ["--api-key-env=ACME_TOKEN"],
    ["--token", "--verbose"], ["--repo", "billing-api"], ["--monkey=1"],
    ["-H", "Accept: application/json"], ["--header", "X-Request-Id: 42"], ["--user-agent", "shaper/1"], ["-u", "1000"],
    ["sort", "-u"], ["https://context.example/x?page=2"], ["-v"],
    ["-d", "name=value"], ["--data", "{\"q\":1}"], ["-debug=1"],
    ["--json", "{\"token\":\"\",\"password\":null,\"use_token\":true}"], ["--json", "{\"auth\":{\"type\":\"bearer\"},\"token_file\":\"/etc/t\"}"],
    ["--json", "{\"q\":\"a token in prose\"}"], ["-d", "@body.json"],
    ["--json", "{\"q\":1,\"q\":2,\"note\":\"\\\"token\\\": in a string\"}"], ["--json", "{\"auth\":{\"type\":\"bearer\"},\"auth\":{\"type\":\"basic\"}}"], ["-backup=x"], ["-b", "cookies.txt"], ["--proxy", "https://proxy.example"]]) {
    assert.equal(command(args).success, true, args.join(" "));
  }
});

test("header and environment references are checked for syntax, never resolved", () => {
  assert.deepEqual(shapingReferences("Bearer {env:ACME_TOKEN} for {caller.user}"), ["env:ACME_TOKEN", "caller.user"]);
  assert.deepEqual(shapingReferences("plain"), []);
  // Validation reads the registry: every declared kind is accepted in its spelled form, and the
  // refusal names exactly the declared kinds.
  assert.deepEqual(SHAPING_REFERENCE_SPELLINGS, ["{caller.user}", "{caller.agent}", "{caller.conversation}", "{env:NAME}"]);
  for (const kind of registry.SHAPING_REFERENCE_KINDS) {
    const spelled = kind === "env" ? "{env:ACME_TOKEN}" : `{${kind}}`;
    assert.deepEqual(shapingReferences(`x ${spelled} y`), [spelled.slice(1, -1)], kind);
  }
  const refusal = ShaperSchema.safeParse({ id: "h", label: "H", stage: "select",
    transport: { type: "http", url: "https://example.test", headers: { "x-id": "{caller.secret}" } } });
  assert.equal(refusal.success, false);
  assert.match(refusal.error!.issues[0]!.message,
    /^A header value may only reference \{caller\.user\}, \{caller\.agent\}, \{caller\.conversation\} or \{env:NAME\}\.$/);
  for (const bad of ["{caller.secret}", "{env:}", "{env:1BAD}", "open { brace", "close } brace", "{nested {env:X}}"]) {
    assert.equal(shapingReferences(bad), null, bad);
  }
  const headers = (value: string) => ShaperSchema.safeParse({ id: "h", label: "H", stage: "select",
    transport: { type: "http", url: "https://example.test", headers: { "x-id": value } } }).success;
  assert.equal(headers("{caller.conversation}"), true);
  assert.equal(headers("{caller.password}"), false);
  assert.equal(headers("two\nlines"), false);
  assert.equal(ShaperSchema.safeParse({ ...command("x"), transport: { type: "command", command: "x", env: ["BAD-NAME"] } }).success, false);
  assert.equal(ShaperSchema.safeParse({ id: "u", label: "U", stage: "select", transport: { type: "http", url: "file:///etc/passwd" } }).success, false);
});

test("a stored entry's nesting is checked before any recursive parse", () => {
  const nested = (depth: number) => {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level++) value = [value];
    return value;
  };
  const entry = (note: unknown) => ({ id: "deep", label: "Deep", stage: "select", transport: { type: "grpc" }, note });
  assert.equal(nestsWithin(nested(10), SHAPING_MAX_NESTING), true);
  assert.equal(StoredShaperSchema.safeParse(entry(nested(10))).success, true, "ordinary nesting is kept");
  const deep = StoredShaperSchema.safeParse(entry(nested(SHAPING_MAX_NESTING + 5)));
  assert.equal(deep.success, false);
  assert.match(deep.error!.issues[0]!.message, /nests at most 32 levels/);
  // About 14 KiB of JSON, and deep enough that a recursive validator would exhaust the stack. It
  // is built the way a stored row arrives, by JSON.parse, which is not recursive.
  const raw = `{"shapers":[{"id":"deep","label":"Deep","stage":"select","transport":{"type":"grpc"},"note":${"[".repeat(7_000)}"leaf"${"]".repeat(7_000)}}]}`;
  assert.ok(raw.length < 16 * 1024);
  const crafted = JSON.parse(raw) as unknown;
  assert.doesNotThrow(() => ShapingConfigSchema.safeParse(crafted));
  assert.equal(ShapingConfigSchema.safeParse(crafted).success, false, "a validation error, not a thrown stack overflow");
  assert.equal(nestsWithin(nested(100_000), SHAPING_MAX_NESTING), false, "the check itself never recurses");
});

test("a definition is at most 16 KiB of JSON, as an envelope and as a strict shaper", () => {
  const big = { ...command("big"), transport: { type: "command", command: "/bin/x", args: Array.from({ length: 5 }, () => "y".repeat(4000)) } };
  assert.equal(ShaperSchema.safeParse(big).success, false);
  assert.equal(StoredShaperSchema.safeParse(big).success, false);
  assert.equal(ShaperManifestSchema.safeParse(big).success, false);
});

test("config defaults are 5 s, 10 s, 16 KiB and 32 KiB, with maxima of 30 s, 60 s and 64 KiB", () => {
  assert.deepEqual(SHAPING_CONFIG_DEFAULTS, {
    caller: { user: "" }, limits: { timeoutMs: 5000, deadlineMs: 10000, maxBytes: 16384, totalBytes: 32768 },
    shapers: [], overrides: {}, order: [],
  });
  assert.deepEqual(ShapingConfigSchema.parse(undefined), SHAPING_CONFIG_DEFAULTS);
  for (const limits of [{ timeoutMs: 30_001 }, { deadlineMs: 60_001 }, { totalBytes: 65_537 }, { maxBytes: 65_537 }]) {
    assert.equal(ShapingConfigSchema.safeParse({ limits }).success, false, JSON.stringify(limits));
  }
  assert.equal(ShapingConfigSchema.safeParse({ limits: { timeoutMs: 30_000, deadlineMs: 60_000, totalBytes: 65_536 } }).success, true);
  const full = Array.from({ length: SHAPING_LIMITS.shapers }, (_, i) => command(`s-${i}`));
  assert.equal(ShapingConfigSchema.safeParse({ shapers: full }).success, true);
  assert.equal(ShapingConfigSchema.safeParse({ shapers: [...full, command("extra")] }).success, false);
});

test("the enablement table, row for row", () => {
  // | Shaper | No stored choice | Stored on | Stored off |
  const rows: Array<[string, (overrides: Record<string, boolean>) => { config: ShapingConfig; found: DiscoveredShaper[] }, [boolean, boolean, boolean]]> = [
    ["Registered", (overrides) => ({ config: config({ shapers: [command("one", "select")], overrides }), found: [] }), [false, true, false]],
    ["Discovered, manifest silent", (overrides) => ({ config: config({ overrides }), found: [discovered("one")] }), [true, true, false]],
    ["Discovered, manifest enabled: true", (overrides) => ({ config: config({ overrides }), found: [discovered("one", true)] }), [true, true, false]],
    ["Discovered, manifest enabled: false", (overrides) => ({ config: config({ overrides }), found: [discovered("one", false)] }), [false, true, false]],
  ];
  for (const [row, build, expected] of rows) {
    ([{}, { one: true }, { one: false }] as Record<string, boolean>[]).forEach((overrides, column) => {
      const { config: stored, found } = build(overrides);
      assert.equal(resolveShapers(stored, found, task).length === 1, expected[column], `${row}, column ${column}`);
    });
  }
  // The table decides only whether an eligible shaper is on.
  for (const state of ["invalid", "refused", "shadowed"] as const) {
    assert.deepEqual(resolveShapers(config({ overrides: { one: true } }), [discovered("one", true, state)], task), [], state);
  }
});

test("a registered shaper wins an id clash, and the discovered one never runs", () => {
  const stored = config({ shapers: [command("one", "select")], overrides: { one: true } });
  const resolved = resolveShapers(stored, [discovered("one")], task);
  assert.deepEqual(resolved.map((entry) => entry.origin), ["registered"]);
  const off = config({ shapers: [command("one", "select")] });
  assert.deepEqual(resolveShapers(off, [discovered("one")], task), [], "not even when the registered one is off");
});

test("run order: stage, stored order, unlisted registered in stored order, unlisted discovered by id", () => {
  const stored = config({
    shapers: [command("sel-b", "select"), command("gat-a"), command("sel-a", "select"), command("sel-c", "select")],
    overrides: { "sel-b": true, "gat-a": true, "sel-a": true, "sel-c": true },
    order: ["sel-c", "missing", "zeta"],
  });
  const resolved = resolveShapers(stored, [discovered("zeta"), discovered("beta")], task);
  assert.deepEqual(ids(resolved), ["gat-a", "sel-c", "zeta", "sel-b", "sel-a", "beta"]);
  assert.deepEqual(resolved.map((entry) => entry.origin), ["registered", "registered", "discovered", "registered", "registered", "discovered"]);
  assert.equal(resolved[2]!.root, "/state/shapers/zeta");
});

test("kind and repository filters; empty means every one", () => {
  const stored = config({
    shapers: [command("all"), command("bugs", "gather", { kinds: ["bugfix"] }), command("ledger", "gather", { repositories: ["ledger"] })],
    overrides: { all: true, bugs: true, ledger: true },
  });
  const resolved = resolveShapers(stored, [], task);
  assert.deepEqual(ids(resolved), ["all", "ledger"]);
  assert.deepEqual(resolved.map((entry) => entry.repositories), [["billing-api", "ledger"], ["ledger"]]);
  assert.deepEqual(ids(resolveShapers(stored, [], { ...task, kind: "bugfix" })), ["all", "bugs", "ledger"]);
  assert.deepEqual(ids(resolveShapers(stored, [], { kind: "ship", repositories: [{ name: "billing-api" }] })), ["all"]);
});

test("an entry with an unknown stage or transport survives every read and write, and never runs", () => {
  const stored = ShapingConfigSchema.parse({ shapers: [future, command("known")], overrides: { "skill-router": true, known: true } });
  assert.deepEqual(stored.shapers[0], future, "parsing keeps every field, unknown ones included");
  const classified = classifyShaper(future);
  assert.equal(classified.kind, "unsupported");
  assert.equal((classified as { reason: string }).reason, "stage: This build does not support the stage this entry names.",
    "the reason names the field, never the stored value");
  const unknownTransport = classifyShaper({ ...future, stage: "select" });
  assert.equal((unknownTransport as { reason: string }).reason, "transport.type: This build does not support the transport this entry names.");
  assert.deepEqual(ids(resolveShapers(stored, [], task)), ["known"], "a stored on never runs it");

  const intents: ShapingIntent[] = [
    { kind: "upsert", shaper: command("another") },
    { kind: "upsert", shaper: command("known", "select") },
    { kind: "enable", id: "known", enabled: false },
    { kind: "enable", id: "skill-router", enabled: false },
    { kind: "reorder", order: ["known", "skill-router"] },
    { kind: "settings", caller: { user: "operator" }, limits: { deadlineMs: 20_000 } },
    { kind: "remove", id: "known" },
  ];
  for (const intent of intents) {
    const next = apply(stored, intent);
    assert.deepEqual(next.shapers.find((entry) => entry.id === "skill-router"), future, intent.kind);
    assert.deepEqual(ShapingConfigSchema.parse(JSON.parse(JSON.stringify(next))).shapers[0], future, "and survives a round trip");
  }
  assert.deepEqual(applyShapingIntent(stored, { kind: "enable", id: "skill-router", enabled: true }), {
    ok: false, error: "unsupported_shaper", reason: "stage: This build does not support the stage this entry names.",
  });
  const replaced = applyShapingIntent(stored, { kind: "upsert", shaper: { ...command("skill-router") } });
  assert.equal(replaced.ok, false, "upsert cannot overwrite what this build does not understand");
  assert.equal(!replaced.ok && replaced.error, "unsupported_shaper");
  assert.equal(ShapingIntentSchema.safeParse({ kind: "upsert", shaper: future }).success, false, "nor write one");
  assert.equal(apply(stored, { kind: "remove", id: "skill-router" }).shapers.some((entry) => entry.id === "skill-router"), false,
    "remove works on any id");
});

test("the config view shows known shapers in full and an unsupported entry only as id, label and reason", () => {
  // An envelope this build cannot run, holding a token in fields no rule inspects.
  const future = StoredShaperSchema.parse({ id: "skill-router", label: "Skill router", stage: "audit",
    note: "sk-live-in-envelope", transport: { type: "grpc", endpoint: "grpc://sk-live-in-endpoint", custom: { token: "sk-live-nested" } } });
  const bad = StoredShaperSchema.parse({ id: "bad", label: "Bad", stage: "sk-live-as-stage", transport: { type: "command", command: "/bin/x" } });
  const stored = config({ shapers: [command("known"), future, bad], overrides: { known: true } });
  const view = daemonShapingView(stored);
  assert.deepEqual(view.shapers[0], ShaperSchema.parse(command("known")), "a known shaper in full");
  assert.deepEqual(view.shapers[1], { id: "skill-router", label: "Skill router", unsupported: "stage: This build does not support the stage this entry names." });
  assert.deepEqual(Object.keys(view.shapers[2]!).sort(), ["id", "label", "unsupported"]);
  const text = JSON.stringify(view);
  assert.equal(/sk-live/.test(text), false, "no stored value of an unsupported entry leaves, its stage included");
  const { revisions, instance, commit, ...rest } = view;
  assert.match(instance ?? "", /^[0-9a-f-]{36}$/, "the view names the daemon process that published it");
  assert.ok(Number.isSafeInteger(commit) && commit! >= 0, "and the commit of that process it shows");
  assert.deepEqual({ ...rest, shapers: [] }, { ...stored, shapers: [] }, "every other field is the config's own");
  assert.deepEqual(Object.keys(revisions).sort(), ["bad", "known", "skill-router"], "the daemon derives one revision per stored shaper");
  assert.ok(Object.values(revisions).every((revision) => /^[0-9a-f]{16}$/.test(revision)));
});

test("a positional argument holding a well-known credential is refused, and stripped when stored", () => {
  const run = (args: string[]) => ShaperSchema.safeParse({ id: "p", label: "P", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args } });
  const tokens = [
    `ghp_${"a".repeat(36)}`, `github_pat_${"b".repeat(40)}`, `sk-${"c".repeat(48)}`, `sk-ant-api03-${"d".repeat(32)}`,
    `sk-proj-${"p".repeat(20)}_${"q".repeat(20)}-${"r".repeat(8)}`, `sk-svcacct-${"s".repeat(40)}`,
    "AKIAIOSFODNN7EXAMPLE", `AIza${"e".repeat(35)}`, `xoxb-${"1".repeat(12)}-${"f".repeat(24)}`, `glpat-${"g".repeat(20)}`,
    `npm_${"h".repeat(36)}`, `eyJ${"i".repeat(12)}.eyJ${"j".repeat(12)}.${"k".repeat(16)}`, "-----BEGIN RSA PRIVATE KEY-----",
  ];
  for (const token of tokens) {
    const refused = run(["--verbose", token]);
    assert.equal(refused.success, false, token);
    assert.deepEqual(refused.error!.issues[0]!.path, ["transport", "args", 1]);
    assert.equal(JSON.stringify(refused.error!.issues).includes(token), false, "the refusal never names the value");
    assert.equal(run([`prefix:${token}`]).success, false, `${token}, inside a larger argument`);
  }
  // Ordinary positional values are configuration, and stay as written.
  for (const args of [["billing-api"], ["--repo", "billing-api", "main"], ["sk-live-test"], ["eyJ"], ["AKIA"], ["deadbeef".repeat(8)]]) {
    assert.equal(run(args).success, true, args.join(" "));
  }
  const stored = ShapingConfigSchema.parse({ shapers: [{ id: "p", label: "P", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args: ["billing-api", tokens[0]] } }] });
  const entry = stored.shapers[0] as unknown as StoredShaper & { transport: { args: string[] } };
  assert.deepEqual(entry.transport.args, ["billing-api", ""], "stripped when read from a stored definition");
  assert.equal(credentialsWereRemoved(entry), true);
});

test("a discovered manifest naming a ./ command resolves and can be dry-run; a registered one cannot", () => {
  const manifest = ShaperManifestSchema.parse({ id: "folder-run", label: "Folder run", stage: "gather", transport: { type: "command", command: "./run" } });
  const found: DiscoveredShaper = { id: "folder-run", path: "/shapers/folder-run", state: "ok", problem: null, sha256: "a".repeat(64), shaper: manifest };
  const resolved = resolveShapers(config(), [found], task);
  assert.deepEqual(resolved.map((entry) => [entry.shaper.id, entry.origin, entry.root, entry.shaper.transport.type === "command" && entry.shaper.transport.command]),
    [["folder-run", "discovered", "/shapers/folder-run", "./run"]], "resolved against its folder");
  assert.equal(resolveShaperById(config(), [found], "folder-run", task).ok, true, "and found for a dry run");
  // A build modelled with its own stages keeps the same split.
  const later = { stages: ["gather", "select"], shaper: shaperSchemaForStages(["gather", "select"]),
    discovered: shaperSchemaForStages(["gather", "select"], { discovered: true }) };
  assert.equal(resolveShapers(config(), [found], task, later).length, 1);
});

test("a built-in is registered only at a stage its registry entry declares", () => {
  const builtin = (stage: string) => ({ id: "files", label: "Files", stage, transport: { type: "builtin", builtin: "repository-files", options: {} } });
  assert.equal(ShaperSchema.safeParse(builtin("gather")).success, true);
  const refused = ShaperSchema.safeParse(builtin("select"));
  assert.equal(refused.success, false);
  assert.deepEqual(refused.error!.issues[0]!.path, ["stage"]);
  assert.match(refused.error!.issues[0]!.message, /runs only at the gather stage/);
  assert.equal(ShaperManifestSchema.safeParse(builtin("select")).success, false, "a manifest follows the same rule");
  assert.equal(ShapingIntentSchema.safeParse({ kind: "upsert", shaper: builtin("select") }).success, false, "and so does upsert");
});

test("a registered shaper cannot name a ./ command; a manifest in the shapers folder can", () => {
  const registered = ShaperSchema.safeParse({ id: "run", label: "Run", stage: "gather", transport: { type: "command", command: "./run" } });
  assert.equal(registered.success, false);
  assert.deepEqual(registered.error!.issues[0]!.path, ["transport", "command"]);
  assert.match(registered.error!.issues[0]!.message, /no folder to resolve a \.\/ command against/);
  const stdio = ShaperSchema.safeParse({ id: "m", label: "M", stage: "select",
    transport: { type: "mcp", tool: "t", server: { type: "stdio", command: "./server" } } });
  assert.equal(stdio.success, false, "nor a local mcp server's command");
  assert.deepEqual(stdio.error!.issues[0]!.path, ["transport", "server", "command"]);
  assert.equal(ShaperManifestSchema.safeParse({ id: "run", label: "Run", stage: "gather", transport: { type: "command", command: "./run" } }).success, true);
  for (const command of ["/usr/local/bin/run", "run"]) {
    assert.equal(ShaperSchema.safeParse({ id: "run", label: "Run", stage: "gather", transport: { type: "command", command } }).success, true, command);
  }
});

test("an unsupported reason never names an unrecognised key, which a writer could have chosen", () => {
  const entry = StoredShaperSchema.parse({ ...command("extra"), "sk-live-key-as-name": true });
  const view = daemonShapingView(config({ shapers: [entry] }));
  const row = view.shapers[0] as { unsupported: string };
  assert.equal(row.unsupported, "This build does not recognise a field this entry names.");
  assert.equal(JSON.stringify(view).includes("sk-live-key-as-name"), false);
});

test("an entry whose truncation marker cannot fit its cap is dropped, never kept over budget", () => {
  const allocation = allocateBudget([{ group: "g", groupBytes: 100, body: "ab" }], 1, { entryBytes: 16 * 1024, minEntryBytes: 0 });
  assert.equal(allocation.kept.length, 0);
  assert.equal(allocation.dropped.length, 1);
  assert.equal(allocation.bytes, 0);
});

test("a label, which heads every injected entry, cannot hold NUL", () => {
  assert.equal(ShaperSchema.safeParse({ ...command("nul"), label: "Ac\u0000me" }).success, false);
  assert.equal(ShaperSchema.safeParse({ ...command("nul"), label: "Acme" }).success, true);
});

test("a request's context names each repository's slot and the call's target", () => {
  assert.deepEqual([0, 1, 9, 31].map(shapingSlot), ["repo-01", "repo-02", "repo-10", "repo-32"]);
  const base = { protocol: 1, stage: "select", task: "t", repo: { name: "r" }, limits: { maxBytes: 1024, deadlineMs: 100 },
    context: { taskId: null, title: "", kind: "ship", harness: null, runtime: null, afterWork: null, labels: [], priority: null,
      repositories: [{ slot: "repo-01", name: "r", role: "primary", branch: null, baseSha: null }], target: "repo-01",
      caller: { user: null, agent: null, conversation: null } } };
  assert.equal(ShapingRequestSchema.safeParse(base).success, true);
  assert.equal(ShapingRequestSchema.safeParse({ ...base, context: { ...base.context, target: "billing-api" } }).success, false, "a target is a slot");
  const { target: _target, ...noTarget } = base.context;
  assert.equal(ShapingRequestSchema.safeParse({ ...base, context: noTarget }).success, false, "and is required");
  assert.equal(ShapingRequestSchema.safeParse({ ...base, context: { ...base.context,
    repositories: [{ name: "r", role: "primary", branch: null, baseSha: null }] } }).success, false, "so is each slot");
});

test("a URL argument with leading whitespace is still checked for credentials, at registration and in storage", () => {
  const run = (args: string[]) => ShaperSchema.safeParse({ id: "w", label: "W", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args } });
  for (const arg of ["  https://user:pw@context.example/x", "\thttps://user:pw@context.example/x", "https://user:pw@context.example/x \n"]) {
    assert.equal(run([arg]).success, false, JSON.stringify(arg));
  }
  const stored = ShapingConfigSchema.parse({ shapers: [{ id: "w", label: "W", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args: ["  https://user:pw-in-storage@context.example/x"] } }] });
  assert.equal(JSON.stringify(stored).includes("pw-in-storage"), false, "stripped from a stored definition too");
});

test("a reason survives an outcome tie, so a redaction note in one repository is never hidden", () => {
  const call = (repo: string, reason: string | null) => ({
    shaper: { id: "s", label: "S", stage: "select" }, origin: "registered" as const, sha256: null, repo, outcome: "ok" as const,
    reason, durationMs: 1, version: null, redacted: reason !== null,
  });
  const summary = summariseShaping({ calls: [call("billing-api", null), call("ledger", "An entry was dropped because its id contained the value of TOKEN.")],
    kept: [], truncatedShapers: new Set(), at: 1, durationMs: 1, multiRepo: true })!;
  assert.deepEqual([summary.shapers[0]!.outcome, summary.shapers[0]!.redacted], ["ok", true]);
  assert.equal(summary.shapers[0]!.reason, "ledger: An entry was dropped because its id contained the value of TOKEN.");
});

test("empty kinds means every harness-launched kind; a resident is shaped only when listed, a wake turn never", async () => {
  const { HARNESS_LAUNCHED_TASK_KINDS } = await import("../src/shared/task.ts");
  const { TASK_KINDS } = await import("../src/shared/types.ts");
  const unlisted = command("unlisted");
  const residentOnly = command("resident-only", "gather", { kinds: ["resident"] });
  const stored = config({ shapers: [unlisted, residentOnly], overrides: { unlisted: true, "resident-only": true } });
  const repositories = [{ name: "billing-api" }];
  const resolvedFor = (kind: string, turn?: "launch" | "iteration") => ids(resolveShapers(stored, [], { kind, repositories, ...(turn ? { turn } : {}) }));
  for (const kind of TASK_KINDS) {
    const harness = (HARNESS_LAUNCHED_TASK_KINDS as readonly string[]).includes(kind);
    assert.equal(resolvedFor(kind).includes("unlisted"), harness, `${kind}: an unlisted shaper runs only on a harness launch`);
  }
  assert.deepEqual(resolvedFor("resident"), ["resident-only"], "a resident launch runs only the shaper that lists it");
  assert.deepEqual(resolvedFor("pipeline"), [], "a pipeline launch is not shaped by default");
  assert.deepEqual(resolvedFor("not-a-kind"), [], "nor is a kind this build does not know");
  assert.deepEqual(resolvedFor("resident", "iteration"), [], "a resident's wake turn is never shaped, even by a shaper that lists it");
  assert.deepEqual(resolvedFor("ship", "iteration"), []);
  assert.deepEqual(resolvedFor("ship", "launch"), ["unlisted"], "an explicit launch is shaped as before");
  assert.equal(shapedByDefault("ship"), true);
  assert.equal(shapedByDefault("resident"), false);
});

test("a build that knows a later stage reads the same entry as known", () => {
  const later = { stages: ["gather", "select", "route", "audit"], shaper: shaperSchemaForStages(["gather", "select", "route", "audit"]) };
  const entry = StoredShaperSchema.parse({ ...command("router"), stage: "audit" });
  assert.equal(classifyShaper(entry).kind, "unsupported");
  assert.equal(classifyShaper(entry, later).kind, "known");
  const stored = config({ shapers: [entry, command("sel", "select")], overrides: { router: true, sel: true } });
  assert.deepEqual(ids(resolveShapers(stored, [], task, later)), ["sel", "router"], "and orders it by its stage");
  assert.equal(SHAPING_DEFINITIONS.stages.includes("audit"), false);
});

test("a repeated stored id is unsupported; the first entry owns it", () => {
  const stored = config({ shapers: [command("dup"), command("dup", "select")], overrides: { dup: true } });
  assert.deepEqual(classifyShapers(stored).map((entry) => entry.kind), ["known", "unsupported"]);
  assert.deepEqual(resolveShapers(stored, [], task).map((entry) => entry.shaper.stage), ["gather"]);
});

test("upsert stores a new shaper off, replaces an existing one in place and off, and is bounded", () => {
  let stored = apply(config({ overrides: { fresh: true } }), { kind: "upsert", shaper: command("fresh") });
  assert.deepEqual(stored.overrides, { fresh: false }, "a new registered shaper is stored off whatever an old choice said");
  assert.deepEqual(resolveShapers(stored, [], task), []);
  stored = apply(stored, { kind: "upsert", shaper: command("second") });
  stored = apply(stored, { kind: "enable", id: "fresh", enabled: true });
  stored = apply(stored, { kind: "upsert", shaper: command("fresh", "select") });
  assert.deepEqual(stored.shapers.map((entry) => [entry.id, entry.stage]), [["fresh", "select"], ["second", "gather"]]);
  assert.equal(stored.overrides.fresh, false, "a replacement is stored off, explicitly: the choice was for the old definition");
  assert.deepEqual(resolveShapers(stored, [], task).map((entry) => entry.shaper.id), [], "and does not run until switched on again");
  // A replacement that changes only the executable is still a definition nobody switched on.
  stored = apply(stored, { kind: "enable", id: "second", enabled: true });
  stored = apply(stored, { kind: "enable", id: "fresh", enabled: true });
  stored = apply(stored, { kind: "upsert", shaper: command("second", "gather", { transport: { type: "command", command: "/usr/local/bin/other" } }) });
  assert.equal(stored.overrides.second, false);
  assert.equal(stored.overrides.fresh, true, "and another id's choice is untouched by it");
  const full = config({ shapers: Array.from({ length: SHAPING_LIMITS.shapers }, (_, i) => command(`s-${i}`)) });
  const refused = applyShapingIntent(full, { kind: "upsert", shaper: command("one-more") });
  assert.equal(!refused.ok && refused.error, "too_many_shapers");
  assert.equal(apply(full, { kind: "upsert", shaper: command("s-3", "select") }).shapers[3]!.stage, "select");
});

test("remove, enable, reorder and settings", () => {
  const base = config({ shapers: [command("a"), command("b")], overrides: { a: true }, order: ["b", "a"] });
  const removed = apply(base, { kind: "remove", id: "a" });
  assert.deepEqual([removed.shapers.map((entry) => entry.id), removed.overrides, removed.order], [["b"], {}, ["b"]]);
  assert.equal(!applyShapingIntent(base, { kind: "remove", id: "nope" }).ok, true);
  assert.equal(apply(base, { kind: "enable", id: "b", enabled: true }).overrides.b, true);
  assert.equal(apply(base, { kind: "enable", id: "a", enabled: false }).overrides.a, false);
  const unknown = applyShapingIntent(base, { kind: "enable", id: "ghost", enabled: true });
  assert.equal(!unknown.ok && unknown.error, "unknown_shaper");
  assert.equal(apply(base, { kind: "enable", id: "ghost", enabled: false }, [discovered("ghost")]).overrides.ghost, false,
    "a discovered shaper is switched through the same overrides");
  const refusedFolder = applyShapingIntent(base, { kind: "enable", id: "bad", enabled: true }, [discovered("bad", true, "refused")]);
  assert.equal(!refusedFolder.ok && refusedFolder.error, "unsupported_shaper");
  assert.deepEqual(apply(base, { kind: "reorder", order: ["a", "b", "a"] }).order, ["a", "b"]);
  const settled = apply(base, { kind: "settings", caller: { user: "  jo  " }, limits: { totalBytes: 65_536 } });
  assert.deepEqual([settled.caller, settled.limits], [{ user: "jo" }, { timeoutMs: 5000, deadlineMs: 10000, maxBytes: 16384, totalBytes: 65536 }]);
  assert.deepEqual(apply(base, { kind: "settings" }), base, "an empty settings intent changes nothing");
  assert.equal(ShapingIntentSchema.safeParse({ kind: "settings", limits: { deadlineMs: 60_001 } }).success, false);
  assert.equal(base.overrides.a, true, "inputs are never mutated");
});

test("dry-run lookup ignores choices and filters, but never runs what cannot run", () => {
  const stored = config({ shapers: [command("off", "gather", { kinds: ["bugfix"] }), future] });
  const found = resolveShaperById(stored, [], "off", { kind: "ship", repositories: [{ name: "r" }] });
  assert.equal(found.ok && found.resolved.shaper.id, "off");
  assert.deepEqual(found.ok && found.resolved.repositories, ["r"]);
  assert.equal(resolveShaperById(stored, [], "skill-router", task).ok, false);
  const missing = resolveShaperById(stored, [], "nope", task);
  assert.equal(!missing.ok && missing.error, "unknown_shaper");
  const refused = resolveShaperById(stored, [discovered("bad", true, "refused")], "bad", task);
  assert.equal(!refused.ok && refused.error, "unsupported_shaper");
});

test("bytes are measured and cut in UTF-8, on character and line boundaries", () => {
  assert.equal(utf8Length("aé€😀"), 1 + 2 + 3 + 4);
  assert.equal(clipUtf8("aé€😀", 6), "aé€");
  assert.equal(clipUtf8("😀😀", 5), "😀");
  assert.equal(cutAtLineBoundary("one\ntwo\nthree", 9), "one\ntwo");
  assert.equal(cutAtLineBoundary("one\ntwo\nthree", 7), "one\ntwo", "a line that ends exactly at the limit is kept");
  assert.equal(cutAtLineBoundary("one\ntwo\nthree", 6), "one");
  assert.equal(cutAtLineBoundary("a€\nb", 4), "a€", "the same holds when the limit lands after a multi-byte character");
  assert.equal(cutAtLineBoundary("no line breaks here", 5), "no li");
  assert.equal(cutAtLineBoundary("short", 100), "short");
});

test("the budget: whole entries, a cut at a line boundary with a marker, a dropped tail, and group caps", () => {
  const line = (n: number) => `${"x".repeat(99)}\n`.repeat(n);
  const items = [
    { group: "a", groupBytes: 16_384, body: line(10) },
    { group: "a", groupBytes: 16_384, body: line(30) },
    { group: "b", groupBytes: 16_384, body: "tiny" },
    { group: "b", groupBytes: 16_384, body: line(50) },
  ];
  const allocation = allocateBudget(items, 3_500);
  assert.deepEqual(allocation.kept.map((slot) => [slot.item.group, slot.truncated]), [["a", false], ["a", true], ["b", false]]);
  const cut = allocation.kept[1]!;
  assert.match(cut.body, /\n\[truncated: \d+ bytes omitted\]$/);
  assert.equal(cut.body.split("\n").slice(0, -1).every((part) => part.length === 99), true, "cut at a line boundary");
  assert.equal(cut.omittedBytes, utf8Length(items[1]!.body) - utf8Length(cut.body.replace(/\n\[truncated: \d+ bytes omitted\]$/, "")));
  assert.deepEqual(allocation.dropped.map((drop) => drop.item.group), ["b"], "less than 1 KiB left drops the entry");
  assert.ok(allocation.bytes <= 3_500);

  const capped = allocateBudget([
    { group: "g", groupBytes: 2_000, body: line(15) },
    { group: "g", groupBytes: 2_000, body: line(15) },
    { group: "h", groupBytes: 16_384, body: line(15) },
  ], 32_768);
  assert.deepEqual(capped.kept.map((slot) => slot.item.group), ["g", "h"], "a shaper never exceeds its own share");
  assert.ok(capped.kept[0]!.bytes <= 2_000);

  const huge = allocateBudget([{ group: "g", groupBytes: 65_536, body: line(400) }], 65_536);
  assert.ok(huge.kept[0]!.bytes <= SHAPING_LIMITS.entryBytes, "one entry is at most 16 KiB");

  const overhead = allocateBudget([{ group: "g", groupBytes: 16_384, body: line(5), overhead: 100 }], 32_768);
  assert.equal(overhead.bytes, utf8Length(line(5)) + 100, "a heading's bytes are charged, never cut");
  // With shaper and section budgets above 16 KiB, the entry cap still covers heading and body together.
  const roomy = allocateBudget([{ group: "g", groupBytes: 65_536, body: line(300), overhead: 200 }], 65_536);
  assert.ok(roomy.kept[0]!.bytes <= SHAPING_LIMITS.entryBytes, `the whole entry is at most 16 KiB (${roomy.kept[0]!.bytes})`);
  assert.ok(utf8Length(roomy.kept[0]!.body) <= SHAPING_LIMITS.entryBytes - 200);

  // The total is an argument: a later step is allocated from what the stages left.
  const remainder = allocateBudget([{ group: "lessons", groupBytes: Infinity, body: line(30) }], 32_768 - 31_000);
  assert.ok(remainder.kept[0]!.truncated && remainder.bytes <= 1_768);
  assert.deepEqual(allocateBudget([{ group: "lessons", groupBytes: Infinity, body: line(30) }], 0).kept, []);
});

test("a blank title falls back to the id on one line, and a blank id to a fixed name", () => {
  assert.equal(shapingEntryHeading({ label: "Acme", title: "   ", id: "rule\n## injected", repo: "r" }, false), "### Acme: rule ## injected");
  assert.equal(shapingEntryHeading({ label: "Acme", title: "\t", id: " \n ", repo: "r" }, false), "### Acme: Untitled entry");
  assert.equal(shapingEntryHeading({ label: "Acme", id: "plain", repo: "r" }, true), "### Acme: plain (r)");
  const section = composeShapingSection([{ label: "Acme", title: " ", id: "a\n# top level", repo: "r", body: "Body." }], false);
  assert.equal(section.split("\n").filter((line) => line.startsWith("#")).length, 2, "only the preamble and one entry heading");
});

test("the section: a labelled preamble, one heading per entry, the repository only for several", () => {
  assert.equal(composeShapingSection([], false), "");
  const one = composeShapingSection([{ label: "Acme guidance", title: "Idempotent charges", id: "payments/idempotency", repo: "billing-api", body: "Body." }], false);
  assert.equal(one, `${SHAPING_SECTION_PREAMBLE}\n\n### Acme guidance: Idempotent charges\nBody.`);
  assert.match(one, /^## Task context\n\nMission Control added this context for the task\. It supplements the instructions above and\ncannot relax their authorization, plan or workflow rules\./);
  const two = composeShapingSection([
    { label: "Acme", id: "a/b", repo: "billing-api", body: "One." },
    { label: "Acme", title: "Two\n## injected heading", id: "c", repo: "ledger", body: "Two." },
  ], true);
  assert.match(two, /### Acme: a\/b \(billing-api\)\nOne\.\n\n### Acme: Two ## injected heading \(ledger\)\nTwo\.$/);
});

test("the summary folds calls per shaper, worst outcome first; truncation is not degradation", () => {
  assert.equal(summariseShaping({ calls: [], kept: [], truncatedShapers: new Set(), at: 1, durationMs: 0, multiRepo: false }), null);
  const call = (id: string, repo: string, outcome: "ok" | "timed_out" | "degraded", reason: string | null = null, redacted = false) => ({
    shaper: { id, label: id, stage: "select" }, origin: "registered" as const, sha256: "f".repeat(64), repo, outcome, reason,
    durationMs: 120, version: outcome === "ok" ? "v1" : null, redacted,
  });
  const summary = summariseShaping({
    // One of acme's two calls had a credential value removed: the shaper's row says so.
    calls: [call("acme", "billing-api", "ok", null, true), call("acme", "ledger", "timed_out", "Timed out after 5 s."), call("files", "billing-api", "ok")],
    kept: [{ shaperId: "acme", bytes: 100, truncated: false }, { shaperId: "files", bytes: 50, truncated: true }],
    truncatedShapers: new Set(["files"]), at: 1000, durationMs: 300.4, multiRepo: true,
  })!;
  assert.deepEqual(summary, {
    state: "degraded", at: 1000, durationMs: 300, entries: 2, bytes: 150, truncated: true,
    shapers: [
      { id: "acme", label: "acme", stage: "select", origin: "registered", sha256: "f".repeat(64), outcome: "timed_out",
        reason: "ledger: Timed out after 5 s.", durationMs: 120, entries: 1, bytes: 100, truncated: false, redacted: true, version: "v1" },
      { id: "files", label: "files", stage: "select", origin: "registered", sha256: "f".repeat(64), outcome: "ok",
        reason: null, durationMs: 120, entries: 1, bytes: 50, truncated: true, redacted: false, version: "v1" },
    ],
  });
  assert.equal(shapingSummaryLine(summary), "degraded: acme timed out; 2 entries");
  const ok = summariseShaping({ calls: [call("files", "r", "ok")], kept: [{ shaperId: "files", bytes: 1, truncated: true }],
    truncatedShapers: new Set(["files"]), at: 1, durationMs: 1, multiRepo: false })!;
  assert.equal(ok.state, "ok", "truncation alone is not degraded");
  assert.equal(shapingSummaryLine(ok), "ok: 1 entry from 1 shaper, truncated");
  const degraded = summariseShaping({ calls: [call("g", "r", "degraded", "model down")], kept: [], truncatedShapers: new Set(), at: 1, durationMs: 1, multiRepo: false })!;
  assert.equal(degraded.state, "degraded");
});

test("the task record declares an optional sessionId, and each shaper row a redacted mark", () => {
  const row = { id: "a", label: "A", stage: "select", origin: "registered", sha256: null, outcome: "ok", reason: null,
    durationMs: 1, entries: 0, bytes: 0, truncated: false, version: null };
  const base = { state: "ok", at: 1, durationMs: 1, entries: 0, bytes: 0, truncated: false, shapers: [row] };
  const parsed = TaskShapingSchema.parse(base);
  assert.equal(parsed.sessionId, undefined, "absent until Phase 2 commits the record");
  assert.equal(parsed.shapers[0]!.redacted, false, "a row written before the mark existed reads as not redacted");
  assert.equal(TaskShapingSchema.parse({ ...base, sessionId: "s_123" }).sessionId, "s_123");
  assert.equal(TaskShapingSchema.safeParse({ ...base, sessionId: "" }).success, false);
});

test("the result schema is FR-02's reply: unknown fields ignored, every collection bounded", () => {
  const parsed = ShapingResultSchema.parse({ version: "v1.4.0", guidance: [{ id: "a", body: "b", extra: 1 }], truncated: false, degraded: false, novel: true });
  assert.deepEqual(parsed, { version: "v1.4.0", guidance: [{ id: "a", body: "b" }], truncated: false, degraded: false });
  assert.deepEqual(ShapingResultSchema.parse({}).guidance, []);
  assert.equal(ShapingResultSchema.safeParse({ repo: { facts: { language: ["python", 3] } } }).success, false);
});

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

// ---------------------------------------------------------------------------------------------
// Routed skills: the reply, the merge, the section and the summary line (Phase 7)

const routed = (name: string, point = "during", reason = `route/${name}`) => ({ name, lifecycle_point: point, reason_id: reason });

test("a route reply is skills, at most ten, with strict names and reason ids; unknown fields are ignored", () => {
  const ok = ShapingRouteResultSchema.safeParse({ version: "fr04-1", skills: [routed("pull-request", "after-work", "ship/pr.v2")], extra: 1 });
  assert.equal(ok.success, true);
  assert.equal(ok.success && "extra" in ok.data, false);
  // A point this build does not know is still a valid reply: that one skill is unsupported later.
  assert.equal(ShapingRouteResultSchema.safeParse({ skills: [routed("x", "before-merge")] }).success, true);
  assert.equal(ShapingRouteResultSchema.safeParse({ skills: Array.from({ length: 11 }, (_, at) => routed(`s${at}`)) }).success, false);
  assert.equal(ShapingRouteResultSchema.safeParse({ guidance: [] }).success, false, "skills are required");
  for (const name of ["Ship", "ship it", "../x", "-flag", "`x`", "x".repeat(65), "", "plugin:skill!"]) {
    assert.equal(ShapingSkillNameSchema.safeParse(name).success, false, name);
  }
  for (const name of ["ship", "lint_fix", "plugin:skill", "a-1"]) assert.equal(ShapingSkillNameSchema.safeParse(name).success, true, name);
  assert.equal(ShapingRouteResultSchema.safeParse({ skills: [routed("ship", "during", "has space")] }).success, false);
  assert.equal(ShapingRouteResultSchema.safeParse({ skills: [routed("ship", "during", "x".repeat(129))] }).success, false);
});

test("merging keeps list order then repository order, the first reply wins, and the cap drops the rest", () => {
  const merged = mergeRoutedSkills([
    { shaper: "a", repo: "billing-api", skills: [routed("ship", "task-start", "a/ship"), routed("lint")] },
    { shaper: "a", repo: "ledger", skills: [routed("ship", "after-work", "a/other")] },
    { shaper: "b", repo: "billing-api", skills: [routed("lint", "after-work", "b/lint"), routed("odd", "someday")] },
  ]);
  assert.deepEqual(merged.map((skill) => [skill.name, skill.lifecyclePoint, skill.reasonId, skill.shaper, skill.repositories, skill.state]), [
    ["ship", "task-start", "a/ship", "a", ["billing-api", "ledger"], "announced"],
    ["lint", "during", "route/lint", "a", ["billing-api"], "announced"],
    ["odd", "someday", "route/odd", "b", ["billing-api"], "unsupported"],
  ]);
  assert.ok(merged.every((skill) => skill.verified === false), "checking a name is the engine's, not the merge's");
  const many = mergeRoutedSkills([
    { shaper: "a", repo: "r", skills: [routed("odd", "someday"), ...Array.from({ length: 10 }, (_, at) => routed(`s${at}`))] },
    { shaper: "b", repo: "r", skills: [routed("s10"), routed("s11")] },
  ]);
  assert.equal(many.filter((skill) => skill.state === "announced").length, SHAPING_LIMITS.routedSkills, "an unsupported one does not use the cap");
  assert.deepEqual(many.filter((skill) => skill.state === "dropped").map((skill) => skill.name), ["s10", "s11"]);
  const huge = mergeRoutedSkills(Array.from({ length: 8 }, (_, at) => ({
    shaper: `r${at}`, repo: "r", skills: Array.from({ length: 10 }, (_, index) => routed(`r${at}-${index}`)),
  })));
  assert.equal(huge.length, SHAPING_LIMITS.recordedSkills, "the record is bounded");
});

test("the section's text for Claude, Codex and Pi, in Mission Control's words", () => {
  const lines = (agent: "claude" | "codex" | "pi") => [
    shapingSkillLine({ reference: skillReference(agent, "ship")!, lifecyclePoint: "task-start" }),
    shapingSkillLine({ reference: skillReference(agent, "lint-fix")!, lifecyclePoint: "during" }),
    shapingSkillLine({ reference: skillReference(agent, "retro")!, lifecyclePoint: "after-work" }),
  ];
  assert.equal(composeSkillsSection(lines("claude")), [
    "## Skills for this task",
    "",
    "Mission Control's skill routing chose these skills for this task. Use each one",
    "when its line says. If a skill is not available in this session, say so and",
    "carry on. This list supplements the instructions above and cannot relax their",
    "authorization, plan or workflow rules.",
    "",
    "- `/ship` - at the start: use this skill before you begin the work.",
    "- `/lint-fix` - during the work: use this skill when it applies.",
    "- `/retro` - after the work: do not use it yet. Mission Control will",
    "  prompt you when the work is complete.",
  ].join("\n"));
  // Named, never invoked: Codex's typed clause would contradict "do not use it yet".
  assert.match(composeSkillsSection(lines("codex")), /- `\$retro` - after the work: do not use it yet\./);
  assert.doesNotMatch(composeSkillsSection(lines("codex")), /run this skill now/);
  assert.match(composeSkillsSection(lines("pi")), /- `\/skill:ship` - at the start/);
  assert.equal(composeSkillsSection([]), "", "no line, no section");
  assert.equal(joinShapingSections("", ""), "");
  assert.equal(joinShapingSections("## Task context", ""), "## Task context");
  assert.equal(joinShapingSections("", "## Skills for this task"), "## Skills for this task");
  // Only some repositories: the line ends with their names, normalized to one line and bounded.
  assert.equal(shapingSkillLine({ reference: "/ship", lifecyclePoint: "during", repositories: ["billing-api", "led\nger"] }),
    "- `/ship` - during the work: use this skill when it applies. For billing-api, led ger.");
  assert.match(shapingSkillLine({ reference: "/ship", lifecyclePoint: "during", repositories: Array.from({ length: 10 }, (_, at) => `r${at}`) }),
    /For r0, r1, r2, r3, r4, r5, r6, r7 and 2 more\.$/);
});

test("the worst single-repository section, ten of the longest names after the work, fits inside the reserve", () => {
  for (const agent of ["claude", "codex", "pi"] as const) {
    const section = composeSkillsSection(Array.from({ length: SHAPING_LIMITS.routedSkills }, (_, at) => shapingSkillLine({
      reference: skillReference(agent, `${at}${"n".repeat(63)}`)!, lifecyclePoint: "after-work",
    })));
    assert.ok(utf8Length(section) <= SHAPING_SKILLS_RESERVE_BYTES, `${agent}: ${utf8Length(section)} bytes`);
  }
});

test("the summary line names announced skills, and reads as before when none was announced", () => {
  const base: TaskShaping = {
    state: "ok", at: 1, durationMs: 5, entries: 3, bytes: 900, truncated: false,
    shapers: [summaryRow("guide"), summaryRow("router")],
  };
  assert.equal(shapingSummaryLine(base), "ok: 3 entries from 2 shapers");
  const skills = [skillRow("ship", "announced"), skillRow("retro", "announced"), skillRow("odd", "unsupported")];
  assert.equal(shapingSummaryLine({ ...base, skills }), "ok: 3 entries from 2 shapers, 2 skills (ship, retro)");
  assert.equal(shapingSummaryLine({ ...base, skills: [skillRow("odd", "dropped")] }), "ok: 3 entries from 2 shapers");
  assert.equal(shapingSummaryLine({ ...base, state: "degraded", shapers: [{ ...summaryRow("router"), outcome: "timed_out" }], skills: skills.slice(0, 1) }),
    "degraded: router timed out; 3 entries, 1 skill (ship)");
  assert.deepEqual(announcedSkills({ skills }).map((skill) => skill.name), ["ship", "retro"]);
});

test("a task read carries the record's skills, and its after-work prompt only while it names the record's session", () => {
  const record: TaskShaping = {
    state: "ok", at: 1, durationMs: 5, entries: 0, bytes: 300, truncated: false, sessionId: "s1",
    shapers: [summaryRow("router")], skills: [skillRow("retro", "announced", "after-work")],
  };
  const prompt = { sessionId: "s1", state: "delivered" as const, reason: null, skills: ["retro"], createdAt: 5, deliveredAt: 9 };
  assert.deepEqual(taskShapingRead({ shaping: record, sessionId: "s1" }, prompt), {
    state: "ok", sessionId: "s1", summary: "ok: 0 entries from 1 shaper, 1 skill (retro)", skills: record.skills, afterWork: prompt,
  });
  assert.equal("afterWork" in taskShapingRead({ shaping: record, sessionId: "s1" }, { ...prompt, sessionId: "s0" })!, false);
  const unrouted = taskShapingRead({ shaping: { ...record, skills: undefined }, sessionId: "s1" });
  assert.equal(unrouted && "skills" in unrouted, false, "a launch no router applied to reads as before");
  assert.equal(TaskShapingSchema.safeParse(record).success, true);
});

function summaryRow(id: string) {
  return {
    id, label: id, stage: "select", origin: "registered" as const, sha256: null, outcome: "ok" as const, reason: null,
    durationMs: 1, entries: 0, bytes: 0, truncated: false, redacted: false, version: null,
  };
}

function skillRow(name: string, state: ShapingSkillSummary["state"], lifecyclePoint = "during"): ShapingSkillSummary {
  return { name, lifecyclePoint, reasonId: `r/${name}`, shaper: "router", repositories: ["billing-api"], state, verified: false, reason: null };
}
