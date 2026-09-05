// What version an app bundle on disk says it is.
//
// A deliberate second copy of `plistVersion`/`bundleShortVersion` from
// `scripts/app-bundle-swap.mjs`, because neither side can import the other and both need it:
//
// - `src/` has to be self-contained. `test/session-contracts.test.ts` copies `src/` alone into
//   a temp directory and typechecks it, so a reach into `scripts/` fails there by design - it
//   would also be a module the packaged main bundle resolves only by accident.
// - `scripts/app-bundle-swap.mjs` may import only `node:` builtins. It is copied beside the
//   detached update helper, outlives the app bundle it came from, and cannot depend on `src/`.
//
// Three lines twice, with the constraint that forces it written down on both sides. If the
// plist key ever changes, both change.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function plistShortVersion(text: string): string | null {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(
    String(text ?? ""),
  );
  return match?.[1]?.trim() || null;
}

/** The bundle's advertised version, or null when it cannot be read at all. */
export function bundleShortVersion(appPath: string): string | null {
  try {
    return plistShortVersion(readFileSync(join(appPath, "Contents", "Info.plist"), "utf8"));
  } catch {
    return null;
  }
}
