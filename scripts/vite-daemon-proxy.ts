// The dev proxy's answer to "the daemon isn't up yet".
//
// `npm run dev` starts Vite and the daemon at the same time, and Vite wins by a wide
// margin: it is serving on 5173 within a few hundred milliseconds while `tsx watch
// src/server/index.ts` is still loading the server. Every dashboard request that lands in
// that window - the fetch fan-out the app fires on load, plus the `/events` EventSource
// and each of its reconnects - is proxied to a port with nothing listening on it, and
// Vite's built-in proxy error handler prints a red three-line stack for every single one:
//
//   8:15:10 AM [vite] http proxy error: /api/foreman/status
//   Error: connect ECONNREFUSED 127.0.0.1:7317
//       at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1705:16)
//
// Dozens of those scroll past on a normal startup, and `tsx watch` reproduces the burst on
// every server edit because the restart drops the listener again. It reads like a broken
// install, and it buries any real error printed beside it.
//
// None of it is an error. It is one fact - the daemon is not answering yet - repeated once
// per request. So this module turns the repetition back into the state change it describes:
// one line when the daemon stops answering, a reminder with a count while it stays down (so
// a daemon that never comes up is still obvious), and one line when it answers again.
// Errors other than "the daemon refused the connection" keep Vite's full loud stack.
//
// Two halves, because Vite splits them:
//   - `configure` runs BEFORE Vite attaches its own `error` listener, so the handler here
//     sees the failure first, counts it, and answers the browser 503 instead of the bare
//     500 Vite would send. It cannot stop Vite from logging - Vite's listener logs
//     unconditionally, and it is attached afterwards.
//   - so the log is suppressed at the logger instead. Vite passes the original error to
//     `logger.error` as `options.error`, which is enough to tell a connect failure against
//     our own backend from every other proxy error.

import type { Logger, LogErrorOptions, ProxyOptions } from "vite";

/** The `http-proxy` server instance Vite hands to `ProxyOptions.configure`. */
type ProxyServer = Parameters<NonNullable<ProxyOptions["configure"]>>[0];

/**
 * The startup failure that means nothing is bound to the daemon port yet.
 *
 * `ECONNRESET` is deliberately excluded. It can come from an established connection that
 * the daemon aborted while remaining reachable, so Vite must keep that diagnostic loud.
 */
const DAEMON_NOT_LISTENING_CODE = "ECONNREFUSED";

/** The message prefix Vite logs for a failed proxied request. */
const PROXY_ERROR_PREFIX = "http proxy error";

/** True when this error is the daemon not answering rather than a real proxy fault. */
export function isDaemonNotListening(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === DAEMON_NOT_LISTENING_CODE;
}

/**
 * True when this is Vite's own log for a proxied request that failed because the daemon was
 * not answering - the line the reporter has already accounted for.
 *
 * Both halves matter. The message check keeps unrelated errors that happen to carry an
 * `ECONNREFUSED` code (a Vite plugin's own fetch, say) visible, and the code check keeps
 * every proxy error that is NOT a connect failure loud with its stack.
 */
export function isSuppressedProxyLog(msg: string, opts?: LogErrorOptions): boolean {
  return msg.includes(PROXY_ERROR_PREFIX) && isDaemonNotListening(opts?.error);
}

export interface DaemonReporterOptions {
  /** Base URL of the daemon, for the message. */
  backend: string;
  /** Where a line goes. */
  log: (line: string) => void;
  /** How long to stay quiet between reminders while the daemon is still down. */
  reminderMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Counts proxy failures and speaks only when the daemon's reachability changes - or when it
 * has been down long enough to be worth mentioning again.
 *
 * Shared across every proxied route (`/api` and `/events` are two `http-proxy` instances) so
 * a single startup produces a single line rather than one per route.
 */
export class DaemonReporter {
  readonly #backend: string;
  readonly #log: (line: string) => void;
  readonly #reminderMs: number;
  readonly #now: () => number;

