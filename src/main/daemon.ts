// Daemon supervisor.
//
// The daemon is the same Node server the web app has always used. Here it runs
// as an Electron `utilityProcess` (a real Node runtime outside the renderer
// sandbox) executing the esbuild bundle at dist/server/index.mjs. `node:sqlite`
// works under Electron's bundled Node (verified on Electron 43 / Node 24), so
// nothing about the daemon changes.
//
// Adopt-or-spawn: if a daemon already answers on the port (a LaunchAgent or
// `make up`), we adopt it and never spawn a second one that would fight over the
// port. We only supervise/stop a daemon we started. Development does not call
// this supervisor; `dev:server` owns that daemon lifecycle.

import { BASE_URL } from "@shared/harness-runtime.mjs";
import {
  DAEMON_PROTOCOL_CAPABILITIES,
  daemonHealthCompatibility,
  type DaemonCompatibility,
} from "@shared/daemon-protocol.ts";
import { loginShellPath } from "../server/util/path-env.ts";
import { serveProductIssueAuthorization } from "./product-issue-authorization.ts";
import { superviseUtilityProcess } from "./utility-supervisor.ts";

export interface DaemonController {
  /** True when an existing daemon was reused rather than spawned by us. */
  adopted: boolean;
  stop: () => void;
}

const HEALTH_URL = `${BASE_URL}/api/health`;
const REQUIRED_DAEMON_CAPABILITY =
  DAEMON_PROTOCOL_CAPABILITIES.criterionMappedWorkflowEvidence;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One health probe that distinguishes an absent daemon from an older running daemon.
 * Treating both as merely unhealthy would make Electron spawn into an occupied port.
 */
export async function daemonCompatibility(timeoutMs = 800): Promise<DaemonCompatibility> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    if (!res.ok) return "unreachable";
    return daemonHealthCompatibility(await res.json() as unknown, REQUIRED_DAEMON_CAPABILITY);
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** True only when the daemon is healthy and speaks this desktop build's wire contract. */
export async function daemonHealthy(timeoutMs = 800): Promise<boolean> {
  return await daemonCompatibility(timeoutMs) === "compatible";
}

/** Poll health until it passes or `totalMs` elapses. */
export async function waitForHealthy(totalMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await daemonHealthy()) return true;
    if (Date.now() - start >= totalMs) return false;
    await sleep(300);
  }
}

export interface StartDaemonOptions {
  /** Absolute path to the bundled server entry (dist/server/index.mjs). */
  serverEntry: string;
  /** Absolute path to the built web UI the daemon should serve. */
  webDir: string;
  /** Where to append the daemon's stdout/stderr. */
  logPath: string;
}

/**
 * Adopt a running daemon, or spawn + supervise our own. The spawned daemon is
 * restarted with capped backoff if it exits unexpectedly, and torn down on
 * `stop()`. Its env carries the resolved login-shell PATH (so it can find
 * tmux/wezterm/git) and MISSION_WEB_DIR.
 */
export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonController> {
  const compatibility = await daemonCompatibility();
  if (compatibility === "compatible") {
    return { adopted: true, stop: () => {} };
  }
  if (compatibility === "incompatible") {
    throw new Error(
      "A running Mission Control daemon is from an older build. Stop it before opening this version.",
    );
  }

  const controller = superviseUtilityProcess({
    entry: opts.serverEntry,
    serviceName: "mission-control-daemon",
    logPath: opts.logPath,
    env: {
      ...process.env,
      PATH: loginShellPath(),
      MISSION_WEB_DIR: opts.webDir,
    },
    // A Report click is armed in the shell over IPC and consumed here over the private
    // utility-process port. A loopback caller has access to neither side of that handoff.
    onSpawn: serveProductIssueAuthorization,
  });
  return {
    adopted: false,
    stop: () => controller.stop(),
  };
}
