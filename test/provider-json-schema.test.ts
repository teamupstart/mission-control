import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  assertStrictJsonSchema,
  nullOptionalsPayload,
  permitsNull,
} from "./helpers/strict-json-schema.ts";

// The provider-facing schema contract, in one place.
//
// `codex exec --output-schema` hands the rendered schema to strict Structured Outputs, which
// rejects any object that does not list every key of `properties` in `required` - the whole
// CALL fails with `invalid_json_schema`, so the feature stops rather than degrades. That is
// what took the Inspector down on every open pull request, and `zodToJsonSchema` produces the
// rejected shape for any `.optional()` or `.default()` field, which is to say for most of them.
//
// Two halves are asserted here, and they only mean something together:
//   1. every schema that reaches `LlmRunOptions.schema` renders strict-clean; and
//   2. the Zod schema behind it can still READ the reply that wire shape now produces.
// Half 1 alone would let a fix trade a provider error for a parse miss, which is worse -
// `invalid_json_schema` is loud, and a parse miss burns a retry and then degrades quietly.

const home = mkdtempSync(join(tmpdir(), "provider-json-schema-"));
process.env.HARNESS_HOME = join(home, "state");
after(() => rmSync(home, { recursive: true, force: true }));

// Dynamic, AFTER HARNESS_HOME is pinned: `workflows/context.ts` reaches `db.ts`, which
// resolves the state dir at import time, and a static import would be hoisted above the line
// above and lock in the machine's real one.
const { providerJsonSchema, nullAsAbsent } = await import("../src/server/llm/json-schema.ts");
const { InspectorVerdictSchema, InspectorReplySchema } = await import(
  "../src/server/inspector/verdict.ts"
);
const { BacklogReportSchema } = await import("../src/server/foreman/backlog-plan.ts");
const { QueueVerdictSchema } = await import("../src/server/foreman/queue-verify.ts");
const { ShipRecoveryReviewWireSchema } = await import(
  "../src/server/foreman/ship-recovery-review.ts"
);
const { TriageReportSchema } = await import("../src/server/foreman/triage.ts");
const { CompactionSchema, CriterionReconciliationSchema } = await import(
  "../src/server/workflows/context.ts"
);
const { ConsensusResultSchema } = await import("../src/shared/ensemble-strategies/consensus.ts");
const { BestOfNComparisonResultSchema } = await import(
  "../src/shared/ensemble-strategies/best-of-n.ts"
);
const { PanelBallotSchema } = await import("../src/shared/ensemble-strategies/panel-vote.ts");

/**
 * Every schema currently passed via `LlmRunOptions.schema`, named by the identifier its
 * `providerJsonSchema(...)` call site uses.
 *
 * `identifier` is load-bearing: the source scan at the bottom of this file uses it to prove
 * this list is the WHOLE list, so a sixth broken schema cannot be added without either
 * appearing here or turning the suite red. The audit that produced this fix found five
 * failures across four subsystems from a single rendering helper, and only two of them were
 * live on the affected provider - the other two were latent, which is exactly the kind of
 * thing a hand-maintained list quietly stops covering.
 */
const SCHEMAS = [
  { identifier: "InspectorVerdictSchema", schema: InspectorVerdictSchema },
  { identifier: "InspectorReplySchema", schema: InspectorReplySchema },
  { identifier: "BacklogReportSchema", schema: BacklogReportSchema },
  { identifier: "QueueVerdictSchema", schema: QueueVerdictSchema },
  { identifier: "ShipRecoveryReviewWireSchema", schema: ShipRecoveryReviewWireSchema },
  { identifier: "TriageReportSchema", schema: TriageReportSchema },
  { identifier: "CompactionSchema", schema: CompactionSchema },
  { identifier: "CriterionReconciliationSchema", schema: CriterionReconciliationSchema },
  { identifier: "ConsensusResultSchema", schema: ConsensusResultSchema },
  { identifier: "BestOfNComparisonResultSchema", schema: BestOfNComparisonResultSchema },
  { identifier: "PanelBallotSchema", schema: PanelBallotSchema },
] as const;

