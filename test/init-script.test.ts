import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "init.mjs");

test("CI capacity safely opts in while local worker defaults stay bounded", async () => {
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
  const selectorDecisions = (expression: string | null) => {
    const selector = expression?.match(
      /^\s*\$\{\{\s*vars\.([A-Z_][A-Z0-9_]*)\s*==\s*(["'])([^"']*)\2\s*&&\s*(["'])([^"']*)\4\s*\|\|\s*(["'])([^"']*)\6\s*\}\}\s*$/,
    );
    if (!selector || selector[1] !== "MISSION_CONTROL_CI_RUNNER") return null;

    const decide = (runner: string | undefined) =>
      runner === selector[3] ? selector[5] : selector[7];
    return {
      unset: decide(undefined),
      optedIn: decide("ubuntu-8core"),
      nearMiss: decide("ubuntu-8cor"),
    };
  };
  const e2eConfigUrl = pathToFileURL(join(repo, "e2e", "playwright.config.ts")).href;
  const previousCi = process.env.CI;
  const previousWorkers = process.env.MISSION_E2E_WORKERS;
  const loadWorkers = async (ci: boolean, workers?: string) => {
    if (ci) process.env.CI = "true";
    else delete process.env.CI;
    if (workers === undefined) delete process.env.MISSION_E2E_WORKERS;
    else process.env.MISSION_E2E_WORKERS = workers;

    const config = (await import(
      `${e2eConfigUrl}?capacity-contract=${ci}-${workers ?? "default"}`
    )).default as { workers?: number };
    return config.workers ?? null;
  };

  let playwrightWorkers: {
    ciOptIn: number | null;
    ciUnset: number | null;
    ciInvalid: number | null;
    local: number | null;
  };
  try {
    playwrightWorkers = {
      ciOptIn: await loadWorkers(true, "8"),
      ciUnset: await loadWorkers(true),
      ciInvalid: await loadWorkers(true, "invalid"),
      local: await loadWorkers(false, "8"),
    };
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousWorkers === undefined) delete process.env.MISSION_E2E_WORKERS;
    else process.env.MISSION_E2E_WORKERS = previousWorkers;
  }

  assert.deepEqual(
    {
      gateRunner: jobValue("gates", "runs-on"),
      runnerSelectors: {
        unit: selectorDecisions(jobValue("unit", "runs-on")),
        e2e: selectorDecisions(jobValue("e2e", "runs-on")),
      },
      hasBlacksmithLabel: /blacksmith/i.test(workflow),
      workerSelectors: {
        unit: selectorDecisions(
          jobValue("unit", "MISSION_TEST_CONCURRENCY"),
        ),
        e2e: selectorDecisions(jobValue("e2e", "MISSION_E2E_WORKERS")),
      },
      localUnitWorkers:
        testCommand.match(
          /--test-concurrency=\$\{MISSION_TEST_CONCURRENCY:-(\d+)\}/,
        )?.[1] ?? null,
      playwrightWorkers,
    },
    {
      gateRunner: "ubuntu-latest",
      runnerSelectors: {
        unit: {
          unset: "ubuntu-latest",
          optedIn: "ubuntu-8core",
          nearMiss: "ubuntu-latest",
        },
        e2e: {
          unset: "ubuntu-latest",
          optedIn: "ubuntu-8core",
          nearMiss: "ubuntu-latest",
        },
      },
      hasBlacksmithLabel: false,
      workerSelectors: {
        unit: { unset: "2", optedIn: "8", nearMiss: "2" },
        e2e: { unset: "2", optedIn: "8", nearMiss: "2" },
      },
      localUnitWorkers: "6",
      playwrightWorkers: { ciOptIn: 8, ciUnset: 2, ciInvalid: 2, local: 4 },
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
