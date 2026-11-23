// References resolve at call time and never leave as values: resolution, the set or unset
// status, and `scrubResolved` over a reply.
import assert from "node:assert/strict";
import test from "node:test";
import { SHAPING_CONFIG_DEFAULTS, ShaperSchema, ShapingResultSchema } from "../src/shared/shaping.ts";
import {
  holdsResolvedValue, JSON_ESCAPE_LEVELS, missingReferenceReason, variantSpans, redactResolved, referenceStatus, resolveReferenceMap, resolveReferences, scrubReason, scrubResolved,
} from "../src/server/shaping/references.ts";

const caller = { user: "declared-user", agent: "claude", conversation: "t_123" };
const env = { ACME_TOKEN: "tok-9f8e7d", ACME_TENANT: "tenant-42", EMPTY: "", MISSION_API_TOKEN: "daemon-token-value" };
const ctx = { caller, env, daemonToken: "daemon-token-value" };

test("each reference kind resolves, and every resolved value is reported for scrubbing", () => {
  assert.deepEqual(resolveReferences("{caller.user}|{caller.agent}|{caller.conversation}|Bearer {env:ACME_TOKEN}", ctx), {
    ok: true, value: "declared-user|claude|t_123|Bearer tok-9f8e7d",
    resolved: [
      { name: "caller.user", value: "declared-user" }, { name: "caller.agent", value: "claude" },
      { name: "caller.conversation", value: "t_123" }, { name: "ACME_TOKEN", value: "tok-9f8e7d" },
    ],
  });
  assert.deepEqual(resolveReferences("{caller.agent}", { ...ctx, caller: { ...caller, agent: "pi" } }), {
    ok: true, value: "pi", resolved: [{ name: "caller.agent", value: "pi" }],
  }, "a short caller value is reported like any other");
  assert.deepEqual(resolveReferences("no references", ctx), { ok: true, value: "no references", resolved: [] });
  const map = resolveReferenceMap({ authorization: "Bearer {env:ACME_TOKEN}", "x-tenant": "{env:ACME_TENANT}", "x-again": "{env:ACME_TOKEN}" }, ctx);
  assert.deepEqual(map, {
    ok: true,
    value: { authorization: "Bearer tok-9f8e7d", "x-tenant": "tenant-42", "x-again": "tok-9f8e7d" },
    resolved: [{ name: "ACME_TOKEN", value: "tok-9f8e7d" }, { name: "ACME_TENANT", value: "tenant-42" }],
  });
});

test("a missing or empty value is unresolved, every one is named, and no value appears in the reason", () => {
  const result = resolveReferenceMap({
    a: "{env:ACME_TOKEN} {env:NOT_SET}", b: "{env:EMPTY}", c: "{caller.user}", d: "{env:NOT_SET}",
  }, { ...ctx, caller: { ...caller, user: "" } });
  assert.deepEqual(result, { ok: false, missing: ["{env:NOT_SET}", "{env:EMPTY}", "{caller.user}"] });
  const reason = missingReferenceReason((result as { missing: string[] }).missing);
  assert.equal(reason, "The references {env:NOT_SET}, {env:EMPTY}, {caller.user} did not resolve to values, so the shaper was not called.");
  assert.equal(reason.includes("tok-9f8e7d"), false);
  assert.deepEqual(resolveReferences("{caller.agent}", { ...ctx, caller: { ...caller, agent: null } }), { ok: false, missing: ["{caller.agent}"] });
  assert.deepEqual(resolveReferences("{caller.nobody}", ctx), { ok: false, missing: ["{caller.nobody}"] }, "a kind this build does not know fails closed");
});

test("Mission Control's own variables never resolve, nor does a value that carries the daemon's token", () => {
  assert.deepEqual(resolveReferences("{env:MISSION_API_TOKEN}", ctx), { ok: false, missing: ["{env:MISSION_API_TOKEN}"] });
  assert.deepEqual(resolveReferences("{env:WRAPPED}", { ...ctx, env: { WRAPPED: "x-daemon-token-value-y" } }), { ok: false, missing: ["{env:WRAPPED}"] });
});

