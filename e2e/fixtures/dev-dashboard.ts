// The dashboard as a DEVELOPER runs it: Vite serving `src/web` with React's development
// build, proxying `/api` and `/events` at this test's isolated daemon.
//
// Every other spec in this suite drives `dist/`, and that is the right default - it is what
// an installed Mission Control serves. But it is not what the operator running `make start`
// or `make restart` looks at, and the two builds do not agree about one thing that matters:
// `StrictMode` double-invokes mount effects in development ONLY. A cleanup that arms
// something on the way out therefore runs on the way IN there, and a hook that never re-arms
// it is broken for the whole life of the component - in the build the person developing this
// app uses, and in no other.
//
// That is not a hypothetical. It made the file-comment composer impossible to type into on
// both of its surfaces (`src/web/lib/fileCommentDraft.ts`), while the production suite stayed
// green - partly because production has no double-invoke, and partly because `fill()` sets a
// value without pressing a key, so a composer whose React state never advances still ends up
// holding the text a spec asked for. A real keystroke is what tells those apart.
//
// So this fixture exists for the small number of specs that need to assert the DEV build's
// behavior. It is deliberately not the default: it costs a second Node process and Vite's
// first-request transform of the app, and reading `dist/` is what the shipped artifact is.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { freeLoopbackPort, type DaemonHandle } from "./daemon.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface DevDashboardHandle {
  /** Origin to navigate to, e.g. `http://127.0.0.1:53219`. */
  origin: string;
  /** Everything Vite has written, which is the only view of a dev-server failure a spec has. */
  readLog(): string;
  stop(): void;
}

/**
 * Boot a Vite dev server in front of `daemon`, and wait until it actually serves the app.
 *
 * `MISSION_PORT` is how the proxy is aimed: `vite.config.ts` reads it through
 * `harness-runtime.mjs` to decide where `/api` and `/events` go, so a dev server started
 * without it would proxy at the operator's own daemon on 7317 - dispatching sessions into
 * their real fleet from a test. `MISSION_HOME` is passed for the same reason in the other
 * direction: nothing here opens the database, and this keeps that true by construction.
 */
export async function startDevDashboard(daemon: DaemonHandle): Promise<DevDashboardHandle> {
  const port = await freeLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  let log = "";

  // Node running Vite's own entry, not `npx vite`: an `npx` wrapper is a process whose child
  // holds the port, so killing what we spawned left the server - and the port - behind for
  // the next run. `detached` puts Vite and the esbuild service it spawns in one process
  // group, which is what `stop()` signals.
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules/vite/bin/vite.js"),
      "--config", "vite.config.ts",
      "--host", "127.0.0.1",
      "--port", String(port),
      // Refuse a fallback port rather than serve from one this handle does not name.
      "--strictPort",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MISSION_PORT: String(new URL(daemon.baseURL).port),
        MISSION_HOME: daemon.home,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));

  let exited: { code: number | null; signal: string | null } | null = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const stop = (): void => {
    if (!child.pid) return;
    try {
      // The GROUP, negated - see `detached` above.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, which is the same end state.
    }
  };

  // Fetched rather than TCP-probed. A listening socket is not a served application: Vite
  // binds before its first transform, and a spec that navigated in that window would read
  // an empty document as "the dashboard did not load".
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) {
      stop();
      throw new Error(`the dev dashboard exited before it served anything:\n${log}`);
    }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
      // The dev entry module, which is the one line of `src/web/index.html` that says this
      // is the development document rather than a proxied error page.
      if (response.ok && (await response.text()).includes("main.tsx")) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`the dev dashboard never served ${origin}:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { origin, readLog: () => log, stop };
}
