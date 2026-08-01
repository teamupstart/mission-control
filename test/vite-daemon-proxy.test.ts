import assert from "node:assert/strict";
import test from "node:test";
import type { Logger, LogErrorOptions } from "vite";

import {
  DaemonReporter,
  createDaemonProxy,
  isDaemonUnreachable,
  isSuppressedProxyLog,
  quietProxyLogger,
} from "../scripts/vite-daemon-proxy.ts";

const BACKEND = "http://127.0.0.1:7317";

function refused(): Error & { code: string } {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7317"), {
    code: "ECONNREFUSED",
  });
}

/** A reporter with a hand-cranked clock and a line buffer. */
function reporter(reminderMs = 15_000) {
  const lines: string[] = [];
  let clock = 1_000;
  const r = new DaemonReporter({
    backend: BACKEND,
    log: (line) => lines.push(line),
    reminderMs,
    now: () => clock,
  });
  return { r, lines, tick: (ms: number) => (clock += ms) };
}

test("a connect failure to the daemon is not a proxy fault", () => {
  assert.equal(isDaemonUnreachable(refused()), true);
  assert.equal(isDaemonUnreachable(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isDaemonUnreachable(Object.assign(new Error("nope"), { code: "EACCES" })), false);
  assert.equal(isDaemonUnreachable(new Error("no code at all")), false);
  assert.equal(isDaemonUnreachable(null), false);
  assert.equal(isDaemonUnreachable("ECONNREFUSED"), false);
});

test("only Vite's proxy log for an unreachable daemon is suppressed", () => {
  const opts: LogErrorOptions = { error: refused() };
  assert.equal(isSuppressedProxyLog("http proxy error: /api/away", opts), true);
  // A real proxy fault keeps its stack.
  assert.equal(
    isSuppressedProxyLog("http proxy error: /api/away", {
      error: Object.assign(new Error("bad gateway"), { code: "EPROTO" }),
    }),
    false,
  );
  // An unrelated error that happens to carry a connect code stays visible.
  assert.equal(isSuppressedProxyLog("Pre-transform error: ...", opts), false);
  assert.equal(isSuppressedProxyLog("http proxy error: /api/away"), false);
});

test("the first failure speaks and the burst behind it does not", () => {
  const { r, lines } = reporter();
  for (let i = 0; i < 20; i++) r.recordFailure();
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /is not answering/);
  assert.match(lines[0]!, new RegExp(BACKEND.replace(/[.]/g, "\\.")));
  assert.equal(r.down, true);
});

test("a daemon that stays down is mentioned again with a count", () => {
  const { r, lines, tick } = reporter(15_000);
  r.recordFailure();
  tick(14_999);
  r.recordFailure();
  assert.equal(lines.length, 1, "still inside the quiet window");
  tick(1);
  r.recordFailure();
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /still not answering - 2 more requests failed/);

  // The count is since the last line, not since the daemon went down.
  tick(15_000);
  r.recordFailure();
  assert.match(lines[2]!, /1 more request failed/);
});

test("recovery reports the whole outage and rearms", () => {
  const { r, lines } = reporter();
  r.recordFailure();
  r.recordFailure();
  r.recordSuccess();
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /is answering again - 2 requests failed while it was down/);
  assert.equal(r.down, false);

  // A second outage - a `tsx watch` restart - speaks again rather than staying quiet.
  r.recordFailure();
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /is not answering/);
  r.recordSuccess();
  assert.match(lines[3]!, /1 request failed while it was down/);
});

test("a healthy daemon says nothing at all", () => {
  const { r, lines } = reporter();
  for (let i = 0; i < 5; i++) r.recordSuccess();
  assert.deepEqual(lines, []);
  assert.equal(r.down, false);
});

/**
 * A Logger stub shaped like Vite's: `warn`/`error` flip `hasWarned` on the logger object
 * itself, which is what the wrapper has to keep visible.
 */
