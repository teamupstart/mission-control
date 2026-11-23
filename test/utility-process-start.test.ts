import assert from "node:assert/strict";
import test from "node:test";
import {
  forkAndInitializeUtilityProcess,
  stopChild,
  UtilityProcessInitializationError,
} from "../src/main/utility-process-start.ts";

test("a failed post-fork hook kills the child before the supervisor may retry", () => {
  const failure = new Error("post-fork setup failed");
  let kills = 0;
  const child = {
    kill() {
      kills += 1;
      return true;
    },
  };

  assert.throws(
    () =>
      forkAndInitializeUtilityProcess(
        () => child,
        () => {
          throw failure;
        },
      ),
    (err) => {
      assert.ok(err instanceof UtilityProcessInitializationError);
      assert.equal(err.child, child);
      assert.equal(err.cause, failure);
      return true;
    },
  );
  assert.equal(kills, 1, "the forked process must not survive its failed initialization");
});

test("a successful post-fork hook returns the owned child without killing it", () => {
  let initialized = 0;
  let kills = 0;
  const child = {
    kill() {
      kills += 1;
      return true;
    },
  };

  assert.equal(
    forkAndInitializeUtilityProcess(
      () => child,
      () => {
        initialized += 1;
      },
    ),
    child,
  );
  assert.equal(initialized, 1);
  assert.equal(kills, 0);
});

test("stopping a utility process sends only SIGTERM, never Electron's two-second kill", () => {
  // `UtilityProcess.kill()` escalates to SIGKILL about two seconds later, which cut the daemon's
  // shutdown short before it reached the workflow-check teardown.
  const signals: Array<[number, string]> = [];
  let kills = 0;
  stopChild({ pid: 4242, kill: () => { kills += 1; return true; } }, (pid, signal) => { signals.push([pid, signal]); });
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.equal(kills, 0);
});

test("a child with no pid, or one that cannot be signalled, still falls back to Electron's kill", () => {
  let kills = 0;
  const child = { kill: () => { kills += 1; return true; } };
  stopChild(child, () => { throw new Error("must not signal without a pid"); });
  stopChild({ ...child, pid: 4242 }, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  stopChild(null);
  assert.equal(kills, 2);
});
