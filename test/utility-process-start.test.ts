import assert from "node:assert/strict";
import test from "node:test";
import {
  forkAndInitializeUtilityProcess,
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
