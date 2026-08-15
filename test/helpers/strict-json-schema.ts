import assert from "node:assert/strict";

/**
 * The strict Structured Outputs contract, checked recursively over a RENDERED schema.
 *
 * This exists because the rule that broke the Inspector is not one a reader spots by eye.
 * `zodToJsonSchema` renders a `.optional()` or `.default()` property by leaving it out of
 * `required`, which is correct JSON Schema and which the strict provider rejects with
 * `invalid_json_schema`: "required is required to be supplied and to be an array including
 * every key in properties". The rejection fails the CALL, so a schema that violates this at
 * any depth takes its whole feature down rather than degrading.
 *
 * Recursive, and deliberately not just a root check. Four of the five schemas that shipped
 * broken were broken at the root, but `InspectorVerdictSchema` was ALSO broken one level
 * down (`findings[].line`), and a root-only assertion would have called it fixed.
 */

interface Ctx {
  /** Human-readable JSON-Pointer-ish trail, so a failure names the offending sub-schema. */
  path: string;
  label: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Assert a rendered JSON Schema satisfies strict Structured Outputs at every depth.
 *
 * Three rules, each one a way the provider says no:
 *  1. every object with `properties` lists EVERY key of `properties` in `required`;
 *  2. every such object sets `additionalProperties: false`;
 *  3. the root is an object, because that is the only root shape strict mode accepts.
 */
export function assertStrictJsonSchema(schema: unknown, label: string): void {
  assert.ok(isObj(schema), `${label}: root must be a schema object`);
  assert.equal(schema.type, "object", `${label}: strict mode requires an object at the root`);
  assert.ok(
    isObj(schema.properties),
    `${label}: root must declare properties, or there is nothing for the model to fill`,
  );
  walk(schema, { path: "#", label });
}

function walk(node: unknown, ctx: Ctx): void {
  if (!isObj(node)) return;
  const where = `${ctx.label} at ${ctx.path}`;

  // Checked BEFORE the `properties` block and independently of it. An open map declared as a
  // schema here - `z.record()`, or a `.catchall()` object - is a shape strict mode will not
  // take, and a record carries no `properties` at all, so folding this into the block below
  // would let exactly that case through unexamined.
  assert.equal(
    isObj(node.additionalProperties),
    false,
    `${where}: strict mode has no way to express an open map; additionalProperties must be false`,
  );

  const properties = node.properties;
  if (isObj(properties)) {
    const keys = Object.keys(properties);
    const required = node.required;
    assert.ok(Array.isArray(required), `${where}: object schema must carry a required array`);
    assert.deepEqual(
      [...(required as string[])].sort(),
      [...keys].sort(),
      `${where}: required must list exactly every key of properties`,
    );
    assert.equal(
      node.additionalProperties,
      false,
      `${where}: strict mode requires additionalProperties:false`,
    );
    for (const [name, sub] of Object.entries(properties)) {
      walk(sub, { ...ctx, path: `${ctx.path}/properties/${name}` });
    }
  }

  if (Array.isArray(node.items)) {
    node.items.forEach((sub, i) => walk(sub, { ...ctx, path: `${ctx.path}/items/${i}` }));
  } else if ("items" in node) {
    walk(node.items, { ...ctx, path: `${ctx.path}/items` });
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      branches.forEach((sub, i) => walk(sub, { ...ctx, path: `${ctx.path}/${key}/${i}` }));
    }
  }
  for (const key of ["not", "if", "then", "else", "propertyNames", "contains"] as const) {
    if (key in node) walk(node[key], { ...ctx, path: `${ctx.path}/${key}` });
  }
  if (isObj(node.additionalProperties)) {
    walk(node.additionalProperties, { ...ctx, path: `${ctx.path}/additionalProperties` });
  }
}

/**
 * Does this rendered sub-schema accept `null`?
 *
 * Deliberately a second implementation rather than an import of the renderer's own
 * predicate. A test that asked the code under test whether it did the right thing would
 * assert only that it agrees with itself; this states the JSON Schema reading independently,
 * so the two have to meet in the middle.
 */
export function permitsNull(schema: unknown): boolean {
  if (!isObj(schema)) return false;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if ("const" in schema) return schema.const === null;
  const type = schema.type;
  if (type === "null") return true;
  if (Array.isArray(type)) return type.includes("null");
  if (typeof type === "string") return false;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) return branches.some(permitsNull);
  }
  if ("allOf" in schema || "$ref" in schema || "not" in schema) return false;
  return true;
}

/**
 * Build the payload a strict provider sends when it declines every optional field.
 *
 * Derived from the RENDERED schema rather than hand-written, which is what makes the
 * companion assertion self-maintaining: a newly added optional field appears in this
 * payload automatically, so the test notices when its Zod side cannot read the `null` the
 * wire schema now permits. `required` covers every key by then, so "optional" is read off
 * nullability - the only place semantic absence still lives.
 *
 * Non-nullable properties get a minimal in-shape value, because the point of the payload is
 * to isolate the nulls: a parse that failed on a missing mandatory field would prove
 * nothing about them.
 */
export function nullOptionalsPayload(schema: unknown): unknown {
  if (!isObj(schema)) return null;
  const properties = schema.properties;
  if (!isObj(properties)) return sampleFor(schema);
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(properties)) {
    out[name] = permitsNull(sub) ? null : sampleFor(sub);
  }
  return out;
}

/** A minimal value satisfying a rendered sub-schema's own constraints. */
function sampleFor(schema: unknown): unknown {
  if (!isObj(schema)) return null;
  if (Array.isArray(schema.enum)) return schema.enum.find((v) => v !== null) ?? null;
  if ("const" in schema) return schema.const;

  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    const usable = branches.find((b) => isObj(b) && b.type !== "null");
    return sampleFor(usable ?? branches[0]);
  }

  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  switch (type) {
    case "object":
      return nullOptionalsPayload(schema);
    case "array": {
      // Honour minItems, so a schema demanding two subjects gets two.
      const min = typeof schema.minItems === "number" ? schema.minItems : 0;
      const item = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      return Array.from({ length: min }, () => sampleFor(item));
    }
    case "string":
      return "x";
    case "integer":
    case "number": {
      const lo = typeof schema.minimum === "number" ? schema.minimum : 0;
      const hi = typeof schema.maximum === "number" ? schema.maximum : lo + 1;
      return Math.min(Math.max(0, lo), hi);
    }
    case "boolean":
      return false;
    default:
      return null;
  }
}
