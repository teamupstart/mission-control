import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Render the provider-facing INPUT schema once in the caller's module.
 *
 * The return type deliberately loses the Zod schema. `LlmRunOptions` is a transport
 * contract, and later transports must be able to consume the rendered JSON Schema
 * without importing Zod or deciding how references should be represented.
 */
export function providerJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
}
