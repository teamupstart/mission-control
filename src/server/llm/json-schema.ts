import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Render the provider-facing INPUT schema once in the caller's module.
 *
 * The return type deliberately loses the Zod schema. `LlmRunOptions` is a transport
 * contract, and later transports must be able to consume the rendered JSON Schema
 * without importing Zod or deciding how references should be represented.
 *
 * Everything rendered here is then made STRICT, because one of those transports already
 * rejects the un-strict form outright. See `strictify` for what that means and why the
 * rendering alone was not enough.
 */
export function providerJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const rendered = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  return strictify(rendered) as Record<string, unknown>;
}

/**
 * Read the `null` a strict provider sends where this codebase means "absent".
 *
 * The other half of `strictify`. A field this repo declared `.optional()` or `.default()`
 * leaves here as a nullable REQUIRED property, so the model can no longer express absence
 * by omitting the key - it expresses it by sending `null`. Zod's `.optional()` and
 * `.default()` both reject `null`, so without this the schema fix would trade a provider
 * error for a parse miss, which is the worse failure: `invalid_json_schema` is loud and
 * immediate, while a parse miss burns the retry and then degrades quietly (a dropped
 * Inspector verdict, a Foreman route-up billed as `tier1-unparseable`).
 *
 * Wrapping rather than widening is deliberate. `.nullable()` would push `null` into the
 * OUTPUT type and hand every reader a second empty value to handle; mapping it back to
 * `undefined` in front of the existing declaration means the default still fires, the
 * transforms still run, and `z.infer` is unchanged. Absence and `null` therefore mean the
 * same thing on the way in, which is exactly the claim `strictify` makes on the way out.
 *
 * It does NOT apply to a field where `null` is already meaningful and declared - see
 * `InspectorVerdictSchema.findings[].line`, which is `.nullable()` because "about the file,
 * not a line" is a real answer. `strictify` leaves such a field alone, and so does this.
 */
export function nullAsAbsent<S extends ZodTypeAny>(schema: S) {
  return z.preprocess((v) => (v === null ? undefined : v), schema);
}

const NULL_BRANCH = { type: "null" } as const;

function isSchemaObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Sub-schema positions that hold exactly one schema. */
const SCHEMA_VALUED = ["not", "if", "then", "else", "propertyNames", "contains"] as const;
/** Sub-schema positions that hold a list of schemas. */
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf"] as const;

/**
 * Does this rendered schema already accept `null`?
 *
 * Asked before widening anything, so a field that declared its own nullability keeps the
 * exact shape its author wrote instead of collecting a second, redundant null branch.
 */
function permitsNull(schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if ("const" in schema) return schema.const === null;

  const type = schema.type;
  if (type === "null") return true;
  if (Array.isArray(type)) return type.includes("null");
  if (typeof type === "string") return false;

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      return branches.some((b) => isSchemaObject(b) && permitsNull(b));
    }
  }
  // `allOf` narrows and `$ref` is opaque, so neither can be read as permitting null.
  if ("allOf" in schema || "$ref" in schema || "not" in schema) return false;
  // Nothing constrains the instance at all, so `null` is already a legal value.
  return true;
}

/**
 * Widen a rendered schema to accept `null`, in whichever way its shape allows.
 *
 * `type` gains a `"null"` member wherever there is one to extend, because that is the form
 * the strict provider documents. That alone is never enough when a VALUE constraint sits
 * beside it, and both of the ones rendered here have to move too:
 *
 *  - an `enum` gains a literal `null`, because `"type": ["string","null"]` next to
 *    `"enum": ["escalate","skip"]` reads as nullable and is not - `enum` still rejects null;
 *  - a `const` (what `z.literal()` renders) becomes the two-value `enum` it already is.
 *    Widening `type` and leaving `const` pinned produces a field NO value satisfies: null is
 *    legal by type and illegal by const, so a field marked nullable could never be declined.
 *
 * The final wrap covers the shapes with no `type` to extend (`allOf`, `$ref`), hoisting the
 * annotations that describe the property rather than the branch.
 */
