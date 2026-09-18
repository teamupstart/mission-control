/** Telemetry can describe missing or unsupported values without widening operational enums. */
export type AttributionValue<T extends string> = T | "unknown" | "unsupported";

/** Preserve explicit capability evidence; an unfamiliar value alone establishes only unknown. */
export function attributionValue<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
): AttributionValue<T> {
  if (value === "unsupported") return "unsupported";
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? value as T
    : "unknown";
}
