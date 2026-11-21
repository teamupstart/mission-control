// The daemon's shaper revisions: compared by the dashboard, never recomputable outside the daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalJson, ShapingConfigSchema, StoredShaperSchema } from "../src/shared/shaping.ts";
import { daemonShapingView, shapingReviser } from "../src/server/shaping/revisions.ts";

const REVISIONS = fileURLToPath(new URL("../src/server/shaping/revisions.ts", import.meta.url));

// An entry this build cannot run, with a value in a field the view never shows.
const hidden = (secret: string) => StoredShaperSchema.parse({
  id: "future", label: "Future", stage: "route", transport: { type: "grpc", endpoint: "dns:///future" }, note: secret,
});

test("a revision is 16 hex digits, stable within the daemon, and changes with a field the view hides", () => {
  const revision = shapingReviser([hidden("first")]);
  assert.match(revision, /^[0-9a-f]{16}$/);
  assert.equal(shapingReviser([hidden("first")]), revision, "the same entries, the same revision");
  assert.notEqual(shapingReviser([hidden("second")]), revision, "a hidden field still changes it");
  const view = daemonShapingView(ShapingConfigSchema.parse({ shapers: [hidden("first")] }));
  assert.equal(view.revisions.future, revision, "the view publishes the daemon's revision");
  assert.equal(JSON.stringify(view).includes("first"), false, "and never the hidden value");
});

test("a revision cannot be recomputed from the entry without the daemon's key", () => {
  const entries = [hidden("guess-me")];
  const revision = shapingReviser(entries);
  // An unkeyed digest of exactly what is stored, which anyone knowing the rest of the envelope
  // could compute for each guess, does not produce it.
  for (const algorithm of ["sha256", "sha1", "md5"]) {
    assert.notEqual(createHash(algorithm).update(canonicalJson(entries)).digest("hex").slice(0, 16), revision, algorithm);
  }
  // Another process running the same code over the same entries derives a different revision:
  // the key is the daemon process's own and is never written anywhere.
  const script = [
    `const { shapingReviser } = await import(${JSON.stringify(REVISIONS)});`,
    `process.stdout.write(shapingReviser(${JSON.stringify(entries)}));`,
  ].join("\n");
  const elsewhere = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.match(elsewhere, /^[0-9a-f]{16}$/);
  assert.notEqual(elsewhere, revision);
});