test("the status lists every environment name a shaper references as set or unset, and never a value", () => {
  const remote = ShaperSchema.parse({
    id: "remote", label: "Remote", stage: "select",
    transport: { type: "http", url: "https://guidance.example.test/v1", headers: { authorization: "Bearer {env:ACME_TOKEN}", "x-caller": "{caller.user}" } },
  });
  const mcp = ShaperSchema.parse({
    id: "guidance", label: "Guidance", stage: "select",
    transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: "https://mcp.example.test/mcp", headers: { "x-api-key": "{env:NOT_SET}", "x-tenant": "{env:EMPTY}" } } },
  });
  const local = ShaperSchema.parse({
    id: "local", label: "Local", stage: "gather",
    transport: { type: "command", command: "/bin/echo", env: ["PASSED_THROUGH", "MISSION_API_TOKEN", "TRACEPARENT", "ACME_TENANT"] },
  });
  const stdio = ShaperSchema.parse({
    id: "stdio", label: "Stdio", stage: "select",
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: "/bin/echo", env: ["STDIO_ONLY"] } },
  });
  const status = referenceStatus({ ...SHAPING_CONFIG_DEFAULTS, shapers: [remote, local, stdio] }, [
    { id: "found", path: "/shapers/found/shaper.json", state: "ok", problem: null, sha256: null, shaper: mcp },
  ], env, ctx.daemonToken);
  assert.deepEqual(status, {
    ACME_TENANT: "set", ACME_TOKEN: "set", EMPTY: "unset", MISSION_API_TOKEN: "unset", NOT_SET: "unset",
    PASSED_THROUGH: "unset", STDIO_ONLY: "unset",
  }, "header references and pass-through names alike; Mission Control's own token is never set, and a carrier's name is not listed");
  assert.equal(JSON.stringify(status).includes("tok-9f8e7d"), false);
  assert.deepEqual(referenceStatus(SHAPING_CONFIG_DEFAULTS, [], env), {});
});

const values = [{ name: "ACME_TOKEN", value: "tok-9f8e7d" }];

test("scrubResolved redacts a value in an entry body, a title, the summary, a fact value and a note", () => {
  const reply = {
    version: "v1",
    guidance: [{ id: "one", title: "for tok-9f8e7d", body: "use tok-9f8e7d here", path: "a/tok-9f8e7d.md" }],
    repo: { summary: "summary tok-9f8e7d", facts: { owner: "tok-9f8e7d", tags: ["a", "tok-9f8e7d"] } },
    notes: ["note tok-9f8e7d"],
  };
  const scrubbed = scrubResolved(reply, values);
  assert.equal(scrubbed.redacted, true);
  assert.deepEqual(scrubbed.data, {
    version: "v1",
    guidance: [{ id: "one", title: "for [ACME_TOKEN redacted]", body: "use [ACME_TOKEN redacted] here", path: "a/[ACME_TOKEN redacted].md" }],
    repo: { summary: "summary [ACME_TOKEN redacted]", facts: { owner: "[ACME_TOKEN redacted]", tags: ["a", "[ACME_TOKEN redacted]"] } },
    notes: ["note [ACME_TOKEN redacted]"],
  });
  assert.equal(ShapingResultSchema.safeParse(scrubbed.data).success, true);
});

test("a fact name or an entry id that contains a value is dropped with a note, never renamed", () => {
  const scrubbed = scrubResolved({
    guidance: [{ id: "id-tok-9f8e7d", body: "dropped" }, { id: "kept", body: "kept" }],
    repo: { facts: { "name-tok-9f8e7d": "x", language: "python" } },
  }, values);
  assert.equal(scrubbed.redacted, true);
  assert.deepEqual(scrubbed.data, { guidance: [{ id: "kept", body: "kept" }], repo: { facts: { language: "python" } } });
  assert.deepEqual(scrubbed.notes, [
    "An entry was dropped because its id contained the value of ACME_TOKEN.",
    "A fact was dropped because its name contained the value of ACME_TOKEN.",
  ]);
});

test("two fact names that differ only in their credential value are both dropped, and every other fact is kept", () => {
  const two = [{ name: "A", value: "alpha-secret" }, { name: "B", value: "bravo-secret" }];
  const scrubbed = scrubResolved({ repo: { facts: { "key-alpha-secret": "1", "key-bravo-secret": "2", language: "python", framework: ["django"] } } }, two);
  assert.deepEqual(scrubbed.data, { repo: { facts: { language: "python", framework: ["django"] } } });
  assert.equal(scrubbed.notes.length, 2);
});

