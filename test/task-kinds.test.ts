/**
 * What is at stake: `ship` and `scout` mean the same thing to the route that validates a
 * dispatch, the store that reads a schedule back off disk, and the control an operator
 * picks with - and until this file existed, each of those had been told separately.
 *
 * `TaskKind` was a bare union, so the pair was written out by hand in seven more places:
 * three `z.enum`s in `protocol.ts`, one in `task-source.ts`, a runtime guard in the
 * schedule store, a structural type in the web's api client, and two `<option>`s in the
 * dispatch modal. Nothing failed when they disagreed. A third kind added to the union
 * would have compiled, dispatched, persisted, and simply been unpickable in the one
 * dialog that dispatches - the exact silent degradation `AGENT_TYPES` was extracted to
 * remove, one field over.
 *
 * So the tuple is the registry, and this file pins both halves: the tuple's contents and
 * ORDER (which is the order every picker offers the choice in), and the absence of any
 * second copy of the SET - bar two `<select>`s that still hand-write theirs, listed and
 * explained below, which this file holds at two and lets go no higher.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TASK_KINDS, type TaskKind } from "../src/shared/types.ts";
import { TASK_KIND_INFO } from "../src/shared/task.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The two registry homes: the ids, and the copy that presents them. These are where the
 * pair is SUPPOSED to be written out, and the only reason there are two is that what a
 * thing is called does not belong in the module that says what it is.
 */
const REGISTRIES = ["shared/types.ts", "shared/task.ts"];

/**
 * Kind `<select>`s that still hand-write their two `<option>`s, and each with its own
 * wording: "Ship - deliver a change" here, "ship - deliver a change" there, bare "ship" in
 * the dispatch modal. Three surfaces, three answers to one question.
 *
 * They are listed rather than fixed because unifying them changes what a person reads, and
 * the change that introduced this registry deliberately changed nothing on screen. Folding
 * them onto `TASK_KIND_INFO` is a copy change, owes an `e2e/` spec, and is worth doing on
 * its own. Until then this list keeps the drift from growing: it may shrink, never grow.
 */
const KNOWN_HAND_WRITTEN = [
  "web/components/TaskSourcesPanel.tsx",
  "web/components/schedules/ScheduleEditor.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

test("the kinds are ship then scout, and the type is derived from them", () => {
  assert.deepEqual([...TASK_KINDS], ["ship", "scout"]);
  // Order is a contract, not an accident of how they were typed: it is the order the
  // dispatch form lists the options in, and the order the guided pass will offer them.
  assert.equal(TASK_KINDS[0], "ship", "ship leads - it is the default and the common case");
  // Derivation, checked in the direction that can actually fail. `TaskKind` is
  // `(typeof TASK_KINDS)[number]`, so a value the tuple does not hold is not assignable
  // and this file would not compile - which is the assertion.
  const every: readonly TaskKind[] = TASK_KINDS;
  assert.equal(every.length, 2);
});

test("every kind says how it is offered", () => {
  // `Record<TaskKind, …>` means a third kind cannot compile without its copy, so what is
  // left to check is that the copy is usable: an empty label renders a blank option.
  for (const kind of TASK_KINDS) {
    const info = TASK_KIND_INFO[kind];
    assert.ok(info, `${kind} has no presentation`);
    assert.ok(info.label.length > 0, `${kind} has no label`);
    assert.ok(info.blurb.length > 0, `${kind} has no blurb`);
  }
});

/**
 * Both ids written out together - on one line or on two adjacent ones, which is every
 * shape the drift actually took: `z.enum(["ship", "scout"])`, `kind: "ship" | "scout"`,
 * `k === "ship" || k === "scout"`, and a pair of consecutive `<option>` elements.
 *
 * Deliberately NOT "this file mentions both ids somewhere", which would flag
 * `settings-search.ts` for holding `scout` in one control's keywords and `ship` in
 * another's, two hundred lines apart. Naming a kind is fine; declaring the SET is what a
 * registry is for.
 */
function restatesThePair(source: string): boolean {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const lines = bare.split("\n");
  return lines.some((line, i) => {
    const window = line + " " + (lines[i + 1] ?? "");
    return window.includes(`"ship"`) && window.includes(`"scout"`);
  });
}

test("nothing outside the registries declares the set of kinds", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (REGISTRIES.includes(rel)) continue;
    if (restatesThePair(readFileSync(file, "utf8"))) offenders.push(rel);
  }
  // Exact, not a subset: a file that appears here is a new copy of the set and must read
  // `TASK_KINDS` instead, and a file that stops appearing has been fixed and should be
  // deleted from `KNOWN_HAND_WRITTEN` in the same change, so the list can only shrink.
  assert.deepEqual(offenders.sort(), KNOWN_HAND_WRITTEN);
});
