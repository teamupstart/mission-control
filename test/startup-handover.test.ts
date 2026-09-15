import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  decideStartup,
  openInstalledApp,
  runningBundlePath,
  startPackagedShell,
  type HandoverAttempt,
  type OpenResult,
  type StartupPorts,
} from "../src/main/startup-handover.ts";
import { FIXED_OS_EXECUTABLES } from "../src/server/executables/catalog.ts";
import type { InstallIdentity } from "../src/main/install-identity.ts";
import type { InstallReceipt } from "../src/shared/install-receipt-schema.mjs";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";

const PERSONAL = "/Users/someone/Applications/Mission Control.app";

const receipt: InstallReceipt = {
  schema: 1,
  repo: CANONICAL_REPO,
  releaseTag: "v1.2.3",
  installedVersion: "1.2.3",
  installedCommit: "a".repeat(40),
  sourceClone: "/Users/someone/.mission-control/app-src",
  appPath: PERSONAL,
  installedAt: "2026-09-14T00:00:00.000Z",
};

/**
 * The shell's side of startup, recorded rather than performed.
 *
 * Every port is watched, because the thing worth asserting is not only what was decided but
 * what was DONE and in which order: a hand-over that also asked for the lock, or one that
 * started a daemon anyway, would satisfy any assertion about the return value alone.
 */
function ports(
  identity: InstallIdentity,
  over: { open?: HandoverAttempt; lock?: boolean } = {},
) {
  const calls: string[] = [];
  const opened: string[] = [];
  const logs: string[] = [];
  const port: StartupPorts = {
    identity: () => {
      calls.push("identity");
      return identity;
    },
    open: (target) => {
      calls.push("open");
      opened.push(target);
      return over.open ?? { ok: true, detail: null };
    },
    requestSingleInstanceLock: () => {
      calls.push("requestSingleInstanceLock");
      return over.lock ?? true;
    },
    exit: (code) => calls.push(`exit(${code})`),
    quit: () => calls.push("quit"),
    log: (line) => logs.push(line),
  };
  return { port, calls, opened, logs };
}

test("the running bundle is the app three directories above the packaged app root", () => {
  // `app.getAppPath()` is `<bundle>/Contents/Resources/app` in a packaged build. Getting this
  // derivation wrong would compare the receipt against a path that is not a bundle at all, and
  // every identity answer after it would be drawn from the wrong subject.
  assert.equal(
    runningBundlePath("/Applications/Mission Control.app/Contents/Resources/app", true),
    "/Applications/Mission Control.app",
  );
  assert.equal(
    runningBundlePath(join(PERSONAL, "Contents", "Resources", "app"), true),
    PERSONAL,
  );
  // Development is a checkout, not a bundle, so there is no installed identity to compare.
  assert.equal(runningBundlePath("/work/mission-control", false), null);
});

test("a redirect opens the exact personal bundle and this process starts nothing", () => {
  // The consequence, not just the classification. `install-identity.ts` can only say the answer
  // SHOULD be redirect; this is the only place that proves the shell acts on it.
  const { port, calls, opened } = ports({ state: "redirect", target: PERSONAL, receipt });
  const decision = decideStartup(port);

  assert.deepEqual(opened, [PERSONAL], "exactly the validated personal bundle, and only it");
  assert.equal(decision.handedOver, true);
  // The whole point: no window, no daemon, no updater.
  assert.equal(decision.proceed, false);
  // And the lock was never asked for. The app just opened would lose it, quit, and hand the
  // person straight back to the copy they were being moved off.
  assert.ok(!calls.includes("requestSingleInstanceLock"));
  assert.deepEqual(calls, ["identity", "open", "exit(0)", "quit"]);
  // The source copy may not update anything either, in case `exit` did not end it.
  assert.match(decision.updateBlock ?? "", /installed at .*Applications\/Mission Control\.app/);
});

test("a hand-over that fails keeps this copy running, with updates disabled and a reason", () => {
  // Not fatal, on purpose: the alternative is leaving somebody with no Mission Control at all.
  const { port, calls, logs, opened } = ports(
    { state: "redirect", target: PERSONAL, receipt },
    { open: { ok: false, detail: "kLSNoExecutableErr" } },
  );
  const decision = decideStartup(port);

  assert.deepEqual(opened, [PERSONAL]);
  assert.equal(decision.handedOver, false);
  // It carries on as an ordinary launch: the lock IS requested, and it may start.
  assert.ok(calls.includes("requestSingleInstanceLock"));
  assert.equal(decision.proceed, true);
  assert.ok(!calls.some((call) => call.startsWith("exit")));
  // The updater still stands down, because the only bundle it could update is not this one.
  assert.match(decision.updateBlock ?? "", /Updates are disabled/);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /could not open the installed app at/);
  assert.match(logs[0]!, /kLSNoExecutableErr/);
});

test("an ordinary managed launch opens nothing and proceeds with the updater on", () => {
  const { port, calls, opened } = ports({ state: "managed", receipt });
  const decision = decideStartup(port);

  assert.deepEqual(opened, [], "nothing may be launched for an app that is the installed one");
  assert.deepEqual(calls, ["identity", "requestSingleInstanceLock"]);
  assert.equal(decision.handedOver, false);
  assert.equal(decision.proceed, true);
  assert.equal(decision.updateBlock, null);
});