function baseLogger() {
  const errors: string[] = [];
  const infos: string[] = [];
  const logger = {
    info: (msg: string) => infos.push(msg),
    warn: () => {
      logger.hasWarned = true;
    },
    warnOnce: () => {
      logger.hasWarned = true;
    },
    error: (msg: string) => {
      logger.hasWarned = true;
      errors.push(msg);
    },
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
  return { logger: logger as unknown as Logger, errors, infos, raw: logger };
}

test("the wrapped logger drops the daemon's connect errors and keeps the rest", () => {
  const { logger, errors } = baseLogger();
  const quiet = quietProxyLogger(logger);

  quiet.error("http proxy error: /events", { error: refused() });
  assert.deepEqual(errors, []);

  quiet.error("Internal server error", { error: new Error("boom") });
  quiet.error("http proxy error: /api/away", {
    error: Object.assign(new Error("tls"), { code: "EPROTO" }),
  });
  assert.deepEqual(errors, ["Internal server error", "http proxy error: /api/away"]);
});

test("the wrapped logger reports the base's hasWarned rather than a stale copy", () => {
  const { logger, raw } = baseLogger();
  const quiet = quietProxyLogger(logger);
  assert.equal(quiet.hasWarned, false);

  quiet.warn("something worth saying");
  assert.equal(quiet.hasWarned, true, "a warning through the wrapper is visible on it");

  // Vite reads this off config.logger - the wrapper - after code elsewhere set it on the
  // base, and writes to the wrapper have to land somewhere the base can see too.
  raw.hasWarned = false;
  assert.equal(quiet.hasWarned, false);
  quiet.hasWarned = true;
  assert.equal(raw.hasWarned, true);
});

/** The minimum `http-proxy` surface `configure` touches. */
function fakeProxy() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const proxy = {
    on(event: string, fn: (...args: never[]) => void) {
      handlers.set(event, fn);
      return proxy;
    },
  };
  return {
    proxy,
    fail: (err: unknown, res: unknown) =>
      (handlers.get("error") as unknown as (e: unknown, r: unknown, s: unknown) => void)(
        err,
        {},
        res,
      ),
    respond: () => (handlers.get("proxyRes") as unknown as () => void)(),
  };
}

/** A ServerResponse stub that records the status line it was given. */
function fakeRes() {
  const res = {
    headersSent: false,
    writableEnded: false,
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body: string) {
      res.body = body;
      res.writableEnded = true;
      return res;
    },
  };
  return res;
}

test("an unreachable daemon answers 503 with a retry hint, not a bare 500", () => {
  const { logger, infos, errors } = baseLogger();
  const daemon = createDaemonProxy(BACKEND, logger);
  const { proxy, fail, respond } = fakeProxy();
  daemon.configure(proxy as never);

  const res = fakeRes();
  fail(refused(), res);
  assert.equal(res.status, 503);
  assert.equal(res.headers["Retry-After"], "1");
  assert.deepEqual(JSON.parse(res.body), { error: "daemon-unavailable", backend: BACKEND });
  assert.equal(infos.length, 1);
  assert.match(infos[0]!, /^daemon at .*is not answering/);

  // Vite's own log for that same failure is dropped; the reporter already covered it.
  daemon.logger.error("http proxy error: /api/away", { error: refused() });
  assert.deepEqual(errors, []);

  respond();
  assert.match(infos[1]!, /is answering again/);
});

test("a real proxy fault is left entirely to Vite", () => {
  const { logger, infos } = baseLogger();
  const daemon = createDaemonProxy(BACKEND, logger);
  const { proxy, fail } = fakeProxy();
  daemon.configure(proxy as never);

  const res = fakeRes();
  fail(Object.assign(new Error("socket hang up on purpose"), { code: "EPROTO" }), res);
  assert.equal(res.status, 0, "no response written - Vite's handler still owns it");
  assert.deepEqual(infos, []);
});

test("a response that already went out is not written twice", () => {
  const { logger } = baseLogger();
  const daemon = createDaemonProxy(BACKEND, logger);
  const { proxy, fail } = fakeProxy();
  daemon.configure(proxy as never);

  const res = fakeRes();
  res.headersSent = true;
  fail(refused(), res);
  assert.equal(res.status, 0);

  // A websocket upgrade hands a raw socket, which has no writeHead at all.
  assert.doesNotThrow(() => fail(refused(), { destroyed: false }));
});
