import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StackLifecycle, runStackAction } from "../src/web/components/StackLifecycle.tsx";
import type { StackStanding } from "../src/shared/stacking.ts";

// The merge-queue / tile control for a stacked child: its buttons' busy state survives a
// request that throws, and a session nothing can type into is offered no clickable prompt.

test("a request that rejects still clears busy, and says what failed", async () => {
  const busy: boolean[] = [];
  const messages: (string | null)[] = [];
  let changed = 0;
  const state = { setBusy: (b: boolean) => busy.push(b), setMessage: (m: string | null) => messages.push(m), onChanged: () => { changed += 1; } };
  await runStackAction(() => Promise.reject(new Error("network down")), "Sent", state);
  assert.deepEqual(busy, [true, false], "busy is cleared after a rejection");
  assert.deepEqual(messages, [null, "network down"]);
  assert.equal(changed, 0);
  await runStackAction(() => Promise.reject("not an Error"), "Sent", state);
  assert.equal(busy.at(-1), false);
  assert.equal(messages.at(-1), "could not send it");
  await runStackAction(async () => ({ ok: true }), "Sent", state);
  assert.deepEqual(busy.slice(-2), [true, false]);
  assert.equal(messages.at(-1), "Sent");
  assert.equal(changed, 1);
});

function standing(over: Partial<StackStanding>): StackStanding {
  return {
    state: "broken", parentUrl: "https://github.com/acme/repo/pull/7", parentNumber: 7, brokenReason: "parent-closed",
    retargetError: null, prompt: null, actions: ["move-onto-main", "await-replacement"], awaitingReplacement: false,
    sessionId: "child-session", sentActions: [], sessionHasPane: true, parentTaskId: "parent", label: "Stack broken: #7 closed", inProgress: false,
    facts: { prNumber: 8, prUrl: "https://github.com/acme/repo/pull/8", headRefName: "feat/child", parentNumber: 7,
      parentUrl: "https://github.com/acme/repo/pull/7", parentHeadRefName: "feat/parent", defaultBranch: "main" },
    ...over,
  };
}

/** The rendered <button> with this text. Fails when it is absent, so "not disabled" can never pass vacuously. */
function button(html: string, name: string): string {
  const found = new RegExp(`<button[^>]*>${name}</button>`).exec(html)?.[0];
  assert.ok(found, `the "${name}" button is rendered`);
  return found;
}

test("a paneless owner's prompt-typed actions are shown but not pressable; the replacement choice still is", () => {
  const html = renderToStaticMarkup(createElement(StackLifecycle, { prKey: "acme/repo#8", standing: standing({ sessionHasPane: false }) }));
  assert.match(button(html, "Move onto main"), /disabled=""/, "nothing can type it into the session");
  assert.doesNotMatch(button(html, "Wait for a replacement"), /disabled=""/, "recording a choice needs no pane");
  const withPane = renderToStaticMarkup(createElement(StackLifecycle, { prKey: "acme/repo#8", standing: standing({}) }));
  assert.doesNotMatch(button(withPane, "Move onto main"), /disabled=""/);
});

test("a no-pane prompt shows its label and no send button", () => {
  const html = renderToStaticMarkup(createElement(StackLifecycle, { prKey: "acme/repo#8", standing: standing({
    state: "restack-needed", brokenReason: null, actions: [], sessionHasPane: false,
    prompt: { kind: "restack", tip: "e".repeat(40), status: "no-pane" },
    label: "Restack needed: the session has no pane to type into - resume its task to restore one",
  }) }));
  assert.match(html, /the session has no pane to type into - resume its task to restore one/);
  assert.doesNotMatch(html, /Send restack prompt/);
  // An uncertain delivery on a paneless owner keeps its re-arm visible, but not pressable.
  const uncertain = renderToStaticMarkup(createElement(StackLifecycle, { prKey: "acme/repo#8", standing: standing({
    state: "restack-needed", brokenReason: null, actions: [], sessionHasPane: false,
    prompt: { kind: "restack", tip: "e".repeat(40), status: "uncertain" }, label: "Restack prompt delivery uncertain",
  }) }));
  assert.match(button(uncertain, "Send restack prompt"), /disabled=""/);
});

test("a prompt delivered to a session that has gone offers the manual send to the resumed one", () => {
  const html = renderToStaticMarkup(createElement(StackLifecycle, { prKey: "acme/repo#8", standing: standing({
    state: "restack-needed", brokenReason: null, actions: [],
    prompt: { kind: "restack", tip: "e".repeat(40), status: "orphaned" },
    label: "Restack prompt went to a session that has gone - send it to the resumed one",
  }) }));
  assert.match(html, /went to a session that has gone/);
  assert.doesNotMatch(button(html, "Send restack prompt"), /disabled=""/, "the operator can send it");
});

test("the recovery buttons name the repository's own default branch", () => {
  const s = standing({});
  const html = renderToStaticMarkup(createElement(StackLifecycle, { prKey: "acme/repo#8",
    standing: { ...s, facts: { ...s.facts, defaultBranch: "trunk" } } }));
  assert.ok(button(html, "Move onto trunk"));
  assert.doesNotMatch(html, /Move onto main/);
});
