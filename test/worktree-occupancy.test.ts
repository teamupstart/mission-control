import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Proc } from "../src/server/discovery/processes.ts";
import {
  inspectWorktreeOccupancy,
  pathContains,
} from "../src/server/worktrees/occupancy.ts";

function process(pid: number, ppid = 1): Proc {
  return {
    pid,
    ppid,
    tty: null,
    startRaw: `start-${pid}`,
    startMs: pid * 1000,
    command: `node worker-${pid}.mjs`,
    agent: null,
    agentNative: false,
  };
}

function fixture(): { root: string; one: string; ten: string; nested: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-worktree-occupancy-")));
  const one = join(root, "1", "repo");
  const ten = join(root, "10", "repo");
  const nested = join(one, "packages", "app");
  mkdirSync(nested, { recursive: true });
  mkdirSync(ten, { recursive: true });
  return { root, one, ten, nested };
}

test("path containment is segment-aware", () => {
  const { one, ten, nested } = fixture();
  assert.equal(pathContains(one, one), true);
  assert.equal(pathContains(one, nested), true);
  assert.equal(pathContains(one, ten), false, "slot 1 must not contain slot 10");
});

test("occupancy batches one process read and one cwd read across every target", async () => {
  const { one, ten, nested } = fixture();
  let processReads = 0;
  let cwdReads = 0;
  const result = await inspectWorktreeOccupancy([one, ten], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20)],
        unknownReason: null,
        cwdScopePids: [10, 20],
        completedCollectorPids: [],
      };
    },
    readCwds: async (pids) => {
      cwdReads++;
      assert.deepEqual(pids, [10, 20]);
      return { cwds: new Map([[10, nested], [20, ten]]), unknownReason: null };
    },
    knownOwner: (proc) => (proc.pid === 10 ? "terminal:session-1" : null),
  });

  assert.equal(processReads, 1);
  assert.equal(cwdReads, 1);
  const inOne = result.get(one)!;
  assert.equal(inOne.status, "known");
  if (inOne.status === "known") {
    assert.deepEqual(inOne.occupants.map((one) => [one.pid, one.knownOwner]), [
      [10, "terminal:session-1"],
    ]);
  }
  const inTen = result.get(ten)!;
  assert.equal(inTen.status, "known");
  if (inTen.status === "known") assert.deepEqual(inTen.occupants.map((one) => one.pid), [20]);
});

test("a ps-listed PID omitted by a partial cwd result makes occupancy unknown", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    // The cwd reader cannot prove whether PID 20 vanished or was merely omitted.
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20",
  });
});

test("a completed ps collector is excluded from cwd completeness", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [20],
    }),
    readCwds: async (pids) => {
      assert.deepEqual(pids, [10]);
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("a process outside the daemon user scope is not sent to cwd inspection", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      assert.deepEqual(pids, [10]);
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("an omitted PID is ignored only after a fresh snapshot proves it disappeared", async () => {
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return processReads === 1
        ? {
            processes: [process(10), process(20)],
            unknownReason: null,
            cwdScopePids: [10, 20],
            completedCollectorPids: [],
          }
        : {
            processes: [process(10)],
            unknownReason: null,
            cwdScopePids: [10],
            completedCollectorPids: [],
          };
    },
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
  });
  assert.equal(processReads, 2);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("a failed or timed-out process read is unknown, never empty", async () => {
  const { one } = fixture();
  const processFailure = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [],
      unknownReason: "ps timed out",
      cwdScopePids: [],
      completedCollectorPids: [],
    }),
  });
  assert.deepEqual(processFailure.get(one), { status: "unknown", reason: "ps timed out" });

  const cwdFailure = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map(), unknownReason: "lsof failed" }),
  });
  assert.deepEqual(cwdFailure.get(one), { status: "unknown", reason: "lsof failed" });
});

test("a failed cwd read is empty only after every original process is proven gone", async () => {
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return processReads === 1
        ? {
            processes: [process(10)],
            unknownReason: null,
            cwdScopePids: [10],
            completedCollectorPids: [],
          }
        : {
            processes: [],
            unknownReason: null,
            cwdScopePids: [],
            completedCollectorPids: [],
          };
    },
    readCwds: async () => ({ cwds: new Map(), unknownReason: "cwd listing failed: exit 1" }),
  });
  assert.equal(processReads, 2);
  assert.deepEqual(result.get(one), { status: "known", occupants: [] });
});

test("an oversized occupancy request fails closed without spawning system reads", async () => {
  let processReads = 0;
  const paths = Array.from({ length: 257 }, (_, index) => `/tmp/native-slot-${index}`);
  const result = await inspectWorktreeOccupancy(paths, {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [],
        unknownReason: null,
        cwdScopePids: [],
        completedCollectorPids: [],
      };
    },
  });
  assert.equal(processReads, 0);
  assert.equal(result.size, 257);
  assert.deepEqual(result.get(paths[0]!), {
    status: "unknown",
    reason: "occupancy query exceeds 256 paths",
  });
});
