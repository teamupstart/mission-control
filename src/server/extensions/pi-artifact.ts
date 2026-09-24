import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PI_INTEGRATION_PROTOCOL = 1;
export const PI_INTEGRATION_FILES = ["extension.js", "mcp-server.mjs", "manifest.json"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PiIntegrationManifestSchema = z.object({
  protocol: z.literal(PI_INTEGRATION_PROTOCOL),
  buildId: hash,
  artifacts: z.object({ "extension.js": hash, "mcp-server.mjs": hash }).strict(),
}).strict();
export type PiIntegrationManifest = z.infer<typeof PiIntegrationManifestSchema>;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Fixed artifact names/order and protocol form the location-independent identity. */
export function piIntegrationManifest(extension: Uint8Array, bridge: Uint8Array): PiIntegrationManifest {
  const artifacts = { "extension.js": sha256(extension), "mcp-server.mjs": sha256(bridge) };
  return { protocol: PI_INTEGRATION_PROTOCOL, buildId: sha256(JSON.stringify([PI_INTEGRATION_PROTOCOL, artifacts])), artifacts };
}

/** Refuse links and unexpected schemas before executing anything from a generation. */
export function verifyPiIntegration(dir: string): PiIntegrationManifest {
  for (const name of PI_INTEGRATION_FILES) {
    if (!lstatSync(join(dir, name)).isFile()) throw new Error(`Pi integration ${name} is not a regular file`);
  }
  const manifest = PiIntegrationManifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const actual = piIntegrationManifest(readFileSync(join(dir, "extension.js")), readFileSync(join(dir, "mcp-server.mjs")));
  if (manifest.buildId !== actual.buildId || Object.keys(actual.artifacts).some(name =>
    actual.artifacts[name as keyof typeof actual.artifacts] !== manifest.artifacts[name as keyof typeof actual.artifacts])) {
    throw new Error("Pi integration manifest hashes do not match its artifacts");
  }
  return manifest;
}