test("a value that is part of a schema key leaves the keys unchanged and the reply valid", () => {
  const scrubbed = scrubResolved({ guidance: [{ id: "a", body: "the guidance" }], degraded: false }, [{ name: "SHORT", value: "guidance" }]);
  assert.deepEqual(Object.keys(scrubbed.data as object), ["guidance", "degraded"]);
  assert.deepEqual((scrubbed.data as { guidance: unknown[] }).guidance, [{ id: "a", body: "the [SHORT redacted]" }]);
  assert.equal(ShapingResultSchema.safeParse(scrubbed.data).success, true);
});

test("one value inside another is still covered, over their combined span", () => {
  const nested = [{ name: "OUTER", value: "abc-inner-xyz" }, { name: "INNER", value: "inner" }];
  const scrubbed = scrubResolved({ guidance: [{ id: "a", body: "1 abc-inner-xyz 2 inner 3" }] }, nested);
  assert.equal((scrubbed.data as { guidance: Array<{ body: string }> }).guidance[0]!.body, "1 [OUTER, INNER redacted] 2 [INNER redacted] 3");
  assert.equal(redactResolved("abc-inner-xyz", nested).includes("inner"), false);
});

test("a resolved caller value is redacted anywhere it appears, however short, inside a word included", () => {
  const callerValues = [{ name: "caller.user", value: "declared-user" }, { name: "caller.agent", value: "pi" }];
  const scrubbed = scrubResolved({
    guidance: [
      { id: "api/pipeline", body: "dropped: its id holds the value" },
      { id: "kept", title: "for declared-user", body: "run pi then the pipeline" },
    ],
  }, callerValues);
  assert.equal(scrubbed.redacted, true);
  assert.deepEqual(scrubbed.data, {
    guidance: [{ id: "kept", title: "for [caller.user redacted]", body: "run [caller.agent redacted] then the [caller.agent redacted]peline" }],
  }, "over-redaction is the accepted cost: no echo of a short value survives inside a longer word");
  assert.deepEqual(scrubbed.notes, ["An entry was dropped because its id contained the value of caller.agent."]);
  assert.deepEqual(scrubReason("denied for declared-user via pipe pi", callerValues),
    { reason: "denied for [caller.user redacted] via [caller.agent redacted]pe [caller.agent redacted]", redacted: true });
});

test("a value written with other whitespace where it has some is found as the value", () => {
  const spaced = [{ name: "caller.user", value: "Jane Doe" }];
  const scrubbed = scrubResolved({ guidance: [{ id: "a", title: "for Jane   Doe", body: "Jane\nDoe and JaneDoe" }] }, spaced);
  assert.equal(scrubbed.redacted, true);
  assert.deepEqual(scrubbed.data, { guidance: [{ id: "a", title: "for [caller.user redacted]", body: "[caller.user redacted] and JaneDoe" }] },
    "a spacing variant is a copy, a run-together spelling is not");
  const dropped = scrubResolved({ guidance: [{ id: "Jane\tDoe", body: "x" }, { id: "kept", body: "y" }] }, spaced);
  assert.deepEqual(dropped.data, { guidance: [{ id: "kept", body: "y" }] }, "an id holding a variant is dropped, as one holding the value is");
  assert.deepEqual(scrubReason("denied for Jane  Doe", spaced), { reason: "denied for [caller.user redacted]", redacted: true });
});

test("a value spelled with any JSON escape inside reply text is redacted, and only that span changes", () => {
  const scrubbed = scrubResolved({ guidance: [{ id: "a", body: '{"key":"\\u0074ok-9f8e7d","other":"kept \\u0041"}' }] }, values);
  assert.equal(scrubbed.redacted, true);
  assert.deepEqual(scrubbed.data, { guidance: [{ id: "a", body: '{"key":"[ACME_TOKEN redacted]","other":"kept \\u0041"}' }] },
    "the escaped spelling of the value goes; an unrelated escape stays as written");
  assert.deepEqual(scrubReason("denied: tok\\u002d9f8e7d", values), { reason: "denied: [ACME_TOKEN redacted]", redacted: true });
});

