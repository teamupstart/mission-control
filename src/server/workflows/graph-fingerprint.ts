import { createHash } from "node:crypto";
import { PublishedWorkflowGraphSchema } from "@shared/protocol.ts";
import { canonicalJson } from "@shared/shaping.ts";

/** Normalize historical snapshot defaults before comparing publication identity. */
export function workflowGraphFingerprint(graph: unknown): string {
  const normalized = PublishedWorkflowGraphSchema.parse(graph);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
