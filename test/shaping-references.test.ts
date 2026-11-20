// References resolve at call time and never leave as values: resolution, the set or unset
// status, and `scrubResolved` over a reply.
import assert from "node:assert/strict";
import test from "node:test";
import { SHAPING_CONFIG_DEFAULTS, ShaperSchema, ShapingResultSchema } from "../src/shared/shaping.ts";
import {
  missingReferenceReason, redactResolved, referenceStatus, resolveReferenceMap, resolveReferences, scrubReason, scrubResolved,
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

test("a reply with no value comes back unchanged and unmarked", () => {
  const reply = { guidance: [{ id: "a", body: "nothing secret" }] };
  const before = structuredClone(reply);
  const scrubbed = scrubResolved(reply, values);
  assert.deepEqual(scrubbed, { data: before, redacted: false, notes: [] });
  assert.deepEqual(scrubReason("nothing secret", values), { reason: "nothing secret", redacted: false });
  assert.deepEqual(scrubReason("denied tok-9f8e7d", values), { reason: "denied [ACME_TOKEN redacted]", redacted: true });
});
