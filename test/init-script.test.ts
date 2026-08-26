import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "init.mjs");

test("CI directly uses available frontend runners at their bounded capacities", async () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const testCommand = pkg.scripts.test ?? "";
  const jobs = Object.fromEntries(
    [
      ...workflow.matchAll(
        /^([ \t]*)(gates|unit|e2e):[ \t]*\r?\n([\s\S]*?)(?=^\1(?![ \t])[a-zA-Z][\w-]*:[ \t]*(?:\r?\n|$)|(?![\s\S]))/gm,
      ),
    ].map(([, , job, body]) => [job, body]),
  );
  const capture = (source: string | undefined, pattern: RegExp) =>
    source?.match(pattern)?.[1] ?? null;
  const jobValue = (job: string, key: string) =>
    capture(
      jobs[job],
      new RegExp(`^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, "m"),
    );
  const runner = (job: string) => ({
    scalar: jobValue(job, "runs-on"),
    group: capture(jobs[job], /^[ \t]+group:[ \t]*(.+?)[ \t]*$/m),
    label: capture(jobs[job], /^[ \t]+labels:[ \t]*(.+?)[ \t]*$/m),
  });
  const shards = capture(jobs.e2e, /^[ \t]+shard:[ \t]*\[([^\]]+)\]/m)
    ?.split(",")
    .map((value) => Number(value.trim()));
  const e2eConfigUrl = pathToFileURL(join(repo, "e2e", "playwright.config.ts")).href;
  const previousCi = process.env.CI;
  const previousWorkers = process.env.MISSION_E2E_WORKERS;
  const loadWorkers = async (ci: boolean) => {
    if (ci) process.env.CI = "true";
    else delete process.env.CI;
    delete process.env.MISSION_E2E_WORKERS;

    const config = (await import(
      `${e2eConfigUrl}?capacity-contract=${ci}`
    )).default as { workers?: number };
    return config.workers ?? null;
  };

  let playwrightWorkers: { ci: number | null; local: number | null };
  try {
    playwrightWorkers = {
      ci: await loadWorkers(true),
      local: await loadWorkers(false),
    };
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousWorkers === undefined) delete process.env.MISSION_E2E_WORKERS;
    else process.env.MISSION_E2E_WORKERS = previousWorkers;
  }

  assert.deepEqual(
    {
      runners: {
        gates: runner("gates"),
        unit: runner("unit"),
        e2e: runner("e2e"),
      },
      hasBlacksmithLabel: /blacksmith/i.test(workflow),
      hasRunnerVariable: /MISSION_CONTROL_CI_RUNNER/.test(workflow),
      unitWorkers: jobValue("unit", "MISSION_TEST_CONCURRENCY"),
      e2eWorkerVariable: jobValue("e2e", "MISSION_E2E_WORKERS"),
      shards,
      localUnitWorkers:
        testCommand.match(
          /--test-concurrency=\$\{MISSION_TEST_CONCURRENCY:-(\d+)\}/,
        )?.[1] ?? null,
      playwrightWorkers,
    },
    {
      runners: {
        gates: { scalar: "ubuntu-latest", group: null, label: null },
        unit: {
          scalar: null,
          group: "frontend-platform",
          label: "ubuntu-8cpu-32ram-300ssd",
        },
        e2e: {
          scalar: null,
          group: "frontend-platform",
          label: "ubuntu-4cpu-32ram-150ssd",
        },
      },
      hasBlacksmithLabel: false,
      hasRunnerVariable: false,
      unitWorkers: "'8'",
      e2eWorkerVariable: null,
      shards: [1, 2, 3, 4, 5],
      localUnitWorkers: "6",
      playwrightWorkers: { ci: 4, local: 4 },
    },
  );
});

test("init dry-run has no external worktree installer or configuration step", () => {
  const output = execFileSync(
    process.execPath,
    [script, "--dry-run", "--skip-build", "--skip-hooks"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.doesNotMatch(output, /^\s*(?:\d+\.\s+)?treehouse|curl -fsSL|go install/im);
  assert.match(output, /Node\.js prerequisite/);
  assert.match(output, /Node dependencies/);
  assert.match(output, /Claude status hooks/);
});

test("init source cannot invoke the retired Treehouse bootstrap", () => {
  const source = readFileSync(script, "utf8");
  const makefile = readFileSync(join(repo, "Makefile"), "utf8");
  assert.doesNotMatch(source, /treehouse|kunchenguid|curl -fsSL|go install/i);
  assert.doesNotMatch(makefile, /treehouse|kunchenguid|curl -fsSL|go install/i);
});
