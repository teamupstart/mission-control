#!/usr/bin/env node
// Start, stop, reset, verify and wait on the local reference observability stack.
//
// A wrapper rather than a README full of `docker compose` invocations, for three reasons an
// operator would otherwise discover the hard way:
//
// 1. `up` is useless without a readiness wait. Prometheus answers its port before its TSDB is
//    open, and Grafana answers before provisioning has run, so "the containers started" and
//    "you can point Mission Control at it" are minutes apart on a cold pull.
// 2. `down` and `reset` have to be different commands. Stopping the stack and destroying an
//    operator's stored metrics are not the same intention, and Compose spells the difference
//    as one easily-mistyped flag.
// 3. Real, demo and acceptance projects use the same pinned topology with distinct ports and
//    volumes. Integration outages must never stop an operator backend.
//
// Usage:
//   node scripts/observability.mjs up|down|restart|reset|ready|status|verify|endpoint
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "observability", "local", "compose.yaml");
export const MODE = process.env.MC_OBSERVABILITY_MODE ?? "real";
if (!["real", "demo", "test"].includes(MODE)) throw new Error("MC_OBSERVABILITY_MODE must be real, demo or test");
const PROJECT = MODE === "real" ? "mission-observability" : `mission-observability-${MODE}`;
const offset = MODE === "real" ? 0 : MODE === "demo" ? 10000 : 20000;
const ports = { OTLP: 14318, HEALTH: 14133, PROMETHEUS: 19090, TEMPO: 13200, GRAFANA: 13000 };
const host = (key) => `http://127.0.0.1:${ports[key] + offset}`;

/**
 * The host-side addresses.
 *
 * These are NOT the addresses the containers use to reach each other - those are service names
 * on the Compose network, and confusing the two is the most common way this stack looks broken.
 * Anything published here is bound to 127.0.0.1 in compose.yaml.
 */
export const ENDPOINTS = {
  /** What Mission Control's telemetry endpoint should be set to. */
  otlp: host("OTLP"),
  collectorHealth: `${host("HEALTH")}/`,
  prometheus: host("PROMETHEUS"),
  tempo: host("TEMPO"),
  grafana: host("GRAFANA"),
  /** The adoption entry point; all six dashboards share navigation. */
  dashboard: `${host("GRAFANA")}/d/mission-adoption`,
};

const READINESS = [
  ...["adoption", "workflows", "personas", "models", "interventions", "reliability"].map((name) => [`dashboard ${name}`, `${ENDPOINTS.grafana}/api/dashboards/uid/mission-${name}`]),
  ["collector", `${ENDPOINTS.collectorHealth}`],
  ["prometheus", `${ENDPOINTS.prometheus}/-/ready`],
  ["tempo", `${ENDPOINTS.tempo}/ready`],
  ["grafana", `${ENDPOINTS.grafana}/api/health`],
];

function compose(args, opts = {}) {
  return spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    stdio: opts.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(ports).map(([key, port]) => [`MC_OBS_${key}_PORT`, String(port + offset)])),
      // Docker Desktop's CLI hints and the interactive Compose menu both make network calls
      // before running the command. On a machine where those calls hang, `docker compose up`
      // hangs with no output at all and looks like a broken Compose file. Turning them off
      // costs nothing and removes a failure mode that is impossible to diagnose from here.
      DOCKER_CLI_HINTS: "false",
      COMPOSE_MENU: "false",
    },
  });
}

/**
 * Stop or start ONE component, leaving the rest running.
 *
 * Exported because "validate each hop by stopping it independently" is a requirement rather
 * than a debugging convenience: the integration test takes the Collector away to prove that a
 * fact captured while the backend is unreachable survives a Mission Control restart and is
 * delivered once the backend comes back. An operator debugging which hop is broken wants the
 * same two commands.
 */
