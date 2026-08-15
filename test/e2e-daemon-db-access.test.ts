import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Every e2e spec that opens the daemon's database goes through `withDaemonDb`.
 *
 * The helper exists because twelve call sites across ten specs had each written `new
 * DatabaseSync(join(daemon.home, "harness.db"))` by hand, and none of them set `busy_timeout`
 * - so a spec WRITING beside the running daemon got `SQLITE_BUSY` the instant the daemon held
 * the write lock, surfacing as `Error: database is locked`. (Two of the twelve only read, and
 * a reader never blocks under WAL; they route through the helper for the single entry point,
 * not because they were at risk.) It is a contention failure, which means it is invisible on
 * a quiet machine and only appears when two suites share one: observed in `seedEpisodes` in
 * `foreman-decision-ledger.spec.ts`, a spec that passes 5/5 on its own.
 *
 * Centralising the pragma fixes the eleven. This is what fixes the twelfth, because the next
 * spec to want direct access is the one that will paste the raw constructor from a neighbour
 * and inherit the same defect - and it will pass, on the author's machine, every time they
 * run it. A grep is the only layer that can fail for them instead.
 *
 * Here rather than in `e2e/` deliberately: it reads source as text and needs no browser, no
 * build and no daemon, so it costs milliseconds and runs in `npm test` where a spec author
 * gets the answer before CI does.
 */

const E2E = fileURLToPath(new URL("../e2e", import.meta.url));

/** The one file allowed to name the constructor - it is what everything else goes through. */
const OWNER = "fixtures/daemon-db.ts";

function specFiles(): string[] {
  const found: string[] = [];
  for (const dir of ["specs", "fixtures"]) {
    for (const file of readdirSync(join(E2E, dir))) {
      if (file.endsWith(".ts")) found.push(`${dir}/${file}`);
    }
  }
  return found;
}

test("no e2e file opens the daemon database except through withDaemonDb", () => {
  const files = specFiles();
  // Guards the guard: a rename of the directories above would otherwise leave this passing
  // over nothing at all, which is the failure mode a source scan is most prone to.
  assert.ok(files.length > 20, `expected to scan the e2e tree, found ${files.length} files`);
  assert.ok(files.includes(OWNER), `${OWNER} should be among the scanned files`);

  const offenders = files.filter(
    (file) => file !== OWNER && readFileSync(join(E2E, file), "utf8").includes("new DatabaseSync"),
  );
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} opens the daemon database directly. Use withDaemonDb from ` +
      `e2e/fixtures/daemon-db.ts - a hand-rolled DatabaseSync sets no busy_timeout, so it ` +
      "throws 'database is locked' the moment the daemon is mid-write.",
  );
});

test("the shared helper still sets a busy timeout", () => {
  // The assertion above is worth nothing if the one sanctioned opener stops setting the
  // pragma: every spec would route through a helper that had quietly become the old bug.
  const source = readFileSync(join(E2E, OWNER), "utf8");
  assert.match(source, /PRAGMA busy_timeout/, `${OWNER} should set busy_timeout`);
});
