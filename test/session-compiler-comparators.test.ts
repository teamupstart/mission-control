import { test } from "node:test";
import assert from "node:assert/strict";
import { edit, typecheckWithPatch } from "./helpers/typecheck-probe.ts";

const SESSION_END = "  paneDialog: PaneDialog | null;\n}";

/**
 * Matched on error CODES plus the identifiers involved, never on diagnostic
 * prose: TypeScript rewords its messages between releases, and a probe that goes
 * red on a routine tsc upgrade is exactly the false "the guard broke" signal
 * these tests exist to be trustworthy about. Codes and symbol names are stable.
 * Each diagnostic is one line, so `[^\n]*` keeps a match from spanning two.
 */
const missingComparator = (field: string): RegExp =>
  new RegExp(`registry\\.ts[^\\n]*error TS2741:[^\\n]*${field}[^\\n]*SessionFieldComparators`);

test("a Session field with no comparator fails typecheck", () => {
  const out = typecheckWithPatch((dir) =>
    edit(dir, "src/shared/types.ts", SESSION_END, "  paneDialog: PaneDialog | null;\n  probeField: boolean;\n}"),
  );
  assert.match(
    out,
    missingComparator("probeField"),
    `adding a Session field should break SESSION_FIELD_COMPARATORS, got:\n${out}`,
  );
});

test("an OPTIONAL Session field with no comparator also fails typecheck", () => {
  // The `-?` in the mapped type is load-bearing: without it an optional field
  // could be omitted from the record, which is the same silent staleness with a
  // question mark on it.
  const out = typecheckWithPatch((dir) =>
    edit(dir, "src/shared/types.ts", SESSION_END, "  paneDialog: PaneDialog | null;\n  probeOptional?: boolean;\n}"),
  );
  assert.match(
    out,
    missingComparator("probeOptional"),
    `an optional Session field should still be required in the record, got:\n${out}`,
  );
});