export function composeService(action, service) {
  const result = compose([action, service], { quiet: true });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Exit with an explanation when docker itself could not be run.
 *
 * `spawnSync` reports a missing or stopped Docker as `error` set and `status: null`, so a check
 * that reads only `status !== 0` exits 1 having printed nothing at all - and under
 * `stdio: "inherit"` there is no captured output to fall back on either. `up` has always said
 * so; the `verify` checks did not, which made "Docker is not running" look like "your
 * Prometheus rules are broken, but I will not say how".
 */
export function requireDocker(result) {
  if (!result.error) return;
  process.stderr.write(`[observability] could not run docker: ${result.error.message}\n`);
  process.exit(1);
}

/**
 * Turn a `spawnSync` result into an exit code, without reporting success for a command that
 * never ran.
 *
 * `spawnSync` sets `status` to null when it could not execute at all - Docker not installed,
 * not on PATH, not running - and leaves the reason in `error`. `status ?? 0` therefore exits 0
 * and tells the caller the stack is fine when nothing happened. A wrapper whose whole job is
 * to be the reliable entry point must not do that.
 */
function finish(result, successMessage) {
  requireDocker(result);
  if (result.status === null || result.status === undefined) {
    process.stderr.write("[observability] docker exited without a status (killed by a signal?)\n");
    process.exit(1);
  }
  if (result.status === 0 && successMessage) process.stdout.write(`${successMessage}\n`);
  process.exit(result.status);
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait until every component answers its own readiness endpoint.
 *
 * Each is asked its OWN question rather than "is the container running": a Compose health state
 * says the process started, and what matters here is whether the TSDB is open, whether Tempo's
 * blocklist poller has run and whether Grafana has finished provisioning.
 */
export async function waitUntilReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(READINESS);
  while (Date.now() < deadline) {
    for (const [name, url] of pending) {
      if (await probe(url)) pending.delete(name);
    }
    if (pending.size === 0) return { ok: true, waiting: [] };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { ok: false, waiting: [...pending.keys()] };
}

async function up() {
  const result = compose(["up", "-d", "--wait-timeout", "180"]);
  if (result.error) {
    process.stderr.write(`[observability] could not run docker: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.stdout.write("[observability] waiting for every component to report ready\n");
  const ready = await waitUntilReady();
  if (!ready.ok) {
    process.stderr.write(
      `[observability] not ready after 180s: ${ready.waiting.join(", ")}\n` +
        `[observability] logs: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} logs\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    [
      "[observability] ready.",
      `  OTLP endpoint for Mission Control: ${ENDPOINTS.otlp}`,
      `  Grafana:    ${ENDPOINTS.grafana}`,
      `  Dashboard:  ${ENDPOINTS.dashboard}`,
      `  Prometheus: ${ENDPOINTS.prometheus}`,
      `  Tempo:      ${ENDPOINTS.tempo}`,
      "",
    ].join("\n"),
  );
}

/**
 * Validate the Compose file and the Prometheus configuration with the pinned tooling.
 *
 * `promtool` runs inside the SAME image the stack runs, so it checks the config against the
 * version that will load it rather than against whatever happens to be installed on the host.
 */
function verify() {
  const config = compose(["config", "-q"], { quiet: true });
  requireDocker(config);
  if (config.status !== 0) {
    process.stderr.write(config.stderr ?? "");
    process.exit(config.status ?? 1);
  }
  process.stdout.write("[observability] compose configuration is valid\n");

  const promtool = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/promtool",
      "-v",
      `${join(ROOT, "observability", "prometheus")}:/cfg:ro`,
      "prom/prometheus:v3.14.0",
      "check",
      "rules",
      "/cfg/rules.yml",
      "/cfg/cohorts.yml",
    ],
    { stdio: "inherit" },
  );
  requireDocker(promtool);
  if (promtool.status !== 0) process.exit(promtool.status ?? 1);

  // The config check has to run with the rule file at the path the real container mounts it at,
  // so it is checked from inside a container with the same mount rather than from the host.
  const promConfig = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${join(ROOT, "observability", "prometheus")}:/cfg:ro`,
      "prom/prometheus:v3.14.0",
      "-c",
      "mkdir -p /etc/prometheus && cp /cfg/rules.yml /cfg/cohorts.yml /etc/prometheus/ && /bin/promtool check config /cfg/prometheus.yml",
    ],
    { stdio: "inherit" },
  );
  requireDocker(promConfig);
  if (promConfig.status !== 0) process.exit(promConfig.status ?? 1);
  const ruleTests = spawnSync("docker", ["run", "--rm", "--entrypoint", "/bin/promtool", "-v",
    `${join(ROOT, "observability", "prometheus")}:/cfg:ro`, "-w", "/cfg", "prom/prometheus:v3.14.0", "test", "rules", "rules.test.yml"], { stdio: "inherit" });
  requireDocker(ruleTests);
  if (ruleTests.status !== 0) process.exit(ruleTests.status ?? 1);
  process.stdout.write("[observability] prometheus configuration, rules and fixtures are valid\n");
}

async function main() {
  const command = process.argv[2] ?? "up";
  switch (command) {
    case "up":
      await up();
      return;
    case "restart":
      { const result = compose(["restart"]);
        requireDocker(result);
        if (result.status !== 0) process.exit(result.status ?? 1);
        const ready = await waitUntilReady();
        if (!ready.ok) throw new Error(`restart not ready: ${ready.waiting.join(", ")}`);
        process.stdout.write("[observability] restarted; data preserved and all dashboards ready\n");
      }
      return;
    case "down": {
      // Volumes survive. Stopping the stack and destroying stored metrics are different
      // intentions and must be different commands.
      finish(compose(["down"]));
      return;
    }
    case "reset":
      // The success line prints only on a zero exit. Announcing a destroy that did not happen
      // is worse than a plain failure, because the next command is run believing it did.
      finish(compose(["down", "-v"]), "[observability] stopped and removed every data volume");
      return;
    case "status":
      finish(compose(["ps"]));
      return;
    case "ready": {
      const ready = await waitUntilReady(60_000);
      if (!ready.ok) {
        process.stderr.write(`[observability] not ready: ${ready.waiting.join(", ")}\n`);
        process.exit(1);
      }
      process.stdout.write("[observability] ready\n");
      return;
    }
    case "verify":
      verify();
      return;
    case "endpoint":
      process.stdout.write(`${ENDPOINTS.otlp}\n`);
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(2);
  }
}

// Only run when invoked directly, so the integration test can import ENDPOINTS and
// waitUntilReady without starting anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

