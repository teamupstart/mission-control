import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { boundedRecord, partialPatch, recordEntryBound } from "../src/shared/zod-shapes.ts";
import {
  AwayConfigPatchSchema,
  AwayConfigSchema,
  CostConfigPatchSchema,
  CostConfigSchema,
  ForemanConfigPatchSchema,
  ForemanConfigSchema,
  InspectorConfigPatchSchema,
  InspectorConfigSchema,
  ShippingConfigPatchSchema,
  ShippingConfigSchema,
  SkillsConfigPatchSchema,
  SkillsConfigSchema,
  UiConfigPatchSchema,
  UiConfigSchema,
} from "../src/shared/protocol.ts";
import { RepoIndexConfigPatchSchema, RepoIndexConfigSchema } from "../src/shared/repo-index.ts";

test("a bounded record refuses an oversized object as one issue, before any entry is parsed", () => {
  const schema = z.object({ m: boundedRecord(z.string(), z.number(), 3) });
  const oversized = schema.safeParse({ m: Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`k${i}`, "not a number"])) });
  assert.equal(oversized.success, false);
  assert.deepEqual(
    oversized.error!.issues.map((issue) => [issue.code, issue.path.join(".")]),
    [["too_big", "m"]],
    "one issue for the size - not one per bad entry",
  );
  assert.deepEqual(schema.parse({ m: { a: 1, b: 2, c: 3 } }), { m: { a: 1, b: 2, c: 3 } });
  // Within the bound it is an ordinary record.
  assert.equal(schema.safeParse({ m: { a: "x" } }).success, false);
  assert.equal(schema.safeParse({ m: [] }).success, false);
});

test("a bounded record declares its bound, and JSON Schema renders it", () => {
  const record = boundedRecord(z.string(), z.boolean(), 7, "too many");
  assert.equal(recordEntryBound(record), 7);
  assert.equal(recordEntryBound(z.record(z.string(), z.boolean())), null);
  const rendered = z.toJSONSchema(record, { io: "input" }) as Record<string, unknown>;
  assert.equal(rendered.maxProperties, 7);
  assert.deepEqual(rendered.additionalProperties, { type: "boolean" });
  assert.equal(record.safeParse(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${i}`, true]))).error?.issues[0]?.message, "too many");
});

test("a bounded record is typed as the pipe it is, and infers as the record it wraps", () => {
  const record = boundedRecord(z.string(), z.number(), 3);
  assert.ok(record instanceof z.ZodPipe, "a count, then the record");
  assert.equal(record.out._zod.def.type, "record");
  assert.equal("keyType" in record, false);
  // @ts-expect-error - a record-only accessor the pipe does not have is not offered either.
  void record.keyType;
  const input: z.input<typeof record> = { a: 1 };
  const output: z.output<typeof record> = record.parse(input);
  assert.deepEqual(output, { a: 1 });
});

test("a partial patch leaves an absent key absent, where a plain partial now fills its default", () => {
  const base = z.object({
    a: z.string().default("x"),
    b: z.number(),
    c: z.object({ d: z.boolean().default(true) }).prefault({}),
    e: z.string().default("q").catch("q"),
  });
  // The Zod 4 behaviour this exists for: `.partial()` hands back defaults nobody sent.
  assert.deepEqual(base.partial().parse({}), { a: "x", c: { d: true }, e: "q" });
  const patch = partialPatch(base);
  assert.deepEqual(patch.parse({}), {});
  assert.deepEqual(patch.parse({ b: 2 }), { b: 2 });
  // A key that IS sent still reads as the stored schema reads it.
  assert.deepEqual(patch.parse({ c: {} }), { c: { d: true } }, "a sent nested object fills its own defaults");
  assert.deepEqual(patch.parse({ e: 5 }), { e: "q" }, "the catch is kept");
  assert.equal(patch.safeParse({ a: 5 }).success, false);
});

/**
 * Every stored config with a dashboard PATCH, paired. A patch that named one setting must come
 * back naming only that setting: merged over the stored record, any other key it carried would
 * reset the operator's choice to the shipped default.
 */
const PATCHES = [
  ["ForemanConfig", ForemanConfigSchema, ForemanConfigPatchSchema],
  ["AwayConfig", AwayConfigSchema, AwayConfigPatchSchema],
  ["SkillsConfig", SkillsConfigSchema, SkillsConfigPatchSchema],
  ["InspectorConfig", InspectorConfigSchema, InspectorConfigPatchSchema],
  ["ShippingConfig", ShippingConfigSchema, ShippingConfigPatchSchema],
  ["UiConfig", UiConfigSchema, UiConfigPatchSchema],
  ["CostConfig", CostConfigSchema, CostConfigPatchSchema],
  ["RepoIndexConfig", RepoIndexConfigSchema, RepoIndexConfigPatchSchema],
] as const;

for (const [name, stored, patch] of PATCHES) {
  test(`the ${name} patch naming one setting carries only that setting`, () => {
    const defaults = stored.parse({}) as Record<string, unknown>;
    const patchKeys = new Set(Object.keys((patch as unknown as { shape?: object }).shape ?? stored.shape));
    let checked = 0;
    for (const key of Object.keys(stored.shape)) {
      // A field the patch does not offer, or one that the patch rewrites into another key.
      if (!patchKeys.has(key) || defaults[key] === undefined || key === "lineDensity") continue;
      const parsed = patch.safeParse({ [key]: defaults[key] });
      if (!parsed.success) continue;
      assert.deepEqual(Object.keys(parsed.data as object), [key], `${name}: patching ${key} carried other keys`);
      checked++;
    }
    assert.ok(checked > 0, `${name}: no setting was checked`);
  });
}
