import assert from "node:assert/strict";
import test from "node:test";

import { createTourTargetRegistry } from "../src/web/tour/target-registry.ts";

const LINE_TARGET = "line" as const;

function element(id: string): HTMLElement {
  return { id } as HTMLElement;
}

test("a missing semantic target returns null", () => {
  const registry = createTourTargetRegistry();
  assert.equal(registry.get(LINE_TARGET), null);
});

test("the latest owner replaces the prior registration", () => {
  const registry = createTourTargetRegistry();
  const first = element("first");
  const replacement = element("replacement");

  registry.register(LINE_TARGET, first);
  registry.register(LINE_TARGET, replacement);

  assert.equal(registry.get(LINE_TARGET), replacement);
});

test("a stale owner unmount cannot clear a newer registration", () => {
  const registry = createTourTargetRegistry();
  const first = element("first");
  const replacement = element("replacement");
  const unregisterFirst = registry.register(LINE_TARGET, first);
  const unregisterReplacement = registry.register(LINE_TARGET, replacement);

  unregisterFirst();
  assert.equal(registry.get(LINE_TARGET), replacement);

  unregisterReplacement();
  assert.equal(registry.get(LINE_TARGET), null);
});

test("registration identity survives Strict Mode replay of the same element", () => {
  const registry = createTourTargetRegistry();
  const line = element("line");
  const unregisterFirst = registry.register(LINE_TARGET, line);
  const unregisterReplay = registry.register(LINE_TARGET, line);

  unregisterFirst();
  assert.equal(registry.get(LINE_TARGET), line);

  unregisterReplay();
  assert.equal(registry.get(LINE_TARGET), null);
});

test("the Dispatch modal fields and submit owner remain independent targets", () => {
  const registry = createTourTargetRegistry();
  const modal = element("dispatch-modal");
  const kind = element("dispatch-kind");
  const input = element("dispatch-input");
  const workflow = element("dispatch-workflow");
  const submit = element("dispatch-submit");

  registry.register("dispatch-modal", modal);
  registry.register("dispatch-kind", kind);
  registry.register("dispatch-input", input);
  registry.register("dispatch-workflow", workflow);
  registry.register("dispatch-submit", submit);

  assert.equal(registry.get("dispatch-modal"), modal);
  assert.equal(registry.get("dispatch-kind"), kind);
  assert.equal(registry.get("dispatch-input"), input);
  assert.equal(registry.get("dispatch-workflow"), workflow);
  assert.equal(registry.get("dispatch-submit"), submit);
});

test("the Complete dialog can register independently from its action-row owner", () => {
  const registry = createTourTargetRegistry();
  const actions = element("session-actions");
  const complete = element("complete-modal");

  registry.register("session-actions", actions);
  registry.register("complete-modal", complete);

  assert.equal(registry.get("session-actions"), actions);
  assert.equal(registry.get("complete-modal"), complete);
});