test("the status leaves out a variable named only in a header the transport replaces", () => {
  const owned = ShaperSchema.parse({
    id: "owned", label: "Owned", stage: "select",
    transport: { type: "http", url: "https://guidance.example.test/v1", headers: { Accept: "{env:ONLY_IN_ACCEPT}", traceparent: "{env:ONLY_IN_TRACE}", "x-key": "{env:ACME_TOKEN}" } },
  });
  assert.deepEqual(referenceStatus({ ...SHAPING_CONFIG_DEFAULTS, shapers: [owned] }, [], env, ctx.daemonToken), { ACME_TOKEN: "set" });
});

test("a value of many repeated words is matched in linear time against a reply of near-matches", () => {
  // 4,000 words, and a 256 KiB reply of that word repeated with one space between: every start is
  // a near-match that runs almost the whole value before failing on the final word. A search that
  // rescans from each start takes seconds here; the collapsed-view search takes milliseconds.
  const value = `${"tok ".repeat(3_999)}end`;
  const reply = "tok ".repeat(64 * 1024);
  const started = performance.now();
  assert.equal(redactResolved(reply, [{ name: "KEY", value }]), reply);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
  // A real spacing variant among them is still found.
  const spaced = `${"tok ".repeat(100)}${value.replace(/ /g, "  ")} tok`;
  assert.equal(redactResolved(spaced, [{ name: "KEY", value }]).includes("end"), false);
});

test("spans for a value shared by several names stay bounded by the text, not by its matches", () => {
  // Five references resolving to one short value, in a field that holds one escape, so every
  // level is decoded, and 50,000 literal copies of the value that the caller's own search finds.
  const names = ["caller.agent", "A", "B", "C", "D"];
  const resolved = names.map((name) => ({ name, value: "pi" }));
  const literal = `\\u0041 ${"pi ".repeat(50_000)}`;
  assert.equal(variantSpans(literal, resolved).length, 0, "literal copies are left to the search for the value as written");
  assert.equal(redactResolved(literal, resolved).includes("pi"), false, "and are still removed");
  // 50,000 escaped copies side by side: one stretch of text, so one span, carrying every name.
  const escaped = "\\u0070i".repeat(50_000);
  const spans = variantSpans(escaped, resolved);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], { start: 0, end: escaped.length, labels: names });
  assert.equal(redactResolved(escaped, resolved), `[${names.join(", ")} redacted]`);
});

test("overlapping spacing variants of a value are all found, as written and inside escaped text", () => {
  const resolved = [{ name: "KEY", value: "ab ab" }];
  // `ab  ab` at 0 and at 4 share the middle `ab`: both are removed, and nothing of either is left.
  assert.equal(redactResolved("note ab  ab  ab end", resolved), "note [KEY redacted] end");
  assert.equal(redactResolved("note ab\\u0020\\u0020ab\\u0020\\u0020ab end", resolved), "note [KEY redacted] end");
  const scrubbed = scrubResolved({ guidance: [{ id: "g", body: "use ab  ab  ab here" }] }, resolved);
  assert.equal(scrubbed.redacted, true);
  assert.equal((scrubbed.data as { guidance: Array<{ body: string }> }).guidance[0]!.body, "use [KEY redacted] here");
});

test("a caller value of only spaces and tabs is unresolved, as a blank environment value is", () => {
  for (const blank of [" ", "\t", " \t  "]) {
    assert.deepEqual(resolveReferences("{caller.user}", { ...ctx, caller: { ...caller, user: blank } }), { ok: false, missing: ["{caller.user}"] });
    assert.deepEqual(resolveReferences("agent {caller.agent}", { ...ctx, caller: { ...caller, agent: blank } }), { ok: false, missing: ["{caller.agent}"] });
    assert.deepEqual(resolveReferences("{caller.conversation}", { ...ctx, caller: { ...caller, conversation: blank } }), { ok: false, missing: ["{caller.conversation}"] });
  }
  // Inner whitespace is a value, not a blank one.
  assert.deepEqual(resolveReferences("{caller.user}", { ...ctx, caller: { ...caller, user: "Jane Doe" } }), {
    ok: true, value: "Jane Doe", resolved: [{ name: "caller.user", value: "Jane Doe" }],
  });
});

