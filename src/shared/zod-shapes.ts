import { z } from "zod";

/**
 * Two schema shapes Zod 4 does not offer directly, kept in one place so no caller grows its own.
 */

/**
 * `z.record`, refused before a single entry is parsed when it holds more than `maxEntries`.
 *
 * A record has no `.max()`. A bound written as a refinement runs AFTER every entry has been
 * parsed - one issue recorded per bad entry - which is the cost GHSA-mrhx-c7xc-m3w5 is about:
 * an oversized object of garbage is refused only once all of it has been examined. Counting
 * the keys first and stopping the pipe there makes an oversized record ONE `too_big` issue,
 * the way Zod 4.6.6 treats an array, set or map that carries a `.max()`.
 *
 * A pipe from a counting transform into the record, which is what `z.preprocess` builds, and
 * typed as exactly that: its OUTPUT is the record's and so is its INPUT, so a field declared
 * with it infers as `z.record` would, while nothing claims record-only accessors (`keyType`,
 * `valueType`) the pipe does not have. Not a pipe from `z.unknown()`: a provider or MCP client
 * rendering this schema for input sees the record itself, not an unconstrained value.
 */
export function boundedRecord<Key extends z.core.$ZodRecordKey, Value extends z.core.SomeType>(
  key: Key,
  value: Value,
  maxEntries: number,
  message = `Too big: expected object to have <=${maxEntries} entries`,
): BoundedRecord<Key, Value> {
  type RecordInput = z.input<z.ZodRecord<Key, Value>>;
  // `z.transform` types its output as `Awaited<...>`, which a generic cannot reduce; a record's
  // input is never a promise, so the transform is exactly input-to-same-input.
  const countEntries = z.transform<RecordInput>((input, ctx) => {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      if (Object.keys(input).length > maxEntries) {
        ctx.addIssue({ code: "too_big", origin: "object", maximum: maxEntries, inclusive: true, input, message });
      }
    }
    return input;
  }) as z.ZodTransform<RecordInput, RecordInput>;
  return z
    .pipe(countEntries, z.record(key, value))
    // Declared, not just enforced: JSON Schema renders it as `maxProperties`, so an MCP client
    // or provider reading the input schema sees the same ceiling the parse applies.
    .meta({ maxProperties: maxEntries });
}

/** What `boundedRecord` returns: the entry count, then the record. */
export type BoundedRecord<Key extends z.core.$ZodRecordKey, Value extends z.core.SomeType> = z.ZodPipe<
  z.ZodTransform<z.input<z.ZodRecord<Key, Value>>, z.input<z.ZodRecord<Key, Value>>>,
  z.ZodRecord<Key, Value>
>;

/** The entry bound `boundedRecord` declared on this schema, or null when it declared none. */
export function recordEntryBound(schema: z.core.$ZodType): number | null {
  const bound = z.globalRegistry.get(schema)?.maxProperties;
  return typeof bound === "number" ? bound : null;
}

/**
 * What a schema reads as once its own `.default()` / `.prefault()` is taken off, keeping every
 * other wrapper (`.catch()`, `.nullable()`, a transform) as it was.
 */
type WrapperDef = z.core.$ZodTypeDef & { innerType?: z.core.$ZodType; in?: z.core.$ZodType };

function withoutDefault(schema: z.core.$ZodType): z.core.$ZodType {
  const def = schema._zod.def as WrapperDef;
  if (def.type === "default" || def.type === "prefault") return def.innerType!;
  const rewrap = (next: WrapperDef) => z.core.clone(schema, next as typeof schema._zod.def);
  if (def.innerType) return rewrap({ ...def, innerType: withoutDefault(def.innerType) });
  if (def.type === "pipe" && def.in) return rewrap({ ...def, in: withoutDefault(def.in) });
  return schema;
}

/**
 * `.partial()` for a PATCH: a key the caller left out stays out.
 *
 * Zod 4's `.optional()` substitutes an inner `.default()` for absence, so the plain `.partial()`
 * of a stored config schema hands back every default the caller did not send - and a patch
 * merged over the stored record would then reset every one of those settings. Zod 3's
 * `.partial()` left an absent key absent, which is what a patch means; this restores exactly
 * that, and only for the keys whose schema carries a default. The type is `.partial()`'s own.
 *
 * Shallow, as `.partial()` is: a nested object that IS sent still fills its own defaults.
 */
export function partialPatch<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
) {
  const partial = schema.partial();
  const absentStaysAbsent: Record<string, z.core.SomeType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field._zod.optin === "defaulted") absentStaysAbsent[key] = z.optional(withoutDefault(field));
  }
  return partial.extend(absentStaysAbsent) as unknown as typeof partial;
}
