/**
 * What is at stake: twelve built-in versions now open a pull request two different ways, and
 * eleven of them may be pinned by bindings on operators' machines.
 *
 * Versions 5 through 7 reach End and then have the completion policy TYPE a handoff, recorded
 * as a `pr_handoff` delivery. Versions 8 onward open the pull request as an authored stage
 * before End, recorded as a `session_action` delivery linked to a node attempt. Version 8 retains
 * its Inspector gate; versions 9 onward complete locally after the verified action.
 *
 * The failure this file exists to catch is the quiet one: shared extraction that routes a
 * legacy version through the new path. It would look correct - a pull request still gets
 * opened - while changing the delivery kind a pinned version writes, the recovery fixtures
 * that read it, and the consent gates it passes through.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "session-action-legacy-pr-"));
process.env.HARNESS_HOME = join(home, "state");
after(() => rmSync(home, { recursive: true, force: true }));

const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
const { WORKFLOW_DELIVERY_KINDS } = await import("../src/shared/workflow.ts");

const noMistakes = () => BUILTIN_WORKFLOWS.find((item) => item.definition.name === "No-Mistakes Review")!;

before(() => {
  assert.equal(noMistakes().versions.length, 12, "this file is written against twelve versions");
});

test("both delivery kinds remain in the durable vocabulary, and neither replaced the other", () => {
  // `pr_handoff` is what versions 1 through 7 write and what their recovery reads. Removing it
  // in favour of the newer kind would not fail a type check anywhere - the rows are already on
  // disk - it would fail a restart on somebody's machine.
  assert.ok(WORKFLOW_DELIVERY_KINDS.includes("pr_handoff"));
  assert.ok(WORKFLOW_DELIVERY_KINDS.includes("session_action"));
});

test("legacy versions keep their post-End handoff policies while versions 9 onward need none", () => {
  // The split stated once, across all eight. A legacy version set to `wait` would reach End
  // with no pull request and no way to ask for one; version 8 set to `prepare_pr` would type a
  // second handoff asking for the pull request its own stage had just proven.
  const policies = noMistakes().versions.map((version) =>
    version.completionPolicy.kind === "inspector" ? version.completionPolicy.missingPrAction : null);
  assert.deepEqual(policies, [
    "offer_prepare_pr",
    "offer_prepare_pr",
    "offer_prepare_pr",
    "offer_prepare_pr",
    "prepare_pr",
    "prepare_pr",
    "prepare_pr",
    "wait",
    null,
    null,
    null,
    null,
  ]);
});

test("GitHub Inspector remains versions 1 through 8's policy and never becomes a graph node", () => {
  for (const [index, version] of noMistakes().versions.slice(0, 8).entries()) {
    assert.equal(
      version.completionPolicy.kind,
      "inspector",
      `version ${index + 1} lost its final gate`,
    );
    assert.equal(
      version.graph.nodes.some((node) => (node.kind as string) === "inspector"),
      false,
      `version ${index + 1} grew an Inspector node`,
    );
  }
  for (const [offset, version] of noMistakes().versions.slice(8).entries()) {
    assert.deepEqual(
      version.completionPolicy,
      { kind: "none" },
      `version ${offset + 9} acquired a gate it never published with`,
    );
  }
});

test("versions 8 onward author the pull request and reach End only through it", () => {
  const versions = noMistakes().versions;
  for (const [index, version] of versions.slice(0, 7).entries()) {
    // No action node, and End is reached from an evaluation join or reviewer exactly as it
    // was published. This is the assertion that fails if a shared extraction quietly rewrites
    // a pinned graph.
    assert.equal(
      version.graph.nodes.filter((node) => node.kind === "session_action").length,
      0,
      `version ${index + 1} grew an action node`,
    );
    assert.equal(
      version.graph.edges.some((edge) => edge.sourcePort === "complete"),
      false,
      `version ${index + 1} grew a complete route`,
    );
  }

  for (const current of versions.slice(7)) {
    const action = current.graph.nodes.find((node) => node.kind === "session_action");
    assert.ok(action && action.kind === "session_action");
    assert.deepEqual(action.action.completion, { kind: "pull_request" });
    const toEnd = current.graph.edges.filter((edge) => edge.target === current.graph.nodes
      .find((node) => node.kind === "end")!.id);
    assert.deepEqual(toEnd.map((edge) => [edge.source, edge.sourcePort]), [[action.id, "complete"]]);
  }
});

test("the shipped action's prompt is frozen into versions 8 onward, not referenced from them", () => {
  // A published version carries its own copy. Editing the shipped Markdown must not change
  // what a run already pinned to this version types - which is exactly what a reference,
  // resolved at run time, would do.
  for (const current of noMistakes().versions.slice(7)) {
    const node = current.graph.nodes.find((item) => item.kind === "session_action");
    assert.ok(node && node.kind === "session_action");
    assert.match(node.action.promptMarkdown, /^# Pull Request/);
    assert.equal(node.action.requiredSkillId, "pull-request");
    assert.equal(node.action.sourceSessionActionId, "builtin:pull-request");
  }
});
