import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  decideStartup,
  runningBundlePath,
  type HandoverAttempt,
  type StartupPorts,
} from "../src/main/startup-handover.ts";
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
