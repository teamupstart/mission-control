import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One statement in the whole tree may write `inspector_comments.status`.
 *
 * There are two POLICIES that resolve a finding, and both are legitimate:
 *
 *  - `closeRow` in `src/server/inspector/worker.ts` - the model's judgment, reached when a
 *    review round lists a fingerprint as resolved or a follow-up reply drops its own
 *    finding.
 *  - `resolveInspectorFindings` in `src/server/db.ts` - the operator's, and the only route
 *    out of a finding whose fix was pushed, reviewed once, and then never mentioned again.
 *    Rounds stop at an already-reviewed head, so nothing model-driven can ever reach it.
 *
 * Two policies are fine. Two SQL statements are not, and that distinction is what this
 * file exists to hold. The status vocabulary is persisted and append-only, `openFindings`
 * counts `status !== "resolved"`, and `mergeVerdict` blocks a merge on that count - so a
 * second hand-rolled `UPDATE ... SET status` is a second answer to "what a resolved row
 * looks like", sitting directly under the gate that stops YOLO mode landing unreviewed
 * work. This repo's rule against parallel sources of truth is exactly that concern.
 *
 * The first version of the operator path DID hand-roll its own `UPDATE`. It was correct on
 * the day it was written and it was still the wrong shape, which is why the guard is a test
 * rather than a comment: the drift it prevents does not look like a bug in any one diff.
 */

const SERVER_DIR = fileURLToPath(new URL("../src/server", import.meta.url));

/** Every `.ts` under `src/server`, path and text. */
function serverSources(dir = SERVER_DIR): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverSources(p));
    else if (entry.name.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

/** Statements that write the comments table at all, by the SQL verb that reaches it. */
function writesToInspectorComments(text: string): string[] {
  const found: string[] = [];
  const statement = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+inspector_comments/gi;
  let m: RegExpExecArray | null;
  while ((m = statement.exec(text))) found.push(m[0].replace(/\s+/g, " ").toUpperCase());
  return found;
}

test("only one statement in the tree writes inspector_comments, and it lives in db.ts", () => {
  const offenders = serverSources()
    .map((f) => ({ path: f.path, writes: writesToInspectorComments(f.text) }))
    .filter((f) => f.writes.length > 0 && !/[/\\]db\.ts$/.test(f.path));
  assert.deepEqual(
    offenders.map((o) => `${o.path}: ${o.writes.join(", ")}`),
    [],
    "the ledger is written through db.ts, never from a worker or a route directly",
  );
});

test("db.ts carries exactly one writer of the status column, shared by both policies", () => {
  const db = readFileSync(join(SERVER_DIR, "db.ts"), "utf8");
  const writes = writesToInspectorComments(db);

  // One INSERT (the upsert every caller goes through) and nothing else. A bare `UPDATE
  // inspector_comments` here is the regression: it means a caller decided what a resolved
  // row looks like on its own rather than handing a whole row to `upsertInspectorComment`.
  assert.deepEqual(
    writes,
    ["INSERT INTO INSPECTOR_COMMENTS"],
    "a second statement means a second definition of a resolved row",
  );

  // And the operator path is wired to that upsert rather than to a statement of its own -
  // the property the assertion above can only observe indirectly.
  const operatorPath = db.slice(db.indexOf("export function resolveInspectorFindings"));
  const body = operatorPath.slice(0, operatorPath.indexOf("\n}"));
  assert.match(
    body,
    /upsertInspectorComment\(/,
    "resolveInspectorFindings must resolve through the shared upsert",
  );
  assert.doesNotMatch(body, /\bSET\b/i, "and must not hand-roll SQL of its own");
});
