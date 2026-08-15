import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DaemonHandle } from "./daemon.ts";

/**
 * How long a spec's write waits for the daemon to finish one of its own.
 *
 * Generous by three orders of magnitude, deliberately. The competing writer is a local
 * daemon doing single-statement writes that take milliseconds, so a wait anywhere near this
 * number means something is wedged rather than busy - and a wedged daemon should fail the
 * spec on its own assertion timeout, which says what it was waiting for, rather than here.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Run `use` against the daemon's own database, with a busy timeout, and close the handle.
 *
 * Twelve call sites across ten specs reach the file directly, and they split two ways.
 *
 * **Ten of them WRITE**, seeding state nothing in this suite can produce for real - a review
 * round is a model call, an observed head is a `gh` call, an aged `costTelemetryEnabledAt` is
 * a week of elapsed time. They write behind the daemon's back and let everything downstream
 * of the seed stay real. Those are the ones that need the pragma below, and the reason it
 * exists: **WAL is not the whole story, and four of these specs said it was.** WAL buys
 * concurrent readers alongside one writer; two WRITERS still serialize on a single write
 * lock, and a connection with no `busy_timeout` does not wait for that lock for even a
 * moment. SQLite returns `SQLITE_BUSY` on the spot and `node:sqlite` throws it as `Error:
 * database is locked`. Observed for real, in `seedEpisodes` in
 * `foreman-decision-ledger.spec.ts`, when two full `npm run test:e2e` runs shared a machine -
 * the spec passes 5/5 alone, because alone it never loses the race.
 *
 * **The other two only READ** - `dispatch-and-converse` and `sdk-idle-restore` both poll
 * `sdk_sessions.turn_in_progress` for a turn boundary the HTTP API does not expose. Under WAL
 * a reader never blocks on the writer, so those two were never at risk and the timeout does
 * nothing for them. They route through here anyway, because one way to open this file is
 * worth more than a second entry point that happens to be safe today - and they get the
 * guaranteed `close()` either way.
 *
 * Nothing in `src/` sets this pragma; see the note over `openDb` in `src/server/db.ts` for
 * why the daemon itself correctly does not need one.
 *
 * A scope function rather than an `openDaemonDb()` that hands back a configured handle,
 * because the argument for centralising the pragma is exactly the argument for centralising
 * the `close()`: the NEXT spec to want direct access is the one that forgets. Every call
 * site this replaced was already `open; try { … } finally { db.close() }`, so the shape is
 * unchanged - it just cannot be got wrong now.
 *
 * `use` must be synchronous. `DatabaseSync` has no awaitable operation, and an `async`
 * callback would have its handle closed out from under it the moment it first suspended,
 * so returning a thenable is refused rather than left to fail later as a use-after-close.
 */
export function withDaemonDb<T>(daemon: DaemonHandle, use: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(daemon.home, "harness.db"));
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const result = use(db);
    if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
      throw new Error(
        "withDaemonDb: the callback returned a promise. It must be synchronous - the handle " +
          "closes when it returns, which would be before an async callback had finished.",
      );
    }
    return result;
  } finally {
    db.close();
  }
}
