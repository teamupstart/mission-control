// The dashboard's sign-in list, as `useEventStream` reduces it from the snapshot and the
// `shaping_sign_ins` frame (`shapingSignInsAfter`), and a check that the hook applies exactly
// that reduction for both.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ShapingSignInView } from "../src/shared/shaping.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { NO_SHAPING_SIGN_INS, shapingSignInsAfter } from "../src/web/lib/shaping-sign-ins.ts";

const view = (id: string, state: ShapingSignInView["state"]): ShapingSignInView => ({
  id, url: "https://tools.example/mcp", scope: "mcp:context", issuer: null, state, storage: "memory",
  expiresAt: null, reason: null, shapers: ["notes"],
});
// Only the field under test: the reduction reads nothing else from a snapshot.
const snapshot = (shapingSignIns?: ShapingSignInView[]) =>
  ({ type: "snapshot", ...(shapingSignIns ? { shapingSignIns } : {}) }) as unknown as ServerEvent;
const frame = (signIns: ShapingSignInView[]): ServerEvent => ({ type: "shaping_sign_ins", signIns });

test("a window starts empty, takes the snapshot's list, follows each frame, and an empty frame clears it", () => {
  let held = NO_SHAPING_SIGN_INS;
  assert.deepEqual(held, []);

  const pending = [view("a".repeat(32), "pending")];
  held = shapingSignInsAfter(held, snapshot(pending));
  assert.equal(held, pending, "the snapshot's list is held");

  const signedIn = [view("a".repeat(32), "signed_in"), view("b".repeat(32), "signed_out")];
  held = shapingSignInsAfter(held, frame(signedIn));
  assert.equal(held, signedIn, "a frame replaces it");

  held = shapingSignInsAfter(held, frame([]));
  assert.equal(held, NO_SHAPING_SIGN_INS, "the clearing frame a flag going off sends empties it");
});

test("a snapshot without the field reads as empty, as a flag being off does", () => {
  const held = shapingSignInsAfter([view("a".repeat(32), "signed_in")], snapshot());
  assert.equal(held, NO_SHAPING_SIGN_INS);
  assert.equal(shapingSignInsAfter(held, snapshot([])), NO_SHAPING_SIGN_INS, "and an empty one keeps the shared reference");
});

test("any other event leaves the list as it was", () => {
  const held = [view("a".repeat(32), "signed_in")];
  assert.equal(shapingSignInsAfter(held, { type: "shaping_config", config: null }), held);
});

/** The statements of one `case` in the hook's event switch, up to the next `case` or `default`. */
function caseBody(source: string, type: string): string {
  const start = source.indexOf(`case "${type}":`);
  assert.ok(start >= 0, `useEventStream handles ${type}`);
  const rest = source.slice(start + type.length + 8);
  const end = rest.search(/\n\s*(case "|default:)/);
  return end < 0 ? rest : rest.slice(0, end);
}

// The reduction is tested above; this only checks that both message types reach it, in whatever
// form the hook spells the call. That the hook returns `shapingSignIns` is the type check's.
test("useEventStream reduces the snapshot and the frame through shapingSignInsAfter, starting empty", () => {
  const source = readFileSync(new URL("../src/web/useEventStream.ts", import.meta.url), "utf8");
  assert.match(source, /useState<ShapingSignInView\[\]>\(\s*NO_SHAPING_SIGN_INS\s*\)/);
  for (const type of ["snapshot", "shaping_sign_ins"]) {
    assert.match(caseBody(source, type), /setShapingSignIns\([^;]*shapingSignInsAfter\(/, `${type} is reduced by shapingSignInsAfter`);
  }
});
