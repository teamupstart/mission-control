import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Inherits the real `compilerOptions` so a future strictness flag reaches the
 * probes too, but re-declares `baseUrl`/`paths` deliberately: inherited paths
 * resolve against the config that declared them, which would send `@shared/*`
 * back to the real `src` and typecheck the unpatched tree - every probe would
 * pass vacuously. Re-declaring both re-roots resolution at the copy. `include`
 * narrows to `src` because the copy has no `test`/`vite.config.ts`.
 */
const PROBE_TSCONFIG = {
  extends: path.join(REPO, "tsconfig.json"),
  compilerOptions: {
    baseUrl: ".",
    paths: { "@shared/*": ["src/shared/*"] },
  },
  include: ["src"],
};

/**
 * Typecheck a throwaway copy of `src` with `patch` applied. A copy rather than the
 * real tree because these probes deliberately introduce compile errors, and the
 * test runner runs files in parallel - mutating the checkout under a sibling test
 * would be its own silent-wrong-answer bug. `node_modules` is symlinked, so
 * resolution finds the real dependencies without copying them.
 */
export function typecheckWithPatch(patch: ((dir: string) => void) | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-contract-probe-"));
  try {
    cpSync(path.join(REPO, "src"), path.join(dir, "src"), { recursive: true });
    // Setup reuses the standalone installer's durable-checkout preflight.
    cpSync(path.join(REPO, "hooks"), path.join(dir, "hooks"), { recursive: true });
    // App code also imports plain-Node installer policy from scripts/.
    cpSync(path.join(REPO, "scripts"), path.join(dir, "scripts"), { recursive: true });
    symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(PROBE_TSCONFIG));
    patch?.(dir);
    try {
      execFileSync(path.join(REPO, "node_modules/.bin/tsc"), ["--noEmit", "-p", dir], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return "";
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Apply a one-shot string edit, failing loudly if the anchor has drifted. */
export function edit(dir: string, rel: string, from: string, to: string): void {
  const file = path.join(dir, rel);
  const src = readFileSync(file, "utf8");
  assert.ok(src.includes(from), `probe anchor no longer present in ${rel}: ${from}`);
  writeFileSync(file, src.replace(from, to));
}
