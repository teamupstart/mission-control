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
import { bothAttempts } from "../src/server/worktrees/observation-retry.ts";

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

/** The retry's 2 s wait, skipped. */
const noPause = async () => {};

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
    pause: noPause,
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20, and again on retry",
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
    pause: noPause,
  });
  assert.deepEqual(processFailure.get(one), { status: "unknown", reason: "ps timed out, and again on retry" });

  const cwdFailure = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map(), unknownReason: "lsof failed" }),
    pause: noPause,
  });
  assert.deepEqual(cwdFailure.get(one), { status: "unknown", reason: "lsof failed, and again on retry" });
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

test("an omitted PID that the fresh snapshot shows exiting as a zombie is not left unresolved", async () => {
  // Caught mid-exit: ps lists it, its cwd is already gone so the cwd reader omits it, and the
  // confirming ps lists it again - same start time, now a zombie and therefore out of scope.
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20)],
        unknownReason: null,
        cwdScopePids: processReads === 1 ? [10, 20] : [10],
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

test("an omitted PID that is still live and in scope keeps occupancy unknown", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
    pause: noPause,
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20, and again on retry",
  });
});

test("this daemon's running worktree Git and its helpers are never occupants, and are not cwd-read", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20), process(30, 20)],
      unknownReason: null,
      cwdScopePids: [10, 20, 30],
      completedCollectorPids: [],
    }),
    ownProcesses: () => new Set([20]),
    readCwds: async (pids) => {
      assert.deepEqual(pids, [10], "our Git (20) and its helper (30) are excluded before the cwd read");
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10], "a foreign process in the slot still counts");
  }
});

// AC3: under load a batched `lsof` drops a PID it answers for when asked alone, and one such
// omission used to make the whole pass unknown for every slot.
test("a PID omitted by the cwd listing is re-read alone, and resolving it keeps occupancy known", async () => {
  const { one, ten, nested } = fixture();
  const cwdReads: number[][] = [];
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one, ten], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20), process(30)],
        unknownReason: null,
        cwdScopePids: [10, 20, 30],
        completedCollectorPids: [],
      };
    },
    readCwds: async (pids) => {
      cwdReads.push(pids);
      // The batch omits 20; asked alone, it answers.
      if (pids.length > 1) return { cwds: new Map([[10, nested], [30, ten]]), unknownReason: null };
      return { cwds: new Map(pids.includes(20) ? [[20, one]] : []), unknownReason: null };
    },
    pause: async () => assert.fail("a resolved PID needs no retry"),
  });
  assert.deepEqual(cwdReads, [[10, 20, 30], [20]], "only the omitted PID is re-read, on its own");
  assert.equal(processReads, 1, "nothing stayed unresolved, so no disappearance check ran");
  assert.deepEqual(
    [...result].map(([target, occupancy]) => [
      target,
      occupancy.status === "known" ? occupancy.occupants.map((entry) => entry.pid) : occupancy.reason,
    ]),
    [[one, [10, 20]], [ten, [30]]],
  );
});

test("a re-read PID that is still unresolved and alive with the same start time is unknown", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      cwdReads.push(pids);
      return { cwds: new Map(pids.includes(10) ? [[10, one]] : []), unknownReason: null };
    },
    pause: noPause,
  });
  assert.deepEqual(cwdReads, [[10, 20], [20], [10, 20], [20]], "each attempt re-reads 20 alone");
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20, and again on retry",
  });
});

// AC2, first half: a failed listing that answers on its retry changes nothing.
test("a listing that fails once and then succeeds is known, after one 2 s pause and doubled timeouts", async () => {
  const { one } = fixture();
  const pauses: number[] = [];
  const listings: Array<number | undefined> = [];
  const cwdReads: Array<number | undefined> = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async (options) => {
      listings.push(options?.timeoutScale);
      return listings.length === 1
        ? {
            processes: [],
            unknownReason: "process listing failed: the process listing timed out after 4 s",
            cwdScopePids: [],
            completedCollectorPids: [],
          }
        : {
            processes: [process(10)],
            unknownReason: null,
            cwdScopePids: [10],
            completedCollectorPids: [],
          };
    },
    readCwds: async (_pids, options) => {
      cwdReads.push(options?.timeoutScale);
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  });
  assert.deepEqual(pauses, [2_000]);
  assert.deepEqual(listings, [undefined, 2], "the retry runs with double the timeout");
  assert.deepEqual(cwdReads, [2]);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
});

