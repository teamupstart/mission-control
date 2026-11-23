// The `mod-calls` check (spec 7.10): the Claude Code mod calls the daemon at `/api/health` and
// `/dispatch/*` and nowhere else. `src/mod/allowed-calls.json` is the allowlist; this scans the
// mod's source for any path literal that starts a daemon route and is not on it. Shared by
// `smoke-bundles.mjs` and `test/home-dispatch-mod-core.test.ts`, so there is one definition.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every `.ts` and `.tsx` file under `dir`. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Whether `path` (query stripped) is on the allowlist. */
export function isAllowedModCall(path, allowed) {
  const bare = path.split("?")[0];
  return allowed.exact.includes(bare) || allowed.prefixes.some((prefix) => bare.startsWith(prefix));
}

/** The `{ file, path }` of every daemon path literal under `src/mod` that the allowlist refuses. */
export function findDisallowedModCalls(root) {
  const allowed = JSON.parse(readFileSync(join(root, "src/mod/allowed-calls.json"), "utf8"));
  const found = [];
  for (const file of sourceFiles(join(root, "src/mod"))) {
    const text = readFileSync(file, "utf8");
    // A quoted or template literal that begins with `/api` or `/dispatch`.
    for (const match of text.matchAll(/["'`](\/(?:api|dispatch)[^"'`\s]*)["'`]/g)) {
      const path = match[1];
      if (!isAllowedModCall(path, allowed)) found.push({ file, path });
    }
  }
  return found;
}
