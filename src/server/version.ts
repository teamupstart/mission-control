import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Service version, read once from package.json; "unknown" if unreadable. */
function readServiceVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export const SERVICE_VERSION = readServiceVersion();
