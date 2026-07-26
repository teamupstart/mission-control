#!/usr/bin/env node
// Regenerate `src/server/harness/codex/app-server/protocol.ts` from the installed Codex.
//
//   node scripts/codex-app-server-bindings.mjs            # uses `codex` on PATH
//   MISSION_CODEX_BIN=/path/to/codex node scripts/...     # or a pinned build
//
// Run this on a Codex version bump, commit the result, and read the diff: it is the only
// place the app-server protocol is described, so a field that moved shows up here or
// nowhere. The adapter (`harness/codex/sdk.ts`) is its only consumer.
//
// ## Why this script exists rather than `generate-ts --out src/...`
//
// `codex app-server generate-ts` emits the WHOLE protocol - 617 files and 2.5MB against
// codex-cli 0.145.0 - covering the accounts API, the app marketplace, realtime voice,
// Windows sandbox setup and attestation. We speak twenty-odd types of it. Committing all
// of it would make every version bump an unreviewable diff over code nothing imports,
// which is the opposite of what pinned bindings are for: the point is that a human can
// SEE what moved.
//
// So the roots below are declared, the transitive closure of their `import type` graph is
// taken, and the result is concatenated into one module. Nothing is edited on the way
// through - each declaration is the generator's own bytes, doc comments included - so this
// is still generated code, just the part of it we speak. A root whose closure grows is a
// real change in what we depend on, and it shows up as one diff.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The types the adapter speaks, by generated module path.
 *
 * Deliberately NOT `ClientRequest` / `ServerNotification` / `ServerRequest`, which are the
 * generator's own top-level unions: each names every method the app-server has, so taking
 * one as a root drags in the entire surface again. We correlate requests by id and switch
 * on `method` ourselves, so what we actually need typed is the params and result of the
 * dozen calls we make and the handful of notifications we read.
 */
const ROOTS = [
  "RequestId",
  "InitializeParams",
  "InitializeResponse",
  "v2/ThreadStartParams",
  "v2/ThreadStartResponse",
  "v2/ThreadResumeParams",
  "v2/ThreadResumeResponse",
  "v2/TurnStartParams",
  "v2/TurnStartResponse",
  "v2/TurnSteerParams",
  "v2/TurnSteerResponse",
  "v2/TurnInterruptParams",
  "v2/TurnInterruptResponse",
  "v2/ThreadStartedNotification",
  "v2/ThreadStatusChangedNotification",
  "v2/TurnStartedNotification",
  "v2/TurnCompletedNotification",
  "v2/ItemStartedNotification",
  "v2/ItemCompletedNotification",
  "v2/ThreadTokenUsageUpdatedNotification",
  "v2/ErrorNotification",
  "v2/CommandExecutionRequestApprovalParams",
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalParams",
  "v2/FileChangeRequestApprovalResponse",
  "v2/ToolRequestUserInputParams",
  "v2/ToolRequestUserInputResponse",
];

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "src/server/harness/codex/app-server/protocol.ts");
const bin = process.env.MISSION_CODEX_BIN || "codex";

function codex(args) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** `codex-cli 0.145.0` -> `0.145.0`. The stamp a reader checks their own binary against. */
function version() {
  const raw = codex(["--version"]).trim();
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(raw);
  if (!match) throw new Error(`could not read a version out of "${raw}"`);
  return match[1];
}

/** Every module reachable from ROOTS through `import type`, in deterministic order. */
function closure(dir) {
  const seen = new Set();
  const order = [];
  const visit = (rel) => {
    if (seen.has(rel)) return;
    const file = join(dir, `${rel}.ts`);
    if (!existsSync(file)) throw new Error(`the generator emitted no ${rel}.ts`);
    seen.add(rel);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
      visit(normalize(join(dirname(rel), m[1])).replaceAll("\\", "/"));
    }
    // After its dependencies, so the emitted file reads bottom-up. Type aliases hoist, so
    // this is presentation only - but a reader following one type into another should be
    // going backwards through the file, not guessing.
    order.push(rel);
  };
  for (const root of [...ROOTS].sort()) visit(root);
  return order;
}

/** One module's declarations: its header and imports removed, everything else verbatim. */
function declarations(src) {
  return src
    .replace(/^\/\/.*$/gm, "")
    .replace(/^import type \{[^}]*\} from "[^"]+";$/gm, "")
    .trim();
}

/** The exported names a module declares, so a collision fails the run instead of the build. */
function exportedNames(src) {
  return [...src.matchAll(/^export type (\w+)/gm)].map((m) => m[1]);
}

const dir = mkdtempSync(join(tmpdir(), "codex-app-server-ts-"));
try {
  const stamp = version();
  codex(["app-server", "generate-ts", "--out", dir]);
  const modules = closure(dir);
  const owners = new Map();
  const chunks = [];
  for (const rel of modules) {
    const src = readFileSync(join(dir, `${rel}.ts`), "utf8");
    for (const name of exportedNames(src)) {
      const prior = owners.get(name);
      if (prior) {
        throw new Error(
          `${rel} and ${prior} both declare ${name}; the flattening in this script cannot ` +
            `keep both, so give one an alias here before regenerating`,
        );
      }
      owners.set(name, rel);
    }
    chunks.push(`// ---- ${rel} ${"-".repeat(Math.max(0, 84 - rel.length))}\n\n${declarations(src)}`);
  }
  const header = `// GENERATED by scripts/codex-app-server-bindings.mjs from codex-cli ${stamp}.
// DO NOT EDIT. Run \`node scripts/codex-app-server-bindings.mjs\` against the pinned
// binary instead, and read the diff.
//
// The subset of \`codex app-server generate-ts\` that \`harness/codex/sdk.ts\` speaks - the
// transitive closure of the roots declared in that script, concatenated. Each declaration
// below is the generator's own output, byte for byte, with only its per-file header and
// its now-redundant \`import type\` lines removed.
//
// The protocol is EXPERIMENTAL upstream. Drift is absorbed by regenerating on a version
// bump, which is safe precisely because the adapter is the only consumer and it fails to
// compile when a field it reads moves.

/** The Codex build these bindings were generated from. */
export const CODEX_APP_SERVER_BINDINGS_VERSION = ${JSON.stringify(stamp)};
`;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${header}\n${chunks.join("\n\n")}\n`);
  console.log(
    `wrote ${relative(resolve(HERE, ".."), OUT)}: ` +
      `${modules.length} declarations from codex-cli ${stamp}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
