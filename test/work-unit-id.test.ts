import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_UNIT_ENV_VAR,
  WORK_UNIT_HEADER,
  WORK_UNIT_ID_PATTERN,
  WORK_UNIT_META_KEY,
  WORK_UNIT_SPAN_ATTRIBUTE,
  encodeWorkUnitId,
  isWorkUnitId,
} from "../src/shared/work-unit.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import { taskKindHasWorkUnit, taskKindSessionJoinsWorkUnit } from "../src/shared/task.ts";
import { mcpCreateWorkUnitSource, mintWorkUnitId } from "../src/server/work-unit.ts";

test("the pattern is Agent Platform's check, character for character", () => {
  assert.equal(WORK_UNIT_ID_PATTERN.source, "^wu_[0-9A-HJKMNP-TV-Z]{26}$");
  assert.equal(WORK_UNIT_ID_PATTERN.flags, "");
});

test("the four carrier names are the plan's names", () => {
  assert.equal(WORK_UNIT_ENV_VAR, "WORK_UNIT_ID");
  assert.equal(WORK_UNIT_HEADER, "x-work-unit-id");
  assert.equal(WORK_UNIT_META_KEY, "work_unit_id");
  assert.equal(WORK_UNIT_SPAN_ATTRIBUTE, "work_unit_id");
});

test("the time half matches the ULID specification's vector", () => {
  const id = encodeWorkUnitId(1469918176385, new Uint8Array(10));
  assert.equal(id.slice(3, 13), "01ARYZ6S41");
  assert.equal(id, "wu_01ARYZ6S410000000000000000");
});

test("the random half reads the ten bytes five bits at a time, most significant first", () => {
  // 0xff repeated is eighty one bits: sixteen Zs, the largest Crockford digit.
  assert.equal(encodeWorkUnitId(0, new Uint8Array(10).fill(0xff)), `wu_0000000000${"Z".repeat(16)}`);
  // One set bit at the very end lands in the last character's lowest bit.
  const last = new Uint8Array(10);
  last[9] = 1;
  assert.equal(encodeWorkUnitId(0, last), `wu_0000000000${"0".repeat(15)}1`);
  // The first byte's top five bits are the first random character: 0b10000 is G.
  const first = new Uint8Array(10);
  first[0] = 0b1000_0000;
  assert.equal(encodeWorkUnitId(0, first), `wu_0000000000G${"0".repeat(15)}`);
});

test("the encoder refuses a time or randomness it cannot represent", () => {
  assert.throws(() => encodeWorkUnitId(-1, new Uint8Array(10)), RangeError);
  assert.throws(() => encodeWorkUnitId(2 ** 48, new Uint8Array(10)), RangeError);
  assert.throws(() => encodeWorkUnitId(1.5, new Uint8Array(10)), RangeError);
  assert.throws(() => encodeWorkUnitId(0, new Uint8Array(9)), RangeError);
  assert.equal(isWorkUnitId(encodeWorkUnitId(2 ** 48 - 1, new Uint8Array(10))), true);
});

test("minted ids are 29 characters, well formed, distinct and ordered by time", () => {
  const minted = Array.from({ length: 2000 }, () => mintWorkUnitId());
  for (const id of minted) {
    assert.equal(id.length, 29);
    assert.equal(isWorkUnitId(id), true, id);
  }
  assert.equal(new Set(minted).size, minted.length);
  const earlier = mintWorkUnitId(1_000_000);
  const later = mintWorkUnitId(2_000_000);
  assert.ok(earlier.slice(0, 13) < later.slice(0, 13));
});

test("isWorkUnitId refuses everything that is not exactly the format", () => {
  const good = mintWorkUnitId();
  for (const bad of [
    null, undefined, 42, "", good.toLowerCase(), good.slice(0, -1), `${good}0`,
    `WU_${good.slice(3)}`, ` ${good}`, `${good.slice(0, -1)}I`, `${good.slice(0, -1)}L`,
    `${good.slice(0, -1)}O`, `${good.slice(0, -1)}U`, `${good}\n`,
  ]) {
    assert.equal(isWorkUnitId(bad), false, String(bad));
  }
});

test("only a plan's session shares its work unit, and only a resident run has none", () => {
  for (const kind of TASK_KINDS) {
    assert.equal(taskKindHasWorkUnit(kind), kind !== "resident", kind);
    assert.equal(taskKindSessionJoinsWorkUnit(kind), kind === "plan", kind);
  }
});

test("MCP creation's work unit follows the request, then the caller's task kind", () => {
  const plan = { id: "plan-task", kind: "plan" as const };
  const ship = { id: "ship-task", kind: "ship" as const };
  const resident = { id: "resident-task", kind: "resident" as const };
  const inherit = (id: string) => ({ ok: true, source: { inherit: [id] } });
  const fresh = { ok: true, source: undefined };

  assert.deepEqual(mcpCreateWorkUnitSource(undefined, plan), inherit("plan-task"));
  assert.deepEqual(mcpCreateWorkUnitSource(undefined, ship), fresh);
  assert.deepEqual(mcpCreateWorkUnitSource(undefined, resident), fresh);
  assert.deepEqual(mcpCreateWorkUnitSource(undefined, null), fresh, "an unresolved caller is not an error");
  assert.deepEqual(mcpCreateWorkUnitSource("new", plan), fresh);
  assert.deepEqual(mcpCreateWorkUnitSource("new", null), fresh);
  assert.deepEqual(mcpCreateWorkUnitSource("inherit", ship), inherit("ship-task"));
  assert.deepEqual(mcpCreateWorkUnitSource("inherit", plan), inherit("plan-task"));

  const noTask = mcpCreateWorkUnitSource("inherit", null);
  assert.equal(noTask.ok, false);
  assert.match(!noTask.ok ? noTask.error : "", /running a task/);
  const fromResident = mcpCreateWorkUnitSource("inherit", resident);
  assert.equal(fromResident.ok, false);
  assert.match(!fromResident.ok ? fromResident.error : "", /resident run has no work unit/);
});
