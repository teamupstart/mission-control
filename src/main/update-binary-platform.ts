import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { BinaryInstallReceipt } from "../shared/install-receipt-schema.mjs";
import { FIXED_OS_EXECUTABLES } from "../server/executables/catalog.ts";

type NativeRead = (command: string, args: string[]) => string;
const nativeRead: NativeRead = (command, args) => execFileSync(command, args, {encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"]}).trim();

export function verifyBinaryPlatform(bundle: string, receipt: BinaryInstallReceipt, run: NativeRead = nativeRead): void {
  const manifest = receipt.provenance.manifest;
  const version = run(FIXED_OS_EXECUTABLES.swVers, ["-productVersion"]);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Cannot determine the installed macOS version.");
  const current = version.split(".").map(Number);
  const required = manifest.minimumSystemVersion.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((current[index] ?? 0) > (required[index] ?? 0)) break;
    if ((current[index] ?? 0) < (required[index] ?? 0)) throw new Error("This binary requires a newer macOS version. Update macOS before retrying.");
  }
  if (run(FIXED_OS_EXECUTABLES.lipo, ["-archs", join(bundle, "Contents/MacOS/Mission Control")]) !== "arm64") throw new Error("The binary app has the wrong architecture.");
  for (const [key, value] of Object.entries({CFBundleIdentifier: manifest.bundleId, LSMinimumSystemVersion: manifest.minimumSystemVersion})) {
    if (run(FIXED_OS_EXECUTABLES.plistBuddy, ["-c", `Print :${key}`, join(bundle, "Contents/Info.plist")]) !== value) throw new Error("The binary app identity or minimum macOS version disagrees with its manifest.");
  }
}
