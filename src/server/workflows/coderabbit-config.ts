import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments, visit } from "yaml";
import type { CodeRabbitConfigSnapshot } from "@shared/workflow.ts";

export const CODERABBIT_YAML_MAX_BYTES = 64 * 1024;

/** Local explicit boolean authority. No remote inheritance or vendor defaults. */
export function parseCodeRabbitConfig(bytes: Buffer): CodeRabbitConfigSnapshot {
  const snapshot: CodeRabbitConfigSnapshot = {
    source: ".coderabbit.yaml", digest: createHash("sha256").update(bytes).digest("hex"),
    enabled: false, state: "invalid", diagnostic: "Invalid CodeRabbit YAML configuration",
  };
  if (bytes.length > CODERABBIT_YAML_MAX_BYTES) {
    return { ...snapshot, diagnostic: "CodeRabbit YAML exceeds the 64 KiB source limit" };
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const docs = parseAllDocuments(source, { uniqueKeys: true, schema: "core" });
    if (docs.length !== 1 || docs[0]!.errors.length || docs[0]!.warnings.length) return snapshot;
    let unsupported = false;
    visit(docs[0]!, { Node(_key, node) {
      // Do not expand aliases or accept tags/merge keys that can obscure local authority.
      if (node.tag || "source" in node && !('value' in node)) unsupported = true;
    } });
    if (unsupported) return snapshot;
    const value = docs[0]!.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
    const reviews = value?.reviews as Record<string, unknown> | undefined;
    const auto = reviews?.auto_review as Record<string, unknown> | undefined;
    const enabled = auto?.enabled === true;
    return { ...snapshot, enabled, state: enabled ? "enabled" : "disabled",
      diagnostic: enabled ? "Root YAML explicitly enables CodeRabbit" : "Root YAML does not explicitly enable CodeRabbit with boolean true" };
  } catch { return snapshot; }
}

/** Called by submission capture and its stable-boundary check, never by retries. */
export function captureCodeRabbitConfig(checkoutRoot: string | null): CodeRabbitConfigSnapshot {
  const base: CodeRabbitConfigSnapshot = { source: ".coderabbit.yaml", digest: null,
    enabled: false, state: "unreadable", diagnostic: "CodeRabbit YAML could not be read safely" };
  if (!checkoutRoot) return base;
  let fd: number | undefined;
  try {
    const root = realpathSync(checkoutRoot);
    fd = openSync(join(root, ".coderabbit.yaml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return base;
    if (stat.size > CODERABBIT_YAML_MAX_BYTES) return { ...base, state: "invalid", diagnostic: "CodeRabbit YAML exceeds the 64 KiB source limit" };
    const bytes = Buffer.alloc(CODERABBIT_YAML_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    return parseCodeRabbitConfig(bytes.subarray(0, size));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ...base, state: "missing", diagnostic: "Root .coderabbit.yaml is missing" } : base;
  } finally { if (fd !== undefined) closeSync(fd); }
}