test("a mismatched copy runs, launches nothing, and refuses to update another bundle", () => {
  const { port, opened } = ports({
    state: "mismatched",
    reason: "Updates are disabled because this copy of Mission Control is at /opt/Mission Control.app.",
    receipt,
  });
  const decision = decideStartup(port);

  // A mismatch is emphatically not a licence to open whatever the receipt names.
  assert.deepEqual(opened, []);
  assert.equal(decision.handedOver, false);
  assert.equal(decision.proceed, true);
  assert.match(decision.updateBlock ?? "", /this copy of Mission Control is at/);
});

test("an unmanaged launch is untouched by any of this", () => {
  const { port, calls, opened } = ports({ state: "unmanaged" });
  const decision = decideStartup(port);

  assert.deepEqual(opened, []);
  assert.deepEqual(calls, ["identity", "requestSingleInstanceLock"]);
  assert.equal(decision.proceed, true);
  assert.equal(decision.updateBlock, null);
});

test("losing the single-instance lock quits and starts nothing, as it always did", () => {
  // The pre-existing second-launch path, pinned here because the hand-over now shares it.
  const { port, calls } = ports({ state: "managed", receipt }, { lock: false });
  const decision = decideStartup(port);

  assert.deepEqual(calls, ["identity", "requestSingleInstanceLock", "quit"]);
  assert.equal(decision.handedOver, false);
  assert.equal(decision.proceed, false);
});

/**
 * Electron's `app`, recorded rather than performed, plus the one subprocess this path runs.
 *
 * Only these two are faked. Everything between them - the ports object, the executable, the
 * argv, the result mapping - is the production wiring, which is the part the seam tests above
 * cannot reach: they inject an `open` port and so would pass even if the entry point never
 * connected one, or connected it to the wrong command.
 */
function shell(identity: InstallIdentity, over: { open?: OpenResult; lock?: boolean } = {}) {
  const calls: string[] = [];
  const spawned: Array<{ executable: string; args: string[] }> = [];
  const logs: string[] = [];
  const decision = startPackagedShell({
    app: {
      requestSingleInstanceLock: () => {
        calls.push("requestSingleInstanceLock");
        return over.lock ?? true;
      },
      exit: (code) => calls.push(`exit(${code})`),
      quit: () => calls.push("quit"),
    },
    identity: () => identity,
    log: (line) => logs.push(line),
    run: (executable, args) => {
      calls.push("run");
      spawned.push({ executable, args });
      return over.open ?? { status: 0 };
    },
  });
  return { decision, calls, spawned, logs };
}

test("the wired shell runs /usr/bin/open with exactly the validated bundle, and nothing else", () => {
  // The integration the seam tests cannot make: a production `open` port that was never
  // connected, or connected to the wrong executable, still satisfies every assertion made
  // against an injected one. Here only Electron's `app` and the subprocess runner are faked.
  const { decision, calls, spawned } = shell({ state: "redirect", target: PERSONAL, receipt });

  assert.deepEqual(spawned, [{ executable: "/usr/bin/open", args: [PERSONAL] }]);
  // The absolute catalog path, not a bare name resolved against a PATH that does not exist yet.
  assert.equal(spawned[0]!.executable, FIXED_OS_EXECUTABLES.open);
  assert.equal(decision.handedOver, true);
  assert.equal(decision.proceed, false);
  assert.deepEqual(calls, ["run", "exit(0)", "quit"]);
  assert.ok(!calls.includes("requestSingleInstanceLock"));
});

test("the wired shell reads a non-zero open as a failed hand-over and carries on", () => {
  const { decision, calls, logs, spawned } = shell(
    { state: "redirect", target: PERSONAL, receipt },
    { open: { status: 1, stderr: "The application cannot be opened.\n" } },
  );

  assert.deepEqual(spawned, [{ executable: "/usr/bin/open", args: [PERSONAL] }]);
  assert.equal(decision.handedOver, false);
  assert.equal(decision.proceed, true, "a failed hand-over must not leave someone with no app");
  assert.ok(calls.includes("requestSingleInstanceLock"));
  assert.match(decision.updateBlock ?? "", /Updates are disabled/);
  // The reason reaches a log rather than being swallowed, trimmed of the trailing newline.
  assert.match(logs[0]!, /The application cannot be opened\./);
});

test("the wired shell reads a spawn error as a failed hand-over", () => {
  // `spawnSync` reports a missing binary or a timeout through `error`, not through `status`.
  const { decision, logs } = shell(
    { state: "redirect", target: PERSONAL, receipt },
    { open: { status: null, error: new Error("spawnSync /usr/bin/open ETIMEDOUT") } },
  );

  assert.equal(decision.handedOver, false);
  assert.equal(decision.proceed, true);
  assert.match(logs[0]!, /ETIMEDOUT/);
});

test("the wired shell launches nothing at all for an ordinary managed app", () => {
  const { decision, calls, spawned } = shell({ state: "managed", receipt });

  assert.deepEqual(spawned, [], "a matching app must never invoke Launch Services");
  assert.deepEqual(calls, ["requestSingleInstanceLock"]);
  assert.equal(decision.proceed, true);
  assert.equal(decision.updateBlock, null);
});

test("the real Launch Services call reports a bundle that is not there, without launching it", () => {
  // The production default runner, against the real `/usr/bin/open`. Nothing is launched: the
  // path does not exist, which is exactly why it is safe to run here and still proves the
  // executable, the argument, and the failure mapping are what the rest of this file assumes.
  const missing = "/private/tmp/mission-control-absent-fixture/Nowhere.app";
  const attempt = openInstalledApp(missing);

  assert.equal(attempt.ok, false);
  assert.ok(attempt.detail, "a failure has to carry something a person can act on");
  assert.match(String(attempt.detail), /Nowhere\.app|does not exist|Unable to find/i);
});
