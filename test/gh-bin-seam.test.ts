import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ghBin } from "../src/server/config.ts";
import { TASK_SOURCES, pushToSource } from "../src/server/task-sources/index.ts";
import { TaskSourceInstanceSchema } from "../src/shared/task-source.ts";

/**
 * What is at stake: three subsystems shell out to `gh` - the PR poller, the Inspector, and
 * the GitHub task source - and until now each named the binary itself, as a string
 * literal, fourteen times over. That is not a style problem. It means a test process has
 * no way to stand between this app and GitHub: whatever it thinks it is exercising, the
 * spawn lands on the operator's real, authenticated `gh`, against whatever repo the cwd
 * resolves to. The task source's new outward verb CREATES ISSUES, so the same gap that
 * used to mean a stray read now means a stray write into somebody's repo.
 *
 * `ghBin()` is the one seam that closes it, and a seam is only worth what the LEAKIEST
 * call site allows - one forgotten literal and a suite that believes it is faked is not.
 * So the scan below is part of the contract, not a tidiness check.
 */

const SERVER_DIR = fileURLToPath(new URL("../src/server", import.meta.url));

/** Every `.ts` under `src/server`, path and text. */
function serverSources(dir = SERVER_DIR): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverSources(p));
    else if (entry.name.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

test("the gh binary defaults to gh, so an install with no override behaves identically", () => {
  const before = process.env.MISSION_GH_BIN;
  try {
    delete process.env.MISSION_GH_BIN;
    assert.equal(ghBin(), "gh");
  } finally {
    if (before === undefined) delete process.env.MISSION_GH_BIN;
    else process.env.MISSION_GH_BIN = before;
  }
});

test("MISSION_GH_BIN overrides it, and an exported-but-empty value is not an override", () => {
  const before = process.env.MISSION_GH_BIN;
  try {
    process.env.MISSION_GH_BIN = "/opt/fake/gh";
    assert.equal(ghBin(), "/opt/fake/gh");
    // `MISSION_GH_BIN=` is somebody clearing the override, not asking us to spawn "".
    process.env.MISSION_GH_BIN = "";
    assert.equal(ghBin(), "gh");
  } finally {
    if (before === undefined) delete process.env.MISSION_GH_BIN;
    else process.env.MISSION_GH_BIN = before;
  }
});

// The invariant the seam is worth nothing without. A single surviving literal is a
// subsystem that ignores the override in silence - and it would be found the way the
// original gap was: by a test suite quietly talking to the real GitHub.
test("no server module names the gh binary itself - every spawn goes through ghBin()", () => {
  const offenders: string[] = [];
  for (const { path, text } of serverSources()) {
    // Comments and error strings say "gh" constantly ("run `gh auth login`"); what is
    // banned is the literal reaching a spawn as the command to run.
    const re = /(?:run|execFile|execFileSync|spawn|spawnSync)\(\s*"gh"/g;
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${path}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `these spawn gh directly instead of through ghBin()`);
});

// End to end through the layer a caller actually uses: the erased registry entry point,
// into the implementation, into a subprocess. If any link resolved the binary its own way
// this would spawn the real `gh` and fail on the argv the fake never recorded.
test("a gh on the seam is the binary the GitHub source actually runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-seam-"));
  const argvFile = join(dir, "argv.txt");
  const fake = join(dir, "fake-gh");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
      "printf 'Creating issue in acme/widgets\\n'",
      "printf 'https://github.com/acme/widgets/issues/7\\n'",
    ].join("\n"),
    { mode: 0o755 },
  );

  const inst = TaskSourceInstanceSchema.parse({
    id: "src-1",
    kind: "github-issues",
    repoRoot: dir,
    config: { labelsAny: ["mission"] },
  });

  const before = process.env.MISSION_GH_BIN;
  try {
    process.env.MISSION_GH_BIN = fake;
    const res = await pushToSource(
      inst,
      { title: "Widgets leak on resize", intent: "Steps: resize twice." },
      { sourceId: "src-1", repoRoot: dir, signal: new AbortController().signal },
    );
    assert.equal(res.error, null);
    assert.equal(res.outcomeUnknown, false);
    assert.deepEqual(res.ref, {
      sourceId: "src-1",
      externalId: "acme/widgets#7",
      url: "https://github.com/acme/widgets/issues/7",
    });
  } finally {
    if (before === undefined) delete process.env.MISSION_GH_BIN;
    else process.env.MISSION_GH_BIN = before;
  }

  const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(argv.slice(0, 2), ["issue", "create"]);
  assert.ok(argv.includes("Widgets leak on resize"), "the title reached gh as one argument");
  assert.deepEqual(argv.slice(-2), ["--label", "mission"]);
});

// The registry's own slot has to agree with the seam's reach: a kind that cannot push has
// no `push` to reach, and a caller asking anyway must be told rather than quietly obliged.
test("the erased registry exposes push exactly where an implementation has one", () => {
  assert.notEqual(TASK_SOURCES["github-issues"].push, null);
  assert.equal(TASK_SOURCES.jira.push, null);
});