// ---------------------------------------------------------------------------
// Half 1: every live schema renders strict-clean.
// ---------------------------------------------------------------------------

for (const { identifier, schema } of SCHEMAS) {
  test(`${identifier} renders a strict provider schema at every depth`, () => {
    assertStrictJsonSchema(providerJsonSchema(schema), identifier);
  });
}

type Node = Record<string, unknown>;

/** Descend a rendered schema: `at(s, "tasks", "items", "id")`. */
function at(schema: Node, ...steps: string[]): Node {
  let node = schema;
  for (const step of steps) {
    const next = step === "items" ? node.items : (node.properties as Node)[step];
    assert.ok(next && typeof next === "object", `no sub-schema at ${step}`);
    node = next as Node;
  }
  return node;
}

const requiredOf = (node: Node): string[] => (node.required as string[]).slice().sort();

// The specific failures the audit named, pinned individually so a regression says WHICH key
// went missing rather than only that something did. Each of these was a live or latent
// `invalid_json_schema` before the fix.
test("the five audited schemas carry the exact keys that used to be missing", () => {
  const required = (s: z.ZodTypeAny): string[] => requiredOf(providerJsonSchema(s));

  assert.deepEqual(required(InspectorVerdictSchema), ["findings", "resolved", "summary"]);
  assert.deepEqual(
    requiredOf(at(providerJsonSchema(InspectorVerdictSchema), "findings", "items")),
    ["body", "line", "path", "severity", "title"],
    "the nested finding was broken too, one level below the root the audit found first",
  );

  assert.deepEqual(required(InspectorReplySchema), ["reply", "resolved"]);
  assert.deepEqual(required(BacklogReportSchema), ["note", "tasks"]);
  assert.deepEqual(requiredOf(at(providerJsonSchema(BacklogReportSchema), "tasks", "items")), [
    "dependsOn",
    "id",
    "reason",
  ]);

  assert.deepEqual(required(QueueVerdictSchema), [
    "complete",
    "confidence",
    "gaps",
    "resolved",
    "summary",
  ]);
  assert.deepEqual(required(TriageReportSchema), [
    "answer",
    "brief",
    "bucket",
    "confidence",
    "disposition",
    "purpose",
    "recommendation",
  ]);
});

// ---------------------------------------------------------------------------
// Half 2: the Zod side still reads what that wire shape produces.
// ---------------------------------------------------------------------------

