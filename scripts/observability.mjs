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
// 3. The integration test and the operator need the SAME stack, from the same project name and
//    the same volumes. A test that quietly uses a different topology proves nothing about the
//    thing anyone will actually run.
//
// Usage:
//   node scripts/observability.mjs up|down|reset|ready|status|verify|endpoint
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "observability", "local", "compose.yaml");
const PROJECT = "mission-observability";

/**
 * The host-side addresses.
 *
 * These are NOT the addresses the containers use to reach each other - those are service names
 * on the Compose network, and confusing the two is the most common way this stack looks broken.
 * Anything published here is bound to 127.0.0.1 in compose.yaml.
 */
export const ENDPOINTS = {
  /** What Mission Control's telemetry endpoint should be set to. */
  otlp: "http://127.0.0.1:14318",
  collectorHealth: "http://127.0.0.1:14133/",
  prometheus: "http://127.0.0.1:19090",
  tempo: "http://127.0.0.1:13200",
  grafana: "http://127.0.0.1:13000",
  /** The provisioned diagnostic dashboard. */
  dashboard: "http://127.0.0.1:13000/d/mission-telemetry-diagnostics",
};

const READINESS = [
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

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
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
    ],
    { stdio: "inherit" },
  );
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
      "mkdir -p /etc/prometheus && cp /cfg/rules.yml /etc/prometheus/rules.yml && /bin/promtool check config /cfg/prometheus.yml",
    ],
    { stdio: "inherit" },
  );
  if (promConfig.status !== 0) process.exit(promConfig.status ?? 1);
  process.stdout.write("[observability] prometheus configuration and rules are valid\n");
}

async function main() {
  const command = process.argv[2] ?? "up";
  switch (command) {
    case "up":
      await up();
      return;
    case "down": {
      // Volumes survive. Stopping the stack and destroying stored metrics are different
      // intentions and must be different commands.
      const result = compose(["down"]);
      process.exit(result.status ?? 0);
      return;
    }
    case "reset": {
      const result = compose(["down", "-v"]);
      process.stdout.write("[observability] stopped and removed every data volume\n");
      process.exit(result.status ?? 0);
      return;
    }
    case "status": {
      const result = compose(["ps"]);
      process.exit(result.status ?? 0);
      return;
    }
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

