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
  credentialValueIsReferenced,
  credentialsWereRemoved,
  ShaperIdSchema,
  shaperIsLocal,
  ShaperManifestSchema,
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
} from "../src/shared/shaping.ts";

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
  id: "skill-router", label: "Skill router", stage: "route",
  transport: { type: "grpc", endpoint: "dns:///router", deadline: { ms: 4000 } },
  protocol: 1, kinds: [], futureField: { nested: [1, "two", null] },
});

test("registry data is append-only tuples, unique, and disjoint from its tombstones", () => {
  assert.deepEqual(Object.keys(registry).sort(), [
    "RETIRED_SHAPING_BUILTINS", "RETIRED_SHAPING_STAGES", "RETIRED_SHAPING_TRANSPORTS",
    "SHAPING_BUILTINS", "SHAPING_ORIGINS", "SHAPING_OUTCOMES", "SHAPING_REFERENCE_KINDS",
    "SHAPING_STAGES", "SHAPING_TRANSPORTS",
  ]);
  assert.deepEqual(registry.SHAPING_STAGES, ["gather", "select"]);
  assert.deepEqual(registry.SHAPING_TRANSPORTS, ["command", "mcp", "http", "builtin"]);
  assert.deepEqual(registry.SHAPING_BUILTINS, [{ id: "repository-files", stages: ["gather"] }]);
  assert.deepEqual(registry.SHAPING_OUTCOMES, ["ok", "degraded", "failed", "timed_out", "invalid", "unavailable"]);
  assert.deepEqual(registry.SHAPING_ORIGINS, ["registered", "discovered"]);
  for (const [live, retired] of [
    [registry.SHAPING_STAGES, registry.RETIRED_SHAPING_STAGES],
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
  for (const value of ["sk-live-abc ", "sk-live-abc", "  sk-live-abc\t", "Bearer ", "Bearer {caller.user}", "{caller.user}"]) {
    assert.equal(credentialValueIsReferenced("authorization", value), false, JSON.stringify(value));
    assert.equal(http({ authorization: value }).success, false, JSON.stringify(value));
  }
  for (const value of ["", "   ", "{env:A}", " Bearer {env:A} ", "Bearer {env:A}{caller.user}", "basic {env:A}", "TOKEN {env:A}", "Digest {env:A}"]) {
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
  assert.equal(http({}, "https://context.example/shape?page=2").success, true);
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
    id: "future", label: "Future", stage: "route", note: { kept: true },
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
  assert.equal(stripped!.transport.server.url, "https://context.example/mcp?page=2");
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
  assert.equal(Object.hasOwn(after.overrides, "cmd"), false, "and stored off, like a new definition");
  assert.equal(ShapingConfigSchema.parse(JSON.parse(JSON.stringify(stored))).shapers.filter(credentialsWereRemoved).length, 2,
    "the mark survives a round trip");
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
    ["--proxy", "https://u:p@proxy.example"], ["--proxy=https://u:p@proxy.example"]]) {
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
    ["-d", "name=value"], ["--data", "{\"q\":1}"], ["-debug=1"], ["-backup=x"], ["-b", "cookies.txt"], ["--proxy", "https://proxy.example"]]) {
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
  assert.match((classified as { reason: string }).reason, /"route" stage/);
  const unknownTransport = classifyShaper({ ...future, stage: "select" });
  assert.match((unknownTransport as { reason: string }).reason, /"grpc" transport/);
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
    ok: false, error: "unsupported_shaper", reason: 'This build does not support the "route" stage.',
  });
  const replaced = applyShapingIntent(stored, { kind: "upsert", shaper: { ...command("skill-router") } });
  assert.equal(replaced.ok, false, "upsert cannot overwrite what this build does not understand");
  assert.equal(!replaced.ok && replaced.error, "unsupported_shaper");
  assert.equal(ShapingIntentSchema.safeParse({ kind: "upsert", shaper: future }).success, false, "nor write one");
  assert.equal(apply(stored, { kind: "remove", id: "skill-router" }).shapers.some((entry) => entry.id === "skill-router"), false,
    "remove works on any id");
});

test("a build that knows a later stage reads the same entry as known", () => {
  const later = { stages: ["gather", "select", "route"], shaper: shaperSchemaForStages(["gather", "select", "route"]) };
  const entry = StoredShaperSchema.parse({ ...command("router"), stage: "route" });
  assert.equal(classifyShaper(entry).kind, "unsupported");
  assert.equal(classifyShaper(entry, later).kind, "known");
  const stored = config({ shapers: [entry, command("sel", "select")], overrides: { router: true, sel: true } });
  assert.deepEqual(ids(resolveShapers(stored, [], task, later)), ["sel", "router"], "and orders it by its stage");
  assert.equal(SHAPING_DEFINITIONS.stages.includes("route"), false);
});

test("a repeated stored id is unsupported; the first entry owns it", () => {
  const stored = config({ shapers: [command("dup"), command("dup", "select")], overrides: { dup: true } });
  assert.deepEqual(classifyShapers(stored).map((entry) => entry.kind), ["known", "unsupported"]);
  assert.deepEqual(resolveShapers(stored, [], task).map((entry) => entry.shaper.stage), ["gather"]);
});

test("upsert stores a new shaper off, replaces an existing one in place, and is bounded", () => {
  let stored = apply(config({ overrides: { fresh: true } }), { kind: "upsert", shaper: command("fresh") });
  assert.deepEqual(stored.overrides, {}, "a new registered shaper is off whatever an old choice said");
  assert.deepEqual(resolveShapers(stored, [], task), []);
  stored = apply(stored, { kind: "upsert", shaper: command("second") });
  stored = apply(stored, { kind: "enable", id: "fresh", enabled: true });
  stored = apply(stored, { kind: "upsert", shaper: command("fresh", "select") });
  assert.deepEqual(stored.shapers.map((entry) => [entry.id, entry.stage]), [["fresh", "select"], ["second", "gather"]]);
  assert.equal(stored.overrides.fresh, true, "an edit keeps the operator's choice");
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
  const call = (id: string, repo: string, outcome: "ok" | "timed_out" | "degraded", reason: string | null = null) => ({
    shaper: { id, label: id, stage: "select" }, origin: "registered" as const, sha256: "f".repeat(64), repo, outcome, reason,
    durationMs: 120, version: outcome === "ok" ? "v1" : null,
  });
  const summary = summariseShaping({
    calls: [call("acme", "billing-api", "ok"), call("acme", "ledger", "timed_out", "Timed out after 5 s."), call("files", "billing-api", "ok")],
    kept: [{ shaperId: "acme", bytes: 100, truncated: false }, { shaperId: "files", bytes: 50, truncated: true }],
    truncatedShapers: new Set(["files"]), at: 1000, durationMs: 300.4, multiRepo: true,
  })!;
  assert.deepEqual(summary, {
    state: "degraded", at: 1000, durationMs: 300, entries: 2, bytes: 150, truncated: true,
    shapers: [
      { id: "acme", label: "acme", stage: "select", origin: "registered", sha256: "f".repeat(64), outcome: "timed_out",
        reason: "ledger: Timed out after 5 s.", durationMs: 120, entries: 1, bytes: 100, truncated: false, version: "v1" },
      { id: "files", label: "files", stage: "select", origin: "registered", sha256: "f".repeat(64), outcome: "ok",
        reason: null, durationMs: 120, entries: 1, bytes: 50, truncated: true, version: "v1" },
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
