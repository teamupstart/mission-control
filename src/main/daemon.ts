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
import { loginShellPath } from "../server/util/path-env.ts";
import { serveProductIssueConsent } from "./product-issue-consent.ts";
import { superviseUtilityProcess } from "./utility-supervisor.ts";

export interface DaemonController {
  /** True when an existing daemon was reused rather than spawned by us. */
  adopted: boolean;
  stop: () => void;
}

const HEALTH_URL = `${BASE_URL}/api/health`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One health probe: true only when our daemon answers with its service id. */
export async function daemonHealthy(timeoutMs = 800): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = (await res.json()) as { service?: string };
    return j.service === "mission-control";
  } catch {
    return false;
  }
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
  if (await daemonHealthy()) {
    return { adopted: true, stop: () => {} };
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
    // Publishing a public issue is confirmed HERE, not in the daemon and not in the page:
    // the daemon asks down this port and only a click on the dialog this installs can answer
    // yes. See ./product-issue-consent.ts for why it cannot be an HTTP question.
    onSpawn: serveProductIssueConsent,
  });
  return {
    adopted: false,
    stop: () => controller.stop(),
  };
}
