import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../src/main/utility-supervisor.ts", import.meta.url)),
  "utf8",
);

test("log-open failures remain inside the supervised restart loop", () => {
  assert.match(
    source,
    /try \{\s+log = openPrivateUtilityLog\(opts\.logPath\);\s+\} catch \{\s+scheduleRestart\(\);\s+return;/,
  );
});

test("daemon initialization failures retain their original diagnostic", () => {
  assert.match(
    source,
    /opts\.includeFailureDetails === false \? "" : `: \$\{String\(err\.cause\)\}`/,
  );
});