  /** Whether the last thing we saw from the daemon was a failure. */
  #down = false;
  /** Failures since the daemon went down, for the recovery line. */
  #sinceDown = 0;
  /** Failures since the last line we printed, for the reminder line. */
  #sinceLog = 0;
  #lastLogAt = 0;

  constructor({ backend, log, reminderMs = 15_000, now = Date.now }: DaemonReporterOptions) {
    this.#backend = backend;
    this.#log = log;
    this.#reminderMs = reminderMs;
    this.#now = now;
  }

  /** Whether the daemon is currently believed to be unreachable. */
  get down(): boolean {
    return this.#down;
  }

  /** A proxied request could not reach the daemon. */
  recordFailure(): void {
    this.#sinceDown += 1;
    this.#sinceLog += 1;
    const at = this.#now();
    if (!this.#down) {
      this.#down = true;
      this.#emit(
        at,
        `daemon at ${this.#backend} is not answering - proxied requests fail until it is ` +
          `up (further failures are summarized)`,
      );
      return;
    }
    if (at - this.#lastLogAt >= this.#reminderMs) {
      const n = this.#sinceLog;
      this.#emit(
        at,
        `daemon at ${this.#backend} is still not answering - ${n} more ${plural(n, "request")} failed`,
      );
    }
  }

  /** A proxied request reached the daemon and came back. */
  recordSuccess(): void {
    if (!this.#down) return;
    const n = this.#sinceDown;
    this.#down = false;
    this.#sinceDown = 0;
    this.#emit(
      this.#now(),
      `daemon at ${this.#backend} is answering again - ${n} ${plural(n, "request")} failed while it was down`,
    );
  }

  #emit(at: number, line: string): void {
    this.#lastLogAt = at;
    this.#sinceLog = 0;
    this.#log(line);
  }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * Install a filter on Vite's resolved logger so proxy errors the reporter already owns stop
 * printing, and everything else passes through untouched.
 *
 * `hasErrorLogged` is deliberately not fed by the dropped calls: a daemon that has not
 * finished booting is not an error state Vite should remember.
 */
export function quietProxyLogger(base: Logger): Logger {
  const error = base.error;
  base.error = function quietProxyError(msg: string, opts?: LogErrorOptions) {
    if (isSuppressedProxyLog(msg, opts)) return;
    error.call(base, msg, opts);
  };
  return base;
}

/**
 * Everything `vite.config.ts` needs: the `configure` hook to hand each proxied route, and
 * an installer that filters the logger after Vite has applied `logLevel` and CLI options.
 */
export function createDaemonProxy(backend: string): {
  configure: (proxy: ProxyServer) => void;
  installLogger: (logger: Logger) => void;
} {
  let logger: Logger | undefined;
  const reporter = new DaemonReporter({
    backend,
    // Vite's own `[vite]` tag prefixes this, so the line reads
    // "8:15:10 AM [vite] daemon at http://127.0.0.1:7317 is not answering - ...".
    log: (line) => logger?.info(line, { timestamp: true }),
  });

  return {
    installLogger(base) {
      logger = quietProxyLogger(base);
    },
    configure(proxy) {
      proxy.on("error", (err, _req, res) => {
        if (!isDaemonNotListening(err)) return;
        reporter.recordFailure();
        // Answer the browser ourselves so it gets an accurate 503 with a retry hint rather
        // than the bare 500 Vite's handler would write. Vite's handler skips a response
        // that has already been ended, so this is the only write.
        if (res && "writeHead" in res && !res.headersSent && !res.writableEnded) {
          res
            .writeHead(503, { "Content-Type": "application/json", "Retry-After": "1" })
            .end(JSON.stringify({ error: "daemon-unavailable", backend }));
        }
      });
      proxy.on("proxyRes", () => reporter.recordSuccess());
    },
  };
}
