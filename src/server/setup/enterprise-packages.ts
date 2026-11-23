import { z } from "zod";
import defaults from "../../../config/enterprise-packages.json" with { type: "json" };
import type { RecommendedPackageView } from "@shared/enterprise-packages.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import type { EnvironmentDeps } from "../environment/types.ts";
import { piExtensionStatus, npmNamePattern, npmVersionPattern } from "./pi-package.ts";

const pin = new RegExp(`^npm:(${npmNamePattern})@(${npmVersionPattern})$`);
const text = (max: number) => z.string().trim().min(1).max(max);
const Guide = z.strictObject({
  harness: z.enum(AGENT_TYPES),
  label: text(100),
  description: text(500),
  source: text(300),
  guide: z.url({ protocol: /^https$/ }).max(2048),
});
const PiExtension = Guide.extend({
  harness: z.literal("pi"),
  source: text(300).transform((source, ctx) => {
    const match = pin.exec(source);
    if (match) return { source, name: match[1]!, version: match[2]! };
    ctx.addIssue({ code: "custom", message: "Expected an exact npm package pin" });
    return z.NEVER;
  }),
  piExtension: z.strictObject({
    entry: text(256).regex(/^[a-zA-Z0-9_-][\w.-]*(?:\/[a-zA-Z0-9_-][\w.-]*)*$/),
    conflicts: z.array(text(214).regex(new RegExp(`^${npmNamePattern}$`))).max(16).default([]),
  }),
});
const Catalog = z.strictObject({
  packages: z.array(z.union([PiExtension, Guide])).max(64),
}).refine(({ packages }) => {
  const keys = packages.map((item) => {
    const source = "piExtension" in item ? item.source.source : item.source;
    return JSON.stringify([item.harness, source]);
  });
  return new Set(keys).size === keys.length;
}, "Duplicate package source for a harness");

interface PackageCatalogView {
  byHarness: Partial<Record<AgentType, RecommendedPackageView[]>>;
  error?: string;
}

/** A missing override selects the bundled catalog. An invalid override must never select another organization's defaults. */
export async function readEnterprisePackages(
  deps: EnvironmentDeps, catalogPath: string, piAgentDir?: string,
): Promise<PackageCatalogView> {
  const read = await deps.readText(catalogPath);
  if (read.ok ? read.truncated : !read.missing) {
    return { byHarness: {}, error: `Cannot read the complete package catalog at ${catalogPath}.` };
  }
  let raw: unknown = defaults;
  if (read.ok) {
    try { raw = JSON.parse(read.text.replace(/^\uFEFF/, "")); }
    catch { return { byHarness: {}, error: `Invalid JSON in ${catalogPath}.` }; }
  }
  const parsed = Catalog.safeParse(raw);
  if (!parsed.success) {
    return { byHarness: {}, error: `Invalid package catalog at ${catalogPath}. Check the package fields and guide URLs.` };
  }
  const byHarness: PackageCatalogView["byHarness"] = {};
  for (const item of parsed.data.packages) {
    const { label, description, guide } = item;
    const group = byHarness[item.harness] ??= [];
    if ("piExtension" in item) {
      const status = await piExtensionStatus(deps, { ...item.source, ...item.piExtension }, piAgentDir);
      group.push({ label, description, guide, source: item.source.source, status });
    } else {
      group.push({ label, description, guide, source: item.source });
    }
  }
  return { byHarness };
}