function withNull(schema: Record<string, unknown>): Record<string, unknown> {
  if (permitsNull(schema)) return schema;

  const out = { ...schema };
  const hasConst = "const" in out;
  const hasEnum = Array.isArray(out.enum);

  // Both at once is an intersection no renderer here produces, and picking a winner would be
  // guessing. The wrap below is the one reading that stays correct without deciding.
  if (!(hasConst && hasEnum)) {
    let widened = false;
    if (hasConst) {
      out.enum = [out.const, null];
      delete out.const;
      widened = true;
    } else if (hasEnum) {
      out.enum = [...(out.enum as unknown[]), null];
      widened = true;
    }
    const type = out.type;
    if (typeof type === "string") {
      out.type = [type, "null"];
      widened = true;
    } else if (Array.isArray(type)) {
      out.type = [...type, "null"];
      widened = true;
    }
    if (widened) return out;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = out[key];
    if (Array.isArray(branches)) return { ...out, [key]: [...branches, NULL_BRANCH] };
  }

  const { default: dflt, description, ...rest } = out;
  const wrapped: Record<string, unknown> = { anyOf: [rest, NULL_BRANCH] };
  if (dflt !== undefined) wrapped.default = dflt;
  if (description !== undefined) wrapped.description = description;
  return wrapped;
}

/**
 * Make a rendered JSON Schema satisfy strict Structured Outputs, at every depth.
 *
 * `zodToJsonSchema` renders a `.optional()` or `.default()` property by leaving it out of
 * `required`, which is the ordinary JSON Schema reading and which the strict provider
 * refuses outright: it wants every key of `properties` listed in `required`, and answers a
 * schema that omits one with `invalid_json_schema` ("required is required to be supplied
 * and to be an array including every key in properties"). That is not a warning. It fails
 * the CALL, so the feature does not degrade, it stops - which is what the Inspector did on
 * every open pull request once `codex exec --output-schema` started carrying these.
 *
 * Listing the key is only half an answer, though. A property that is required and not
 * nullable is one the model must invent a value for, and an invented `reason` or `brief` is
 * worse than an absent one. So semantic optionality moves into the type: a property that
 * was not in `required` becomes required AND nullable, and `nullAsAbsent` reads the `null`
 * back as absence on the way in. Nothing here is made mandatory in the sense that matters -
 * the model can still decline every field it could decline before.
 *
 * Doing this centrally rather than per call site is the point. The bug arrived at five
 * schemas at once from a single rendering helper, and only two of them were being exercised
 * on the affected provider, so four failed silently or latently. A call site cannot opt out
 * of the transport's contract, so it should not have to opt in to satisfying it.
 *
 * Idempotent by construction: a schema that already lists every key and declares its own
 * nullability - `CompactionSchema`, and the three ensemble review schemas - comes back
 * unchanged, which is how the tests use them as controls.
 */
function strictify(node: unknown): unknown {
  if (!isSchemaObject(node)) return node;
  const out: Record<string, unknown> = { ...node };

  for (const key of SCHEMA_VALUED) {
    if (key in out) out[key] = strictify(out[key]);
  }
  for (const key of SCHEMA_LISTS) {
    const branches = out[key];
    if (Array.isArray(branches)) out[key] = branches.map(strictify);
  }
  // `items` is a single schema, or a list of them for a tuple.
  if ("items" in out) {
    out.items = Array.isArray(out.items) ? out.items.map(strictify) : strictify(out.items);
  }
  // A DECLARED catchall: `.catchall()` and `z.record()` both render a schema here, where an
  // ordinary object renders `false`. Recurse only in that case - `false` and `true` are
  // values, not sub-schemas.
  const declaredCatchall = isSchemaObject(out.additionalProperties);
  if (declaredCatchall) {
    out.additionalProperties = strictify(out.additionalProperties);
  }

  const properties = out.properties;
  if (!isSchemaObject(properties)) {
    // A `z.record()` renders as an object with no `properties`, and forcing
    // `additionalProperties: false` onto one would leave a map that can hold nothing.
    // Strict mode does not accept that shape anyway, so leave it as the author wrote it
    // and let the contract assertion be the thing that says so.
    return out;
  }

  const wasRequired = new Set(
    Array.isArray(out.required) ? out.required.filter((k): k is string => typeof k === "string") : [],
  );
  const next: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(properties)) {
    const strict = strictify(sub);
    next[name] =
      wasRequired.has(name) || !isSchemaObject(strict) ? strict : withNull(strict);
  }
  out.properties = next;
  out.required = Object.keys(next);
  // `.catchall()` is the same problem as `z.record()` wearing a different shape: it has
  // `properties` AND a schema-valued `additionalProperties`, so it reaches this line where a
  // bare record returns above. Overwriting that schema with `false` would silently delete the
  // author's catchall contract - exactly the rewrite the record guard exists to prevent, just
  // harder to notice. So leave it, and let the contract assertion be what says strict mode
  // will not take this shape. Nothing here uses `.catchall()` today; this is written so the
  // first schema that does fails loudly instead of quietly losing a constraint.
  if (!declaredCatchall) out.additionalProperties = false;
  return out;
}
