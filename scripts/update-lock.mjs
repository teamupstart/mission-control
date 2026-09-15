import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The one helper allowed to be updating at a time.
 *
 * `UpdateController.applyPromise` only ever guarded one app PROCESS, and this helper's whole
 * job is to outlive that process: it waits for the app to quit, works, and relaunches it. The
 * relaunched app reads `update-outcome.json`, offers Retry, and a second helper starts against
 * the same updater-owned clone as the first. That is not hypothetical - it is what the failing
 * logs show, twice over: `npm error ENOTEMPTY: directory not empty, rmdir` from two `npm ci`
 * runs in one clone, and four administrator panels inside a minute, of which the person could
 * only ever answer one. A second helper also writes its own `in-progress` over the first
 * helper's finished outcome, which is what turns a reported failure back into "the previous
 * update did not finish".
 *
 * Held as a directory of per-helper claim entries rather than as one shared lock file, and that
 * shape is the point. Two attempts at a single shared name both foundered on the same thing: a
 * contender deciding a lock was abandoned, then acting on that decision a moment later, by which
 * time it might be acting on a DIFFERENT, live helper's lock. Deleting outright let two helpers
 * both claim; taking-then-verifying moved the window rather than closing it, because taking a
 * live lock aside is itself destructive and putting it back can overwrite a third helper.
 *
 * Here, no contender ever writes or removes a name another live helper owns. Each helper creates
 * exactly one entry named after its own identity, and the holder is decided by reading the
 * directory - a decision that needs no mutation at all. The only entries anyone deletes are their
 * own, and those belonging to a process proven gone, which is safe precisely because the entry
 * name pins whose it is. There is no shared mutable name left to race over, and no timeout to
 * tune.
 */
export const HELPER_LOCK_DIR_NAME = "update-helper.lock.d";

/** Ordering key for a claim entry: earliest wins, pid settles a same-millisecond tie. */
export function claimPrecedes(a, b) {
  return a.createdAtMs !== b.createdAtMs ? a.createdAtMs < b.createdAtMs : a.pid < b.pid;
}

export function claimEntryName({ createdAtMs, pid }) {
  return `${String(createdAtMs).padStart(15, "0")}-${pid}.claim`;
}

export function parseClaimEntryName(name) {
  const match = /^(\d{15})-(\d+)\.claim$/.exec(name);
  if (!match) return null;
  return { createdAtMs: Number(match[1]), pid: Number(match[2]), name };
}

/** The staging name an entry is written under before being renamed into place. */
export function stagingEntryName(pid, createdAtMs) {
  return `.tmp-${pid}-${createdAtMs}`;
}

/**
 * The pid that owns a staging file, or null when the name is not one.
 *
 * A helper killed between writing its staging file and renaming it into place leaves that file
 * behind. It is never mistaken for a claim - the name cannot match the claim pattern - but
 * without this it would sit in the state directory forever, one per killed helper.
 */
export function parseStagingEntryName(name) {
  const match = /^\.tmp-(\d+)-(\d+)$/.exec(name);
  return match ? { pid: Number(match[1]), name } : null;
}

/**
 * Whether `pid` still names a live process, for deciding if a lock is stale.
 *
 * EPERM means it is alive and owned by somebody else, which is still alive. Only ESRCH is
 * evidence of absence, so an unexpected error reads as "assume alive" - refusing to start
 * costs one deferred update, while wrongly stealing a live lock costs the collision this
 * whole mechanism exists to prevent.
 */
export function processIsAlive(pid, kill = (target) => process.kill(target, 0)) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    kill(pid);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * What makes a pid an identity rather than a coincidence: its start time AND its command.
 *
 * A pid on its own is reusable. A helper killed while holding a claim leaves its pid behind, and
 * macOS is free to hand that number to something unrelated - a shell, a browser tab's helper,
 * anything long-lived. `kill(pid, 0)` then answers "alive" forever and every future update reports
 * one already in progress, with no updater anywhere near the clone.
 *
 * The start time alone is not enough, because `ps -o lstart=` has one-second granularity: a pid
 * reused by a process that started within the same second as the original helper would compare
 * equal. The command line closes that, and cheaply - it is the same single `ps` call - because
 * the helper's argv names its own `mkdtemp` temp directory and the tag it is installing, which
 * nothing else on the machine is going to reproduce in the same second under the same pid.
 *
 * Both fields together, compared as one opaque string. Null when it cannot be read, which every
 * caller treats as "cannot prove this is gone".
 */