test("a listing that times out twice names both attempts", async () => {
  const { one } = fixture();
  let attempt = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [],
      unknownReason: `process listing failed: the process listing timed out after ${++attempt === 1 ? 4 : 8} s`,
      cwdScopePids: [],
      completedCollectorPids: [],
    }),
    pause: noPause,
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "process listing failed: the process listing timed out after 4 s, and after 8 s on retry",
  });
});

test("a re-read that throws leaves the PID to the disappearance check, not a failed pass", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      // The confirmation snapshot shows 20 gone.
      return processReads === 1
        ? { processes: [process(10), process(20)], unknownReason: null, cwdScopePids: [10, 20], completedCollectorPids: [] }
        : { processes: [process(10)], unknownReason: null, cwdScopePids: [10], completedCollectorPids: [] };
    },
    readCwds: async (pids) => {
      cwdReads.push(pids);
      if (pids.length === 1) throw new Error("lsof could not be spawned");
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
    pause: async () => assert.fail("the disappearance check resolved it, so nothing is retried"),
  });
  assert.deepEqual(cwdReads, [[10, 20], [20]]);
  assert.equal(processReads, 2);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
});

test("only the first eight omitted PIDs are re-read alone; the rest stay unresolved", async () => {
  const { one } = fixture();
  const omitted = [21, 22, 23, 24, 25, 26, 27, 28, 29];
  const all = [10, ...omitted];
  const cwdReads: number[][] = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: all.map((pid) => process(pid)),
      unknownReason: null,
      cwdScopePids: all,
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      cwdReads.push(pids);
      // The batch omits every PID but 10; asked alone, each would answer.
      return pids.length > 1
        ? { cwds: new Map([[10, one]]), unknownReason: null }
        : { cwds: new Map([[pids[0]!, one]]), unknownReason: null };
    },
    pause: noPause,
  });
  assert.deepEqual(
    cwdReads.slice(0, 9),
    [all, ...omitted.slice(0, 8).map((pid) => [pid])],
    "the ninth omitted PID is never read alone",
  );
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 29, and again on retry",
  });
});

test("a read that fails twice names both attempts", () => {
  assert.equal(
    bothAttempts("git status timed out after 15 s", "git status timed out after 30 s"),
    "git status timed out after 15 s, and after 30 s on retry",
  );
  assert.equal(bothAttempts("lsof failed", "lsof failed"), "lsof failed, and again on retry");
  assert.equal(
    bothAttempts("git status timed out after 15 s", "git status failed: fatal: index file corrupt"),
    "git status timed out after 15 s, and on retry git status failed: fatal: index file corrupt",
  );
  // Two different steps that both timed out are not folded into one.
  assert.equal(
    bothAttempts("git status timed out after 15 s", "git rev-parse HEAD timed out after 30 s"),
    "git status timed out after 15 s, and on retry git rev-parse HEAD timed out after 30 s",
  );
});

test("the re-reads stop at the first one that did not answer, so an attempt spends one timeout on them", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20), process(30)],
      unknownReason: null,
      cwdScopePids: [10, 20, 30],
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      cwdReads.push(pids);
      return pids.length > 1
        ? { cwds: new Map([[10, one]]), unknownReason: null }
        : {
            cwds: new Map(),
            unknownReason: "cwd listing failed: the cwd listing timed out after 30 s",
            unanswered: true,
          };
    },
    pause: noPause,
  });
  assert.deepEqual(cwdReads, [[10, 20, 30], [20], [10, 20, 30], [20]], "30 is never re-read after 20 timed out");
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 2 ps-listed PIDs: 20, 30, and again on retry",
  });
});

test("a listing too large to buffer is not retried, because asking again cannot shrink it", async () => {
  const { one } = fixture();
  const ps = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [],
      unknownReason: "process listing failed: the process listing was too large to buffer",
      overflowed: true,
      cwdScopePids: [],
      completedCollectorPids: [],
    }),
    pause: async () => assert.fail("an overflow is not retried"),
  });
  assert.deepEqual(ps.get(one), {
    status: "unknown",
    reason: "process listing failed: the process listing was too large to buffer",
  });

  let cwdReads = 0;
  const lsof = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async () => {
      cwdReads++;
      return { cwds: new Map(), unknownReason: "cwd listing failed: the cwd listing was too large to buffer", overflowed: true };
    },
    pause: async () => assert.fail("an overflow is not retried"),
  });
  assert.equal(cwdReads, 1);
  assert.deepEqual(lsof.get(one), {
    status: "unknown",
    reason: "cwd listing failed: the cwd listing was too large to buffer",
  });
});
