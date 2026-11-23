import { test } from "node:test";
import assert from "node:assert/strict";
import { edit, typecheckWithPatch } from "./helpers/typecheck-probe.ts";

// Anchored MID-union rather than on the last variant, so adding one to the end of
// `ServerEvent` doesn't break this probe. `task_remove` without its trailing semicolon
// matches wherever it sits in the union, and the probe is spliced in beside it - an
// unhandled variant is unhandled whatever its position.
const SERVER_EVENT_ANCHOR = `  | { type: "task_remove"; id: string }`;
const PERSONA_UPSERT_HANDLER = `        case "persona_upsert":
          setPersonas((prev) => new Map(prev).set(msg.persona.id, msg.persona));
          break;
`;
const ENSEMBLE_UPSERT_HANDLER = `        case "ensemble_upsert":
          setEnsembles((prev) => new Map(prev).set(msg.ensemble.id, msg.ensemble));
          break;
`;

const UNHANDLED_EVENT = /useEventStream\.ts[^\n]*error TS2322:[^\n]*never/;

test("a ServerEvent variant the stream doesn't handle fails typecheck", () => {
  const out = typecheckWithPatch((dir) =>
    edit(
      dir,
      "src/shared/types.ts",
      SERVER_EVENT_ANCHOR,
      `  | { type: "probe_unhandled"; id: string }\n  | { type: "task_remove"; id: string }`,
    ),
  );
  assert.match(
    out,
    UNHANDLED_EVENT,
    `an unhandled ServerEvent variant should break the exhaustiveness check, got:\n${out}`,
  );
});

test("the Persona upsert cannot fall out of the exhaustive event-stream switch", () => {
  const out = typecheckWithPatch((dir) =>
    edit(dir, "src/web/useEventStream.ts", PERSONA_UPSERT_HANDLER, ""),
  );
  assert.match(
    out,
    UNHANDLED_EVENT,
    `removing the Persona upsert handler should break the exhaustiveness check, got:\n${out}`,
  );
});

test("the ensemble upsert cannot fall out of the exhaustive event-stream switch", () => {
  // The ensemble collection is the newest top-level one, and it arrives on the same single
  // SSE stream as everything else. A branch dropped from this switch is silent: the daemon
  // emits, nothing throws, and the group simply never appears.
  const out = typecheckWithPatch((dir) =>
    edit(dir, "src/web/useEventStream.ts", ENSEMBLE_UPSERT_HANDLER, ""),
  );
  assert.match(
    out,
    UNHANDLED_EVENT,
    `removing the ensemble upsert handler should break the exhaustiveness check, got:\n${out}`,
  );
});