test("a resolved value escaped at every supported level of nested JSON text is found and removed", () => {
  const value = "nest-key-9q2z";
  let text = `{"x-api-key":"${[...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`;
  for (let level = 1; level <= JSON_ESCAPE_LEVELS; level++) {
    assert.equal(holdsResolvedValue(text, [{ name: "KEY", value }]), true, `level ${level}`);
    const scrubbed = redactResolved(text, [{ name: "KEY", value }]);
    assert.ok(scrubbed.includes("[KEY redacted]"), `level ${level}: ${scrubbed}`);
    assert.equal(scrubbed.includes("\\u00"), false, `level ${level}: ${scrubbed}`);
    text = JSON.stringify({ diagnostic: text });
  }
});

test("an environment reference reads only the environment's own non-blank string", () => {
  assert.deepEqual(resolveReferences("{env:constructor}", ctx), { ok: false, missing: ["{env:constructor}"] }, "never an inherited property");
  assert.deepEqual(resolveReferences("Bearer {env:BLANK}", { ...ctx, env: { BLANK: " \t " } }), { ok: false, missing: ["{env:BLANK}"] },
    "a value of only spaces and tabs would leave a bare scheme, so it is unresolved");
  const inherited = ShaperSchema.parse({
    id: "inherited", label: "Inherited", stage: "select",
    transport: { type: "http", url: "https://guidance.example.test/v1", headers: { "x-a": "{env:constructor}", "x-b": "{env:toString}", "x-c": "{env:BLANK}" } },
  });
  const passing = ShaperSchema.parse({
    id: "passing", label: "Passing", stage: "gather", transport: { type: "command", command: "/bin/echo", env: ["SPACES_ONLY", "hasOwnProperty"] },
  });
  // With a daemon token configured, an inherited function value would have thrown on `includes`.
  assert.deepEqual(referenceStatus({ ...SHAPING_CONFIG_DEFAULTS, shapers: [inherited, passing] }, [], { BLANK: "  ", SPACES_ONLY: "  " }, "daemon-token"), {
    BLANK: "unset", SPACES_ONLY: "set", constructor: "unset", hasOwnProperty: "unset", toString: "unset",
  }, "a pass-through value of spaces still reaches a command, as that transport passes it");
});

test("a variable or header named __proto__ is an ordinary name, never lost to the prototype", () => {
  const proto = ShaperSchema.parse({
    id: "proto", label: "Proto", stage: "select",
    transport: { type: "http", url: "https://guidance.example.test/v1", headers: JSON.parse('{"x-key": "{env:__proto__}"}') },
  });
  const status = referenceStatus({ ...SHAPING_CONFIG_DEFAULTS, shapers: [proto] }, [], JSON.parse('{"__proto__": "proto-value"}'), "");
  assert.ok(Object.hasOwn(status, "__proto__"), JSON.stringify(status));
  assert.equal(status.__proto__, "set");
  const map = resolveReferenceMap(JSON.parse('{"__proto__": "{caller.user}"}'), ctx);
  assert.equal(map.ok, true);
  assert.ok(map.ok && Object.hasOwn(map.value, "__proto__"), "the header is an own entry and is sent");
  assert.equal(map.ok && map.value.__proto__, "declared-user");
});

test("a reply that repeats one escaped spacing variant thousands of times is scrubbed in linear time", { timeout: 10_000 }, () => {
  const spaced = [{ name: "caller.user", value: "Jane Doe" }];
  // About 240 KiB of the same escaped, spaced-out spelling, within a reply's 256 KiB cap.
  const body = "J\\u0061ne\\t\\tDoe ".repeat(15_000);
  const started = performance.now();
  const scrubbed = scrubResolved({ guidance: [{ id: "a", body }] }, spaced);
  const elapsed = performance.now() - started;
  assert.equal(scrubbed.redacted, true);
  assert.equal((scrubbed.data as { guidance: Array<{ body: string }> }).guidance[0]!.body.includes("ne\\t"), false);
  assert.ok(elapsed < 3_000, `scrubbed in ${Math.round(elapsed)} ms`);
});

test("a value with a line break or a NUL is unresolved: a header could not carry it as written", () => {
  for (const value of ["tok-9f8e7d\r\n", "tok\n9f8e7d", "\rtok", "tok\u00009f"]) {
    assert.deepEqual(resolveReferences("Bearer {env:BROKEN}", { ...ctx, env: { BROKEN: value } }), { ok: false, missing: ["{env:BROKEN}"] }, JSON.stringify(value));
  }
});

