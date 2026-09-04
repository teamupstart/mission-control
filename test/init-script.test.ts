import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "init.mjs");

test("CI uses ephemeral GitHub-hosted runners at their bounded capacities", async () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const unitAction = readFileSync(
    join(repo, ".github", "actions", "run-unit-shard", "action.yml"),
    "utf8",
  );
  const testCommand = pkg.scripts.test ?? "";
  const unitShardOption = "${MISSION_TEST_SHARD:+--test-shard=$MISSION_TEST_SHARD}";
  const unitTestPattern = "'test/**/*.test.ts'";
  const jobs = Object.fromEntries(
    [
      ...workflow.matchAll(
        /^([ \t]*)(dependencies(?:-node-(?:24|26))?|gates|unit(?:-node-(?:24|26))?|e2e|package):[ \t]*\r?\n([\s\S]*?)(?=^\1(?![ \t])[a-zA-Z][\w-]*:[ \t]*(?:\r?\n|$)|(?![\s\S]))/gm,
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
  const list = (job: string, key: string) => capture(
    jobs[job],
    new RegExp(`^[ \\t]+${key}:[ \\t]*\\[([^\\]]+)\\]`, "m"),
  )
    ?.split(",")
    .map((value) => value.trim().replaceAll("'", ""));
  const shardList = (job: string) =>
    list(job, "shard")?.map(Number);
  const stepTimeout = (source: string | undefined, step: string) => capture(
    source,
    new RegExp(`- name: ${step}[\\s\\S]*?^[ \\t]+timeout-minutes:[ \\t]*(\\d+)`, "m"),
  );
  const unitCallValue = (job: string, key: string) => capture(
    jobs[job],
    new RegExp(`- name: Run unit shard[\\s\\S]*?^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, "m"),
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
        dependencies24: runner("dependencies-node-24"),
        dependencies26: runner("dependencies-node-26"),
        gates: runner("gates"),
        unit24: runner("unit-node-24"),
        unit26: runner("unit-node-26"),
        e2e: runner("e2e"),
      },
      hasBlacksmithLabel: /blacksmith/i.test(workflow),
      hasRunnerVariable: /MISSION_CONTROL_CI_RUNNER/.test(workflow),
      hasAggregateDependencyJob: Boolean(jobs.dependencies),
      hasAggregateUnitJob: Boolean(jobs.unit),
      dependencyNodes: [
        jobValue("dependencies-node-24", "node-version"),
        jobValue("dependencies-node-26", "node-version"),
      ],
      dependencyCacheActions: ["dependencies-node-24", "dependencies-node-26"].map((job) =>
        capture(jobs[job], /- name: Cache node_modules[\s\S]*?uses: actions\/cache@(v\d+)/)
      ),
      dependencyInstallConditions: ["dependencies-node-24", "dependencies-node-26"].map((job) =>
        capture(jobs[job], /- name: Install dependencies\r?\n[ \t]+if:[ \t]*(.+?)[ \t]*$/m)
      ),
      dependencyInstallCommands: ["dependencies-node-24", "dependencies-node-26"].map((job) =>
        capture(jobs[job], /- name: Install dependencies[\s\S]*?^[ \t]+run:[ \t]*(.+?)[ \t]*$/m)
      ),
      consumerNeeds: ["gates", "unit-node-24", "unit-node-26", "e2e"].map((job) =>
        jobValue(job, "needs")
      ),
      consumerRestores: [jobs.gates, unitAction, jobs.e2e].map((source) => ({
        action: capture(source, /- name: Restore node_modules[\s\S]*?uses: (actions\/cache\/restore@v\d+)/),
        failOnMiss: capture(source, /^[ \t]+fail-on-cache-miss:[ \t]*(.+?)[ \t]*$/m),
        repeatsInstall: /- name: Install dependencies/.test(source ?? ""),
      })),
      cacheActionVersions: [
        ...`${workflow}\n${unitAction}`.matchAll(/uses: actions\/cache@(v\d+)/g),
      ].map(([, version]) => version),
      unitWorkers: ["unit-node-24", "unit-node-26"].map((job) =>
        jobValue(job, "MISSION_TEST_CONCURRENCY")
      ),
      unitShardTotals: ["unit-node-24", "unit-node-26"].map((job) =>
        jobValue(job, "MISSION_TEST_SHARDS")
      ),
      unitShards: ["unit-node-24", "unit-node-26"].map(shardList),
      unitActionUses: ["unit-node-24", "unit-node-26"].map((job) =>
        unitCallValue(job, "uses")
      ),
      unitActionNodes: ["unit-node-24", "unit-node-26"].map((job) =>
        unitCallValue(job, "node-version")
      ),
      unitActionTotals: ["unit-node-24", "unit-node-26"].map((job) =>
        unitCallValue(job, "shard-total")
      ),
      unitShardEnv: capture(
        unitAction,
        /^[ \t]+MISSION_TEST_SHARD:[ \t]*(.+?)[ \t]*$/m,
      ),
      unitTestTimeout: stepTimeout(unitAction, "Test"),
      e2eWorkerVariable: jobValue("e2e", "MISSION_E2E_WORKERS"),
      e2eShards: shardList("e2e"),
      e2eTestTimeout: stepTimeout(jobs.e2e, "End-to-end tests"),
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
        dependencies24: { scalar: "ubuntu-latest", group: null, label: null },
        dependencies26: { scalar: "ubuntu-latest", group: null, label: null },
        gates: { scalar: "ubuntu-latest", group: null, label: null },
        unit24: { scalar: "ubuntu-latest", group: null, label: null },
        unit26: { scalar: "ubuntu-latest", group: null, label: null },
        e2e: { scalar: "ubuntu-latest", group: null, label: null },
      },
      hasBlacksmithLabel: false,
      hasRunnerVariable: false,
      hasAggregateDependencyJob: false,
      hasAggregateUnitJob: false,
      dependencyNodes: ["'24'", "'26'"],
      dependencyCacheActions: ["v5", "v5"],
      dependencyInstallConditions: [
        "steps.dependencies.outputs.cache-hit != 'true'",
        "steps.dependencies.outputs.cache-hit != 'true'",
      ],
      dependencyInstallCommands: [
        "npm ci --prefer-offline --no-audit --no-fund",
        "npm ci --prefer-offline --no-audit --no-fund",
      ],
      consumerNeeds: [
        "dependencies-node-24",
        "dependencies-node-24",
        "dependencies-node-26",
        "dependencies-node-24",
      ],
      consumerRestores: [
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
      ],
      cacheActionVersions: ["v5", "v5", "v5", "v5"],
      unitWorkers: ["'4'", "'4'"],
      unitShardTotals: ["'6'", "'6'"],
      unitShards: [
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5, 6],
      ],
      unitActionUses: [
        "./.github/actions/run-unit-shard",
        "./.github/actions/run-unit-shard",
      ],
      unitActionNodes: ["'24'", "'26'"],
      unitActionTotals: ["6", "6"],
      unitShardEnv: "${{ inputs.shard }}/${{ inputs.shard-total }}",
      unitTestTimeout: null,
      e2eWorkerVariable: null,
      e2eShards: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      e2eTestTimeout: null,
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
