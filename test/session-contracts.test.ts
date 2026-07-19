import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sessionEqual } from "../src/server/registry.ts";
import { meta, mkSession } from "./helpers/session-fixture.ts";
import type { NmFixSummary, OrphanedQueueHint, Session } from "../src/shared/types.ts";

const FIX: NmFixSummary = {
  sha: "abc1234",
  step: "lint",
  summary: "drop unused import",
  committedAt: 0,
  filesChanged: 1,
  added: 0,
  removed: 1,
  decision: null,
  repliedBy: null,
  findingCount: 1,
};

const ORPHAN: OrphanedQueueHint = { noteKey: "k", itemCount: 2, branch: "harness/x" };

/**
 * Two contracts that fail SILENTLY when broken - no error, no failing test, just a
 * dashboard showing something that isn't true anymore:
 *
 *  1. `sessionEqual` gates every SSE emit. A `Session` field it doesn't compare
 *     renders once from the snapshot and then never updates again.
 *  2. `useEventStream`'s switch handles `ServerEvent`. A variant it doesn't handle
 *     is dropped on the floor.
 *
 * Both are now compiler-enforced. These tests prove the enforcement actually fires
 * (below), and that making it fail closed didn't change what gets emitted (above).
 */

// ---- semantics: the refactor must not change a single emit decision ----

test("identical sessions are equal", () => {
  assert.equal(sessionEqual(mkSession(), mkSession()), true);
});

test("a visible change emits", () => {
  const cases: Partial<Session>[] = [
    { name: "renamed" },
    { state: "idle" },
    { cwd: "/elsewhere" },
    { gitBranch: "other" },
    { gitRoot: "/repo" },
    { repoRoot: "/repo" },
    { pid: 2 },
    { nameSource: "process" },
    { agentSessionId: "agent-2" },
    { transcriptPath: "/t.jsonl" },
    { instrumented: false },
    { hooksSeen: false },
    { activity: "something else" },
    { permissionMode: "plan" },
    { pendingReviews: 3 },
    { nomistakesNarration: "running tests" },
    { prUrl: "https://example.test/pr/1" },
    { prNumber: 1 },
    { prState: "open" },
    { prChecks: "failing" },
  ];
  for (const over of cases) {
    const field = Object.keys(over)[0];
    assert.equal(sessionEqual(mkSession(), mkSession(over)), false, `${field} should emit`);
  }
});

test("liveness timestamps do NOT emit - they move every poll", () => {
  assert.equal(sessionEqual(mkSession(), mkSession({ lastSeen: 999_999 })), true);
  assert.equal(sessionEqual(mkSession(), mkSession({ lastActivity: 999_999 })), true);
});

test("nested summaries are compared structurally", () => {
  const base = mkSession({ queue: null, orphanedQueue: null });
  // Same shape, different object identity: equal, or every poll would re-emit.
  assert.equal(sessionEqual(base, mkSession({ queue: null, orphanedQueue: null })), true);
  assert.equal(sessionEqual(mkSession(), mkSession({ nomistakes: null })), false);
  assert.equal(sessionEqual(mkSession(), mkSession({ goal: null })), false);
  assert.equal(sessionEqual(mkSession(), mkSession({ nomistakesFixes: [FIX] })), false);
});

test("orphanedQueue emits - the bug the comparator record documents", () => {
  // A queue is orphaned only once ANOTHER session is evicted, so the session whose
  // hint changes need not have changed in any way of its own. Leaving this out of
  // the comparison stranded batches with nothing to surface them.
  assert.equal(sessionEqual(mkSession(), mkSession({ orphanedQueue: ORPHAN })), false);
});

test("wezterm and tmux compare only what the card renders", () => {
  const wez = { paneId: 1, tabId: 1, windowId: 1, tabTitle: "t", isActive: true };
  // Focus flips are visible; the pane geometry around them churns and isn't.
  assert.equal(
    sessionEqual(mkSession({ wezterm: wez }), mkSession({ wezterm: { ...wez, isActive: false } })),
    false,
  );
  assert.equal(
    sessionEqual(mkSession({ wezterm: wez }), mkSession({ wezterm: { ...wez, paneId: 99 } })),
    true,
  );

  const tmux = { session: "s", window: "w", windowIndex: 0, paneId: "%1" };
  assert.equal(
    sessionEqual(mkSession({ tmux }), mkSession({ tmux: { ...tmux, window: "w2" } })),
    false,
  );
  assert.equal(
    sessionEqual(mkSession({ tmux }), mkSession({ tmux: { ...tmux, paneId: "%9" } })),
    true,
  );
});