test("a reply full of distinct spellings of a value is scrubbed in linear time", { timeout: 20_000 }, () => {
  const spaced = [{ name: "caller.user", value: "Jane Doe" }];
  // 8,000 copies, each spaced with a different pattern of spaces and tabs: every spelling distinct.
  const spellings = Array.from({ length: 8_000 }, (_, i) => `Jane${[...i.toString(2).padStart(13, "0")].map((bit) => (bit === "1" ? "\t" : " ")).join("")}Doe`);
  const body = spellings.join(" ");
  assert.equal(new Set(spellings).size, 8_000);
  const started = performance.now();
  const scrubbed = scrubResolved({ guidance: [{ id: "a", body }] }, spaced);
  const elapsed = performance.now() - started;
  assert.equal(scrubbed.redacted, true);
  assert.equal((scrubbed.data as { guidance: Array<{ body: string }> }).guidance[0]!.body.includes("Doe"), false);
  assert.ok(elapsed < 3_000, `scrubbed in ${Math.round(elapsed)} ms`);
});

test("a value with a character a header cannot encode is unresolved, and its status is unset", () => {
  assert.deepEqual(resolveReferences("{env:WIDE}", { ...ctx, env: { WIDE: "tok-€-9f" } }), { ok: false, missing: ["{env:WIDE}"] });
  assert.deepEqual(resolveReferences("{caller.user}", { ...ctx, caller: { ...caller, user: "李雷" } }), { ok: false, missing: ["{caller.user}"] });
  assert.deepEqual(resolveReferences("{caller.user}", { ...ctx, caller: { ...caller, user: "Jördan" } }), {
    ok: true, value: "Jördan", resolved: [{ name: "caller.user", value: "Jördan" }],
  }, "Latin-1 is sendable");
  const wide = ShaperSchema.parse({
    id: "wide", label: "Wide", stage: "select",
    transport: { type: "http", url: "https://guidance.example.test/v1", headers: { "x-key": "{env:WIDE}" } },
  });
  assert.deepEqual(referenceStatus({ ...SHAPING_CONFIG_DEFAULTS, shapers: [wide] }, [], { WIDE: "tok-€-9f" }, ""), { WIDE: "unset" });
});

test("a reply with no value comes back unchanged and unmarked", () => {
  const reply = { guidance: [{ id: "a", body: "nothing secret" }] };
  const before = structuredClone(reply);
  const scrubbed = scrubResolved(reply, values);
  assert.deepEqual(scrubbed, { data: before, redacted: false, notes: [] });
  assert.deepEqual(scrubReason("nothing secret", values), { reason: "nothing secret", redacted: false });
  assert.deepEqual(scrubReason("denied tok-9f8e7d", values), { reason: "denied [ACME_TOKEN redacted]", redacted: true });
});

test("a routed skill whose name or reason id holds a value is dropped with a note, and the rest are kept", () => {
  // Its own placeholder credential, so the routed-skill case names no company.
  const routerValues = [{ name: "ROUTER_TOKEN", value: "tok-9f8e7d" }];
  const scrubbed = scrubResolved({
    skills: [
      { name: "lint-tok-9f8e7d", lifecycle_point: "during", reason_id: "r/1" },
      { name: "retro", lifecycle_point: "after-work", reason_id: "r/tok-9f8e7d" },
      { name: "ship", lifecycle_point: "task-start", reason_id: "r/2" },
    ],
    notes: ["routed for tok-9f8e7d"],
  }, routerValues);
  assert.equal(scrubbed.redacted, true);
  assert.deepEqual(scrubbed.data, {
    skills: [{ name: "ship", lifecycle_point: "task-start", reason_id: "r/2" }],
    notes: ["routed for [ROUTER_TOKEN redacted]"],
  });
  assert.deepEqual(scrubbed.notes, [
    "A skill was dropped because its name or reason id contained the value of ROUTER_TOKEN.",
    "A skill was dropped because its name or reason id contained the value of ROUTER_TOKEN.",
  ]);
  // An invalid route reply is left exactly as sent, for the engine to refuse.
  const invalid = { skills: [{ name: "Not Valid tok-9f8e7d", lifecycle_point: "during", reason_id: "r" }] };
  assert.deepEqual(scrubResolved(structuredClone(invalid), routerValues), { data: invalid, redacted: false, notes: [] });
});
