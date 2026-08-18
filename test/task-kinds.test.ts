/**
 * What is at stake: `ship`, `scout` and `plan` mean the same thing to the route that
 * validates a dispatch, the store that reads a schedule back off disk, and the control an
 * operator picks with - and until this file existed, each of those had been told
 * separately.
 *
 * `TaskKind` was a bare union, so the set was written out by hand in seven more places:
 * three `z.enum`s in `protocol.ts`, one in `task-source.ts`, a runtime guard in the
 * schedule store, a structural type in the web's api client, and two `<option>`s in the
 * dispatch modal. Nothing failed when they disagreed. A third kind added to the union
 * would have compiled, dispatched, persisted, and simply been unpickable in the one
 * dialog that dispatches - the exact silent degradation `AGENT_TYPES` was extracted to
 * remove, one field over.
 *
 * That prediction was then tested by adding `plan`, and it held exactly: the two registries
 * refused to compile, and the two hand-written `<select>`s compiled cleanly while quietly
 * declining to offer the new kind. That is why `KNOWN_HAND_WRITTEN` is now empty rather
 * than three-long - the third kind is what proved the list had to go to zero.
 *
 * So the tuple is the registry, and this file pins both halves: the tuple's contents and
 * ORDER (which is the order every picker offers the choice in), and the absence of any
 * second copy of the SET anywhere in `src/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TASK_KIND, TASK_KINDS, type TaskKind } from "../src/shared/types.ts";
import {
  BACKLOG_TASK_KINDS,
  TASK_KIND_BEHAVIOR,
  TASK_KIND_INFO,
  hasReviewableDiff,
  providerOwnsTaskCompletion,
  taskKindAllowsBacklog,
} from "../src/shared/task.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The two registry homes: the ids, and the copy that presents them. These are where the
 * pair is SUPPOSED to be written out, and the only reason there are two is that what a
 * thing is called does not belong in the module that says what it is.
 */
const REGISTRIES = ["shared/types.ts", "shared/task.ts"];

/**
 * Independently owned kind vocabularies that happen to share task-kind words.
 *
 * Archive kinds are an append-only portable format contract, not a task-kind restatement:
 * `ship` is intentionally absent and future task kinds must not become archive kinds by
 * inheritance. Keep that registry independent and keep this syntax detector from treating
 * its deliberate overlap as a stale task picker.
 *
 * `task-gateway.ts` is the ONE place the two vocabularies meet - the map from a task kind to
 * the archive kind its work is captured as - so it necessarily writes archive-kind values
 * beside task-kind keys. It is exempt from the SYNTAX rule and not from the rule's purpose:
 * that map is a total `Record<TaskKind, ArchiveKind | null>`, so a fourth task kind fails to
 * compile until it has said whether it is archived, which is a stronger guarantee than this
 * scan can give. Adding a file here without that property would be the drift this file
 * exists to catch.
 */
const DISTINCT_KIND_REGISTRIES = ["shared/archives.ts", "server/archives/task-gateway.ts"];

/**
 * Kind `<select>`s that hand-write their `<option>`s. EMPTY, and it stays empty.
 *
 * It held two: `TaskSourcesPanel` and `ScheduleEditor`, each with its own wording -
 * "Ship - deliver a change" in one, "ship - deliver a change" in the other, bare "ship" in
 * the dispatch modal. Three surfaces, three answers to one question. They were listed
 * rather than fixed because unifying them changes what a person reads, and the change that
 * introduced this registry deliberately changed nothing on screen.
 *
 * Adding `plan` is what forced it. A hand-written list does not fail to compile when the
 * vocabulary grows - it just silently stops offering the new kind, which is precisely the
 * degradation the list was tracking rather than tolerating. Both now render from
 * `TASK_KIND_INFO`.
 *
 * Kept as an empty array rather than deleted, because the assertion below is an EXACT
 * match against it: an empty allowance is what makes a new hand-written list fail, and it
 * documents that zero is a reached position rather than one nobody has tested.
 */
