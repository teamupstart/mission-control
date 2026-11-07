import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments, visit } from "yaml";
import type { CodeRabbitConfigSnapshot } from "@shared/workflow.ts";

export const CODERABBIT_YAML_MAX_BYTES = 64 * 1024;

export const CODERABBIT_YAML = ".coderabbit.yaml";
export const CODERABBIT_CONFIG_TS = ".coderabbit.config.ts";

/**
 * Local enablement. A root .coderabbit.yaml runs the review unless reviews.auto_review.enabled is
 * boolean false; a missing key means CodeRabbit's own default (on). Ambiguous values (strings, tags,
 * aliases, duplicate keys) stay disabled. No remote inheritance is resolved here.
 */
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
    // Empty or comment-only: the file exists and opts out of nothing, so it runs.
    if (docs.length === 0) {
      return { ...snapshot, enabled: true, state: "enabled",
        diagnostic: "Root YAML is empty and does not opt out of CodeRabbit (reviews.auto_review.enabled is not false)" };
    }
    if (docs.length !== 1 || docs[0]!.errors.length || docs[0]!.warnings.length) return snapshot;
    let unsupported = false;
    visit(docs[0]!, { Node(_key, node) {
      // Do not expand aliases or accept tags/merge keys that can obscure local authority.
      if (node.tag || "source" in node && !('value' in node)) unsupported = true;
    } });
    if (unsupported) return snapshot;
    const value = docs[0]!.toJS({ maxAliasCount: 0 }) as unknown;
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) return snapshot;
    const reviews = (value as Record<string, unknown> | null)?.reviews;
    if (reviews !== undefined && reviews !== null && (typeof reviews !== "object" || Array.isArray(reviews))) return snapshot;
    const auto = (reviews as Record<string, unknown> | null | undefined)?.auto_review;
    if (auto !== undefined && auto !== null && (typeof auto !== "object" || Array.isArray(auto))) return snapshot;
    const flag = (auto as Record<string, unknown> | null | undefined)?.enabled;
    if (flag === false) {
      return { ...snapshot, enabled: false, state: "disabled",
        diagnostic: "reviews.auto_review.enabled is false in .coderabbit.yaml; CodeRabbit is opted out (this overrides .coderabbit.config.ts)" };
    }
    if (flag === undefined || flag === null || flag === true) {
      return { ...snapshot, enabled: true, state: "enabled",
        diagnostic: flag === true ? "Root YAML explicitly enables CodeRabbit" : "Root YAML does not opt out of CodeRabbit (reviews.auto_review.enabled is not false)" };
    }
    return snapshot;
  } catch { return snapshot; }
}

type RootRead = { bytes: Buffer } | { code: "ENOENT" } | { code: "unreadable" } | { code: "oversized" };

/** Reads a regular root file without following symlinks; never reads past the source limit. */
function readRootFile(root: string, name: string): RootRead {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { code: "unreadable" };
    if (stat.size > CODERABBIT_YAML_MAX_BYTES) return { code: "oversized" };
    const bytes = Buffer.alloc(CODERABBIT_YAML_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    return { bytes: bytes.subarray(0, size) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { code: "ENOENT" } : { code: "unreadable" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Called by submission capture and its stable-boundary check, never by retries.
 * Precedence: a readable .coderabbit.yaml decides (including an auto_review false opt-out);
 * only when it is absent does a root .coderabbit.config.ts enable the review.
 */
export function captureCodeRabbitConfig(checkoutRoot: string | null): CodeRabbitConfigSnapshot {
  const base: CodeRabbitConfigSnapshot = { source: CODERABBIT_YAML, digest: null,
    enabled: false, state: "unreadable", diagnostic: "CodeRabbit YAML could not be read safely" };
  if (!checkoutRoot) return base;
  let root: string;
  try { root = realpathSync(checkoutRoot); } catch { return base; }
  const yaml = readRootFile(root, CODERABBIT_YAML);
  if ("bytes" in yaml) return parseCodeRabbitConfig(yaml.bytes);
  if (yaml.code === "oversized") return { ...base, state: "invalid", diagnostic: "CodeRabbit YAML exceeds the 64 KiB source limit" };
  if (yaml.code === "unreadable") return base;
  const ts = readRootFile(root, CODERABBIT_CONFIG_TS);
  if ("bytes" in ts) {
    // The file is only detected, never executed or parsed; the digest pins its content.
    return { source: CODERABBIT_CONFIG_TS, enabled: true, state: "enabled",
      digest: createHash("sha256").update(ts.bytes).digest("hex"),
      diagnostic: "Root .coderabbit.config.ts exists; CodeRabbit is enabled" };
  }
  // Too large to hash and compare with the committed file, so it cannot be trusted to enable review.
  if (ts.code === "oversized") return { ...base, source: CODERABBIT_CONFIG_TS, state: "invalid", diagnostic: "CodeRabbit config.ts exceeds the 64 KiB source limit" };
  if (ts.code === "unreadable") return { ...base, source: CODERABBIT_CONFIG_TS, diagnostic: "CodeRabbit config.ts could not be read safely" };
  return { ...base, state: "missing", diagnostic: "Neither root .coderabbit.yaml nor .coderabbit.config.ts exists" };
}
