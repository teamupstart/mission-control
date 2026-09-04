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
  const unitShardOption = "${MISSION_TEST_SHARD:+--test-shard=$MISSION_TEST_SHARD}";
  const unitTestPattern = "'test/**/*.test.ts'";
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
  const shardList = (job: "unit" | "e2e") => capture(
    jobs[job],
    /^[ \t]+shard:[ \t]*\[([^\]]+)\]/m,
  )
    ?.split(",")
    .map((value) => Number(value.trim()));
  const stepTimeout = (job: "unit" | "e2e", step: string) => capture(
    jobs[job],
    new RegExp(`- name: ${step}[\\s\\S]*?^[ \\t]+timeout-minutes:[ \\t]*(\\d+)`, "m"),
  );
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
      unitShardTotal: jobValue("unit", "MISSION_TEST_SHARDS"),
      unitShards: shardList("unit"),
      unitShardEnv: jobValue("unit", "MISSION_TEST_SHARD"),
      unitTestTimeout: stepTimeout("unit", "Test"),
      e2eWorkerVariable: jobValue("e2e", "MISSION_E2E_WORKERS"),
      e2eShards: shardList("e2e"),
      e2eTestTimeout: stepTimeout("e2e", "End-to-end tests"),
      localUnitWorkers:
        testCommand.match(
          /--test-concurrency=\$\{MISSION_TEST_CONCURRENCY:-(\d+)\}/,
        )?.[1] ?? null,
      unitShardOption:
        testCommand.includes(unitShardOption) ? unitShardOption : null,
      unitShardOptionPrecedesPattern:
        testCommand.indexOf(unitShardOption) >= 0
        && testCommand.indexOf(unitShardOption) < testCommand.indexOf(unitTestPattern),
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
      unitShardTotal: "'3'",
      unitShards: [1, 2, 3],
      unitShardEnv: "${{ matrix.shard }}/${{ env.MISSION_TEST_SHARDS }}",
      unitTestTimeout: "3",
      e2eWorkerVariable: null,
      e2eShards: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      e2eTestTimeout: "3",
      localUnitWorkers: "6",
      unitShardOption: "${MISSION_TEST_SHARD:+--test-shard=$MISSION_TEST_SHARD}",
      unitShardOptionPrecedesPattern: true,
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
