import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * The daemon's own SQLite database, opened as a SECOND writer, for a spec that has to seed
 * durable state no route can produce.
 *
 * The one thing this exists to add is a busy timeout, and it is not decoration.
 *
 * The daemon holds the database in WAL mode, which lets readers and one writer proceed at
 * once - but two WRITERS still serialize, and SQLite's default behaviour for the loser is to
 * fail IMMEDIATELY with `SQLITE_BUSY` ("database is locked") rather than wait. A spec seeding
 * rows is by definition a second writer racing a daemon that writes on its own schedule
 * (pending turns, the workflow sweep, the retro scan), so every direct `new DatabaseSync`
 * was a coin flip weighted by how loaded the machine was.
 *
 * That is exactly what it looked like in practice: a `foreman-decision-ledger` seed died with
 * `database is locked` 838ms into a full-suite run, having passed the previous run and every
 * isolated one - the signature of a collision window, not of a broken assertion. Waiting five
 * seconds costs a green run nothing (the daemon's writes are sub-millisecond) and converts
 * that failure into a pause nobody sees.
 *
 * Read-only openers do not need this and are welcome to keep using `DatabaseSync` directly;
 * WAL readers never block. This is for the writers.
 */
export function openDaemonDb(home: string): DatabaseSync {
  const db = new DatabaseSync(join(home, "harness.db"));
  // Five seconds, matched to the daemon's fastest background writer rather than picked
  // round: nothing in an e2e daemon holds the write lock for anything like that long, so a
  // timeout that is reached at all means something is genuinely wedged and the spec should
  // fail rather than hang.
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