export function processIdentity(pid, run = defaultProcessQuery) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const out = run(pid);
    // Collapse whitespace: `ps` pads its columns, and the padding is not identity.
    const value = String(out ?? "").replace(/\s+/g, " ").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function defaultProcessQuery(pid) {
  return execFileSync("/bin/ps", ["-o", "lstart=,command=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Whether the process that wrote a claim entry is still running.
 *
 * Conservative on purpose: anything short of proof that the writer is gone counts as live. A
 * wrongly-kept claim defers one update, and the person clicks Retry; a wrongly-removed claim puts
 * two helpers in one clone, which is the failure this whole mechanism exists to prevent.
 */
export function claimIsLive(entry, deps = {}) {
  const alive = deps.alive ?? ((pid) => processIsAlive(pid));
  const identityOf = deps.identity ?? ((pid) => processIdentity(pid));
  if (!alive(entry.pid)) return false;
  // Nothing recorded to compare against, or nothing readable now: cannot prove reuse, so live.
  if (!entry.identity) return true;
  const now = identityOf(entry.pid);
  if (now === null) return true;
  return now === entry.identity;
}

/**
 * Take the helper claim, or report who holds it.
 *
 * The whole decision is made by reading the directory. This helper writes exactly one entry -
 * its own - and then looks at what is there; it never writes or removes a name that belongs to
 * another live helper, so there is no shared mutable state for two contenders to race over. That
 * is the property both earlier attempts lacked.
 *
 * The rule is that a helper holds the lock only when its own entry is the ONLY live one. It
 * deliberately involves no ordering, because ordering was wrong: an earlier version ranked
 * entries by (createdAtMs, pid) and let the earliest live claim win, which a contender arriving
 * LATER could break simply by writing an entry stamped earlier - displacing a helper that was
 * already running. A key the arriving process chooses cannot decide who was there first.
 *
 * "Alone or nothing" needs no clock, no tie-break, and no trust:
 *
 *   For this helper to hold the lock, its listing must show no other live entry. Its own entry
 *   is always written before it lists. So if two helpers both held the lock, each must have
 *   listed before the other's entry existed - yet each entry was written before that helper
 *   listed, which cannot be true of both. At most one helper can hold it, on every interleaving.
 *
 * The price is that two helpers starting close enough together can both see each other and both
 * stand down, leaving the update deferred rather than running. That is the right way to be
 * wrong: the person clicks Retry and the next attempt is alone. Two helpers in one clone is the
 * failure this exists to prevent, and it is not recoverable by retrying.
 *
 * Entries whose writing process is proven gone are removed. That is the one delete that touches
 * somebody else's name, and it is safe because the name says whose it is and `claimIsLive`
 * refuses to declare a process gone on anything less than proof.
 */
export function acquireHelperLock(directory, ops) {
  ops.ensureDirectory(directory);

  const mine = {
    createdAtMs: ops.now(),
    pid: ops.pid,
    identity: ops.identity(ops.pid),
  };
  const myName = claimEntryName(mine);
  // Written under a temporary name and renamed into place, so an entry is never visible in a
  // half-written state. A competitor reading a truncated entry could not tell a live helper
  // mid-write from an abandoned one, and would be entitled to delete it.
  ops.writeEntry(directory, myName, JSON.stringify({ pid: mine.pid, identity: mine.identity }));

  let names;
  try {
    names = ops.list(directory);
  } catch (error) {
    ops.removeEntry(directory, myName);
    throw error;
  }

  let rival = null;
  for (const name of names) {
    const parsed = parseClaimEntryName(name);
    if (!parsed) {
      // A staging file whose helper died before it could rename it into place. Removed only when
      // its owning pid is not running: deleting a live helper's staging file would make its
      // rename fail for no reason. Identity-pinned like every other delete here - the pid is in
      // the name, so this can only ever clear the leftovers of the process named in it.
      //
      // The recorded start time is read for the same reason claims carry one: passing null here
      // reduced the check to a bare pid test, so a staging file whose pid macOS had since reused
      // would have been retained forever. A staging file holds the entry body, so the identity
      // is right there. Unreadable ones fall back to the pid alone and are retained whenever it
      // answers, which is the conservative direction.
      const staging = parseStagingEntryName(name);
      if (staging) {
        const recorded = ops.readEntry(directory, name);
        if (!ops.isLive({ pid: staging.pid, identity: recorded?.identity ?? null })) {
          ops.removeEntry(directory, name);
        }
      }
      continue;
    }
    if (name === myName) continue;
    const recorded = ops.readEntry(directory, name);
    const entry = { ...parsed, identity: recorded?.identity ?? null };
    if (!ops.isLive(entry)) {
      // Its writer is gone. Safe to remove: the filename pins whose entry this is, so this can
      // only ever clear the claim of the process named in it.
      ops.removeEntry(directory, name);
      continue;
    }
    // Only to decide which pid to name in the message, so the report is stable rather than
    // dependent on directory order. Any live rival at all is already decisive.
    if (rival === null || claimPrecedes(entry, rival)) rival = entry;
  }

  if (rival === null) return { ok: true, heldBy: null, entryName: myName };
  // Withdraw rather than linger: an entry left behind by a helper that is not running would make
  // it look like a live contender to everyone who reads the directory next.
  ops.removeEntry(directory, myName);
  return { ok: false, heldBy: rival.pid, entryName: null };
}

/** Withdraw this helper's own claim. The only entry it is ever this helper's job to remove. */
export function releaseHelperLock(directory, entryName, ops) {
  ops.removeEntry(directory, entryName);
}

export function realHelperLockOperations() {
  const identity = (pid) => processIdentity(pid);
  return {
    pid: process.pid,
    now: () => Date.now(),
    identity,
    isLive: (entry) => claimIsLive(entry),
    ensureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    list: (directory) => readdirSync(directory),
    writeEntry: (directory, name, body) => {
      // `.tmp-` is outside the `<digits>-<pid>.claim` pattern, so a temporary file is never read
      // as a claim even if this helper dies between the write and the rename.
      const staging = join(directory, stagingEntryName(process.pid, Date.now()));
      writeFileSync(staging, `${body}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(staging, join(directory, name));
    },
    readEntry: (directory, name) => {
      try {
        return JSON.parse(readFileSync(join(directory, name), "utf8"));
      } catch {
        return null;
      }
    },
    removeEntry: (directory, name) => rmSync(join(directory, name), { force: true }),
  };
}