test("meta compares displayed values, not the reading behind them", () => {
  assert.equal(sessionEqual(mkSession(), mkSession({ meta: meta({ model: "Sonnet 5" }) })), false);
  // A re-read that lands on the same displayed model/context% must not re-render.
  assert.equal(
    sessionEqual(mkSession(), mkSession({ meta: meta({ updatedAt: 12_345, contextTokens: 124_001 }) })),
    true,
  );
});

// ---- enforcement: prove the compiler actually rejects a gap ----

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Inherits the real `compilerOptions` so a future strictness flag reaches the
 * probes too, but re-declares `baseUrl`/`paths` deliberately: inherited paths
 * resolve against the config that declared them, which would send `@shared/*`
 * back to the real `src` and typecheck the unpatched tree - every probe would
 * pass vacuously. Re-declaring both re-roots resolution at the copy. `include`
 * narrows to `src` because the copy has no `hooks`/`test`/`vite.config.ts`.
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
function typecheckWithPatch(patch: ((dir: string) => void) | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-contract-probe-"));
  try {
    cpSync(path.join(REPO, "src"), path.join(dir, "src"), { recursive: true });
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
function edit(dir: string, rel: string, from: string, to: string): void {
  const file = path.join(dir, rel);
  const src = readFileSync(file, "utf8");
  assert.ok(src.includes(from), `probe anchor no longer present in ${rel}: ${from}`);
  writeFileSync(file, src.replace(from, to));
}

const SESSION_END = "  paneDialog: PaneDialog | null;\n}";
const SERVER_EVENT_END = `  | { type: "task_remove"; id: string };`;

/**
 * Matched on error CODES plus the identifiers involved, never on diagnostic
 * prose: TypeScript rewords its messages between releases, and a probe that goes
 * red on a routine tsc upgrade is exactly the false "the guard broke" signal
 * these tests exist to be trustworthy about. Codes and symbol names are stable.
 * Each diagnostic is one line, so `[^\n]*` keeps a match from spanning two.
 */
const missingComparator = (field: string): RegExp =>
  new RegExp(`registry\\.ts[^\\n]*error TS2741:[^\\n]*${field}[^\\n]*SessionFieldComparators`);
const UNHANDLED_EVENT = /useEventStream\.ts[^\n]*error TS2322:[^\n]*never/;

test("the probe harness compiles a clean copy", () => {
  // Without this, a probe that failed to compile for some UNRELATED reason would
  // still satisfy "typechecking failed" and the guard could rot untested.
  assert.equal(typecheckWithPatch(null), "", "unpatched copy of src should typecheck");
});

test("a Session field with no comparator fails typecheck", () => {
  const out = typecheckWithPatch((dir) =>
    edit(dir, "src/shared/types.ts", SESSION_END, "  paneDialog: PaneDialog | null;\n  probeField: boolean;\n}"),
  );
  assert.match(
    out,
    missingComparator("probeField"),
    `adding a Session field should break SESSION_FIELD_COMPARATORS, got:\n${out}`,
  );
});

test("an OPTIONAL Session field with no comparator also fails typecheck", () => {
  // The `-?` in the mapped type is load-bearing: without it an optional field
  // could be omitted from the record, which is the same silent staleness with a
  // question mark on it.
  const out = typecheckWithPatch((dir) =>
    edit(dir, "src/shared/types.ts", SESSION_END, "  paneDialog: PaneDialog | null;\n  probeOptional?: boolean;\n}"),
  );
  assert.match(
    out,
    missingComparator("probeOptional"),
    `an optional Session field should still be required in the record, got:\n${out}`,
  );
});

test("a ServerEvent variant the stream doesn't handle fails typecheck", () => {
  const out = typecheckWithPatch((dir) =>
    edit(
      dir,
      "src/shared/types.ts",
      SERVER_EVENT_END,
      `  | { type: "task_remove"; id: string }\n  | { type: "probe_unhandled"; id: string };`,
    ),
  );
  assert.match(
    out,
    UNHANDLED_EVENT,
    `an unhandled ServerEvent variant should break the exhaustiveness check, got:\n${out}`,
  );
});