for (const { identifier, schema } of SCHEMAS) {
  test(`${identifier} parses a reply that declines every optional with null`, () => {
    const rendered = providerJsonSchema(schema);
    const payload = nullOptionalsPayload(rendered);
    const parsed = schema.safeParse(payload);
    assert.ok(
      parsed.success,
      `${identifier}: the wire schema permits null here, so the Zod schema must read it. ` +
        `Wrap the field in nullAsAbsent. Payload: ${JSON.stringify(payload)}. ` +
        `Error: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
    );
  });
}

// The generated payload above proves nothing breaks. These pin what the values BECOME, which
// is the part downstream behaviour actually depends on.
test("a null optional lands on the same value an omitted key used to", () => {
  const verdict = InspectorVerdictSchema.parse({ summary: "s", findings: null, resolved: null });
  assert.deepEqual(verdict.findings, [], "no findings must still read as a clean review");
  assert.deepEqual(verdict.resolved, [], "null must close nothing - the narrowing stays closed");

  assert.equal(
    InspectorReplySchema.parse({ reply: "r", resolved: null }).resolved,
    false,
    "a null resolved is an answer, not a retraction",
  );

  const backlog = BacklogReportSchema.parse({
    tasks: [{ id: "a", dependsOn: null, reason: null }],
    note: null,
  });
  assert.deepEqual(backlog.tasks[0]!.dependsOn, []);
  assert.equal(backlog.tasks[0]!.reason, undefined, "no invented reason text");
  assert.equal(backlog.note, undefined, "no invented note text");

  const queue = QueueVerdictSchema.parse({
    complete: true,
    summary: "s",
    gaps: null,
    resolved: null,
    confidence: null,
  });
  assert.deepEqual(queue.gaps, []);
  assert.deepEqual(queue.resolved, []);
  assert.equal(queue.confidence, 0.5, "the safety gate keeps its declared default");

  const triage = TriageReportSchema.parse({
    purpose: "p",
    bucket: "needs-judgment",
    disposition: null,
    answer: null,
    brief: null,
    recommendation: null,
    confidence: 0.9,
  });
  assert.equal(triage.disposition, undefined, "null must not become a skip");
  assert.equal(triage.answer, undefined, "null must not become an answer to deliver");
  assert.equal(triage.brief, undefined);
  assert.equal(triage.recommendation, undefined);
});

test("a null optional never widens the answer a strict field is allowed to give", () => {
  // `disposition` is nullable on the wire, so `null` has to be legal - but only `null`. A
  // model that sends a value outside the enum still fails, which is what keeps the human-only
  // branch reading a bucketing rather than a free-text string.
  assert.equal(
    TriageReportSchema.safeParse({
      purpose: "p",
      bucket: "human-only",
      disposition: "maybe",
      confidence: 0.9,
    }).success,
    false,
  );
  // And the fail-closed direction survives: an explicit skip still skips.
  assert.equal(
    TriageReportSchema.parse({
      purpose: "p",
      bucket: "human-only",
      disposition: "skip",
      confidence: 0.9,
    }).disposition,
    "skip",
  );
});

// ---------------------------------------------------------------------------
// Controls: the schemas that were already compatible must come back untouched.
// ---------------------------------------------------------------------------

const CONTROLS = [
  { identifier: "CompactionSchema", schema: CompactionSchema },
  { identifier: "CriterionReconciliationSchema", schema: CriterionReconciliationSchema },
  { identifier: "ConsensusResultSchema", schema: ConsensusResultSchema },
  { identifier: "BestOfNComparisonResultSchema", schema: BestOfNComparisonResultSchema },
  { identifier: "PanelBallotSchema", schema: PanelBallotSchema },
] as const;

for (const { identifier, schema } of CONTROLS) {
  test(`${identifier} is unchanged by strictification`, () => {
    // Rendered the way the helper used to, before it strictified. These four already listed
    // every key in `required` at every depth - the workflow one demonstrably so, with 72
    // successful live Codex compactions behind it - so the fix must be a no-op on them. If
    // this drifts, the strictifier started rewriting schemas that were already correct.
    const raw = zodToJsonSchema(schema, { $refStrategy: "none" });
    assert.deepEqual(providerJsonSchema(schema), raw);
  });
}

// ---------------------------------------------------------------------------
// The strictifier itself.
// ---------------------------------------------------------------------------

test("an optional property becomes required AND nullable, so absence stays sayable", () => {
  const rendered = providerJsonSchema(z.object({ a: z.string(), b: z.string().optional() }));
  assert.deepEqual(rendered.required, ["a", "b"]);
  assert.deepEqual(at(rendered, "a").type, "string", "an already-required field is left alone");
  assert.deepEqual(
    at(rendered, "b").type,
    ["string", "null"],
    "a required non-nullable optional would force the model to invent a value",
  );
});

test("nested objects are strictified at every depth", () => {
  const rendered = providerJsonSchema(
    z.object({
      outer: z.object({
        inner: z.object({ deep: z.string().optional() }).optional(),
      }),
    }),
  );
  const outer = at(rendered, "outer");
  const inner = at(outer, "inner");
  const deep = at(inner, "deep");
  assert.deepEqual(outer.required, ["inner"]);
  assert.deepEqual(inner.required, ["deep"]);
  assert.deepEqual(inner.type, ["object", "null"]);
  assert.deepEqual(deep.type, ["string", "null"]);
  assert.equal(inner.additionalProperties, false);
});

test("objects inside array items are strictified", () => {
  const rendered = providerJsonSchema(
    z.object({ rows: z.array(z.object({ a: z.string(), b: z.number().optional() })) }),
  );
  const items = at(rendered, "rows", "items");
  assert.deepEqual(items.required, ["a", "b"]);
  assert.equal(items.additionalProperties, false);
});

// Two shapes strict mode cannot express. Neither exists in this codebase today, and the point
// of pinning them is that the first one to arrive must FAIL LOUDLY rather than be quietly
// rewritten into something that validates but means less than the author wrote.
test("a record's catchall is left alone rather than replaced with a closed object", () => {
  const rendered = providerJsonSchema(z.object({ bag: z.record(z.string()) }));
  const bag = at(rendered, "bag");
  // Forcing `additionalProperties: false` here would leave a map that can hold nothing.
  assert.deepEqual(bag.additionalProperties, { type: "string" });
  assert.equal("properties" in bag, false, "a record has no properties to require");
  assert.throws(
    () => assertStrictJsonSchema(rendered, "record"),
    "the assertion, not a silent rewrite, is what reports a shape strict mode will not take",
  );
});

test("a catchall object keeps its catchall, and is still reported as non-strict", () => {
  // `.catchall()` has BOTH `properties` and a schema-valued `additionalProperties`, so it
  // reaches the closing lines of `strictify` where a bare record returns early. Overwriting
  // that schema with `false` would delete the author's contract without a word.
  const rendered = providerJsonSchema(
    z.object({ a: z.string() }).catchall(z.object({ n: z.number().optional() })),
  );
  assert.deepEqual(
    rendered.additionalProperties,
    { type: "object", properties: { n: { type: ["number", "null"] } }, required: ["n"], additionalProperties: false },
    "the catchall survives AND is itself strictified, rather than being discarded",
  );
  assert.deepEqual(rendered.required, ["a"], "declared properties are still required");
  assert.throws(
    () => assertStrictJsonSchema(rendered, "catchall"),
    "strict mode will not take this shape, and the assertion has to be the one to say so",
  );
});

test("an optional enum gains null in the enum, not only in the type", () => {
  // `"type": ["string","null"]` beside `"enum": ["a","b"]` reads as nullable and is not:
  // `enum` alone still rejects null, so the model would have no legal way to decline.
  const rendered = providerJsonSchema(z.object({ pick: z.enum(["a", "b"]).optional() }));
  const pick = at(rendered, "pick");
  assert.deepEqual(pick.type, ["string", "null"]);
  assert.deepEqual(pick.enum, ["a", "b", null]);
});

test("an optional literal stays satisfiable, rather than being nullable in name only", () => {
  // `z.literal()` renders as `const`, which pins the value exactly. Widening `type` and
  // leaving `const` alone declares null legal by type and illegal by const: a field marked
  // nullable that NO value satisfies, so the model could never decline it.
  const rendered = providerJsonSchema(
    z.object({ kind: z.literal("access").optional(), n: z.literal(7).optional() }),
  );
  const kind = at(rendered, "kind");
  assert.equal("const" in kind, false, "const must not survive alongside a nullable type");
  assert.deepEqual(kind.enum, ["access", null]);
  assert.deepEqual(kind.type, ["string", "null"]);
  assert.ok(permitsNull(kind), "the whole point: null is reachable, not just declared");
  // The literal is still pinned - widening must not turn it into any string.
  assert.deepEqual(at(rendered, "n").enum, [7, null]);
  assertStrictJsonSchema(rendered, "optional literal");
});

// The invariant behind the three cases above, asserted directly rather than shape by shape.
// A missed widening is only visible as "this field claims to be nullable and cannot be null",
// which is exactly what `permitsNull` answers.
test("every field the strictifier made required is one the model can still decline", () => {
  const schema = z.object({
    lit: z.literal("access").optional(),
    en: z.enum(["a", "b"]).optional(),
    str: z.string().optional(),
    num: z.number().optional(),
    arr: z.array(z.string()).default([]),
    obj: z.object({ deep: z.string() }).optional(),
    bool: z.boolean().default(false),
    already: z.number().nullable().default(null),
    union: z.union([z.string(), z.number()]).optional(),
  });
  const rendered = providerJsonSchema(schema);
  assertStrictJsonSchema(rendered, "every optional kind");
  for (const name of Object.keys((rendered.properties as Record<string, unknown>) ?? {})) {
    assert.ok(
      permitsNull(at(rendered, name)),
      `${name} was made required, so null must be a value it can actually take`,
    );
  }
  // And required fields are left strictly alone.
  const withRequired = providerJsonSchema(z.object({ r: z.literal("x"), o: z.string().optional() }));
  assert.equal(permitsNull(at(withRequired, "r")), false, "a required literal is not widened");
  assert.equal(at(withRequired, "r").const, "x", "and keeps its const");
});

test("a field that declared its own nullability is not widened twice", () => {
  const rendered = providerJsonSchema(
    z.object({ line: z.number().int().positive().nullable().default(null) }),
  );
  const line = at(rendered, "line");
  assert.deepEqual(rendered.required, ["line"]);
  assert.equal((line.anyOf as unknown[]).length, 2, "no redundant second null branch");
  assert.ok(permitsNull(line));
});

test("a default annotation survives, because the provider accepts it", () => {
  // Measured against Codex 0.145.0: a schema with every key required plus a `default` is
  // accepted. Defaults are the clearest way to tell the model what declining costs, so they
  // stay - the missing `required` was always the whole blocker.
  const rendered = providerJsonSchema(z.object({ n: z.number().default(0.5) }));
  const n = at(rendered, "n");
  assert.equal(n.default, 0.5);
  assert.deepEqual(n.type, ["number", "null"]);
});

test("strictification is idempotent", () => {
  const schema = z.object({ a: z.string().optional(), b: z.object({ c: z.string().optional() }) });
  const once = providerJsonSchema(schema);
  assert.deepEqual(providerJsonSchema(schema), once);
  assert.deepEqual(JSON.parse(JSON.stringify(once)), once, "the render must stay JSON-clean");
});

test("nullAsAbsent maps null to the declared default without widening the output type", () => {
  const schema = z.object({ xs: nullAsAbsent(z.array(z.string()).default([])) });
  assert.deepEqual(schema.parse({ xs: null }).xs, []);
  assert.deepEqual(schema.parse({}).xs, [], "an omitted key still means the same thing");
  assert.deepEqual(schema.parse({ xs: ["a"] }).xs, ["a"]);
  // The rendered shape is the inner schema's, so the strictifier still sees it as optional
  // and is the only thing that adds null to the wire.
  const rendered = providerJsonSchema(schema);
  assert.deepEqual(at(rendered, "xs").type, ["array", "null"]);
});

// ---------------------------------------------------------------------------
// The list above is the whole list.
// ---------------------------------------------------------------------------

test("every providerJsonSchema call site in src/ is covered by this file", () => {
  const covered = new Set<string>(SCHEMAS.map((s) => s.identifier));
  const found = new Map<string, string>();
  for (const file of walkTs(join(import.meta.dirname, "..", "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/providerJsonSchema\(\s*([A-Za-z0-9_$]+)\s*\)/g)) {
      found.set(m[1]!, file);
    }
  }
  assert.ok(found.size > 0, "the scan found no call sites at all, so it is not scanning src/");
  for (const [identifier, file] of found) {
    assert.ok(
      covered.has(identifier),
      `${identifier} (${file}) reaches a provider unchecked. Add it to SCHEMAS in this file - ` +
        `an unlisted schema is exactly how four of the five original failures stayed latent.`,
    );
  }
});

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield full;
  }
}