const KNOWN_HAND_WRITTEN: string[] = [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

test("the kinds preserve the append-only order and derive the type from it", () => {
  assert.deepEqual([...TASK_KINDS], ["ship", "scout", "plan", "pipeline", "chat"]);
  // Order is a contract, not an accident of how they were typed: it is the order the
  // dispatch form lists the options in, and the order the guided pass offers them.
  assert.equal(TASK_KINDS[0], "ship", "ship leads - it is the default and the common case");
  // And `plan` was APPENDED. Asserted separately from the deep-equal above so a reordering
  // says which rule it broke: `ship` at index 0 is what `DEFAULT_TASK_KIND` derives from,
  // and every read path that degrades an unknown persisted kind lands on it.
  assert.equal(DEFAULT_TASK_KIND, "ship", "the default is the tuple's head, not a literal");
  // Derivation, checked in the direction that can actually fail. `TaskKind` is
  // `(typeof TASK_KINDS)[number]`, so a value the tuple does not hold is not assignable
  // and this file would not compile - which is the assertion.
  const every: readonly TaskKind[] = TASK_KINDS;
  assert.equal(every.length, 5);
});

test("every kind says how it is offered", () => {
  // `Record<TaskKind, …>` means a fourth kind cannot compile without its copy, so what is
  // left to check is that the copy is usable: an empty label renders a blank option, and
  // an empty `purpose` renders an option ending in a dangling "- " and tells Foreman's
  // backlog planner the kind means nothing.
  for (const kind of TASK_KINDS) {
    const info = TASK_KIND_INFO[kind];
    assert.ok(info, `${kind} has no presentation`);
    assert.ok(info.label.length > 0, `${kind} has no label`);
    assert.ok(info.blurb.length > 0, `${kind} has no blurb`);
    assert.ok(info.purpose.length > 0, `${kind} has no purpose`);
    assert.ok(TASK_KIND_BEHAVIOR[kind], `${kind} has no behavior`);
  }
  // Distinct, which the `Record` cannot check: two kinds sharing a label is a picker with
  // the same word twice, and sharing a purpose describes them to the planner as one thing.
  assert.equal(new Set(TASK_KINDS.map((k) => TASK_KIND_INFO[k].label)).size, TASK_KINDS.length);
  assert.equal(new Set(TASK_KINDS.map((k) => TASK_KIND_INFO[k].purpose)).size, TASK_KINDS.length);
});

test("the diffless kinds are the ones whose blurb promises no after-work", () => {
  // Two statements of one fact, in two places a person and the form each read - the blurb
  // in the picker, and the predicate the after-work rule acts on. They are checked against
  // each other rather than derived from each other on purpose: the blurb is prose that can
  // be reworded, and this fails when a rewording stops matching what the form actually does.
  for (const kind of TASK_KINDS) {
    const promisesNoAfterWork = TASK_KIND_INFO[kind].blurb.toLowerCase().includes("no after-work");
    assert.equal(
      hasReviewableDiff(kind),
      !promisesNoAfterWork,
      `${kind}'s blurb and its after-work behaviour disagree`,
    );
  }
  // The default kind is the one that HAS a diff, which is what makes preselecting a review
  // Workflow the right dispatch default in the first place.
  assert.equal(hasReviewableDiff(DEFAULT_TASK_KIND), true);
  assert.equal(hasReviewableDiff("plan"), false);
  assert.equal(hasReviewableDiff("scout"), false);
  assert.equal(hasReviewableDiff("pipeline"), false);
  assert.equal(hasReviewableDiff("chat"), false);
});

test("only chat is excluded from backlog-producing surfaces", () => {
  assert.deepEqual([...BACKLOG_TASK_KINDS], ["ship", "scout", "plan", "pipeline"]);
  assert.deepEqual(
    Object.fromEntries(TASK_KINDS.map((kind) => [kind, taskKindAllowsBacklog(kind)])),
    { ship: true, scout: true, plan: true, pipeline: true, chat: false },
  );
});

test("chat has the approved conversational copy", () => {
  assert.deepEqual(TASK_KIND_INFO.chat, {
    label: "chat",
    blurb: "Talk with an agent without a planned artifact. No after-work.",
    purpose: "have an open-ended conversation",
  });
  assert.deepEqual(TASK_KIND_BEHAVIOR.chat, {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: false,
    constraint: null,
  });
});

test("pipeline is provider-owned work and never backlog autopilot work", () => {
  assert.deepEqual(TASK_KIND_BEHAVIOR.pipeline, {
    repoAvailability: "pipeline-enabled",
    launch: "pipeline",
    autopilot: false,
    constraint:
      "Pipeline tasks use Conductor's configured Engineer host. Conductor owns its downstream agent, model, and effort; attached repos, after-work workflows, and backlog autopilot do not apply.",
  });
  assert.equal(providerOwnsTaskCompletion("pipeline"), true);
  assert.equal(providerOwnsTaskCompletion("ship"), false);
});

/**
 * Two or more ids written out together - on one line or on two adjacent ones, which is
 * every shape the drift actually took: `z.enum(["ship", "scout"])`,
 * `kind: "ship" | "scout"`, `k === "ship" || k === "scout"`, and a pair of consecutive
 * `<option>` elements.
 *
 * TWO and not all of them, which is the whole point of generalizing this when `plan`
 * arrived. Requiring the full set would have quietly stopped detecting at the exact moment
 * detection started mattering: every copy in the tree was a two-kind copy, and a two-kind
 * copy in a three-kind repository is not an out-of-date restatement to be tolerated - it
 * is the bug, a control that offers `ship` and `scout` and silently drops `plan`. A stale
 * subset must fail louder than a complete duplicate, not slip through it.
 *
 * Deliberately NOT "this file mentions two ids somewhere", which would flag
 * `settings-search.ts` for holding `scout` in one control's keywords and `ship` in
 * another's, two hundred lines apart. Naming a kind is fine; declaring the SET is what a
 * registry is for.
 */
function restatesTheSet(source: string): boolean {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const lines = bare.split("\n");
  return lines.some((line, i) => {
    const window = line + " " + (lines[i + 1] ?? "");
    return TASK_KINDS.filter((kind) => window.includes(`"${kind}"`)).length >= 2;
  });
}

test("nothing outside the registries declares the set of kinds", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (REGISTRIES.includes(rel) || DISTINCT_KIND_REGISTRIES.includes(rel)) continue;
    if (restatesTheSet(readFileSync(file, "utf8"))) offenders.push(rel);
  }
  // Exact, not a subset: a file that appears here is a new copy of the set and must read
  // `TASK_KINDS` instead, and a file that stops appearing has been fixed and should be
  // deleted from `KNOWN_HAND_WRITTEN` in the same change, so the list can only shrink.
  // It has now shrunk to nothing, which makes this the plain rule it was always heading
  // for: no file outside the two registries writes the vocabulary out.
  assert.deepEqual(offenders.sort(), KNOWN_HAND_WRITTEN);
});

test("the detector catches a stale subset, not just a complete copy", () => {
  // The regression this file exists to prevent, in the form it will actually arrive in:
  // somebody hand-writes the options they can see today and the newest kind is missing.
  // A detector keyed on the full set would call this clean.
  assert.equal(
    restatesTheSet(`<option value="ship">ship</option>\n<option value="scout">scout</option>`),
    true,
    "two kinds on adjacent lines is a restatement even when the third is absent",
  );
  assert.equal(restatesTheSet(`z.enum(["ship", "scout", "plan"])`), true);
  // And a single id is still just a mention. `routes.ts` files a ship task and says so;
  // that is naming a kind, not declaring the vocabulary.
  assert.equal(restatesTheSet(`kind: "ship",`), false);
  // Distance still matters - this is the `settings-search.ts` shape, and flagging it would
  // make the rule unusable.
  assert.equal(restatesTheSet(`keywords: ["scout"]\n\n\nkind: "ship"`), false);
});
