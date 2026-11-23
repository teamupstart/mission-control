/**
 * What is at stake: every control on an inbox card is declared once, with the words a voice
 * command would use for it or the reason it has none, so voice can be turned on later without
 * finding a card full of controls nobody declared.
 *
 * Two layers here. The registry itself: each entry has a spoken form or a click-only reason and
 * never both, and ids are unique. The control that draws an entry: a relabelled button keeps its
 * action's id and spoken form, and its hint stays hidden until voice turns hints on.
 *
 * No card in this phase draws its controls through `InboxActionButton`, so there is no card file
 * to scan for raw buttons yet. The phase that adds the first such card (the report card) adds
 * that scan with it, over a file that exists.
 *
 * The question card predates the registry, so only its two spoken forms are declared. Its name
 * line and hints are pinned below by rendering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  INBOX_ACTIONS,
  INBOX_CLICK_ONLY_REASONS,
  inboxAction,
  spokenHintText,
  type InboxActionSpec,
} from "../src/shared/inbox.ts";
import type { FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import { ResidentNamesContext, VoiceHintsContext } from "../src/web/lib/agent-names.ts";
import { InboxActionButton, SpokenHint } from "../src/web/components/AgentName.tsx";
import { ReviewCard } from "../src/web/components/ReviewModal.tsx";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

const actions: readonly InboxActionSpec[] = INBOX_ACTIONS;

test("every inbox action has a spoken form or a click-only reason, never both", () => {
  for (const action of actions) {
    const spoken = action.spoken !== null;
    const clickOnly = action.clickOnly !== null;
    assert.ok(spoken !== clickOnly, `${action.id} declares exactly one of spoken and clickOnly`);
    if (action.spoken) assert.ok(action.spoken.named.trim(), `${action.id} has a spoken form`);
    if (action.clickOnly) assert.ok(INBOX_CLICK_ONLY_REASONS.includes(action.clickOnly));
    assert.ok(action.label.trim(), `${action.id} has a label`);
  }
});

test("action ids are unique, and the question card's two forms are declared", () => {
  const ids = actions.map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(inboxAction("answer-option").spoken, { named: "{name}, option B", whileOpen: null });
  assert.deepEqual(inboxAction("answer").spoken, { named: "{name}, ...", whileOpen: "reply, ..." });
});

test("a hint fills in the agent's name, and adds the open-card form only while the card is open", () => {
  assert.equal(spokenHintText(inboxAction("answer"), "Steve"), '"Steve, ..."');
  assert.equal(spokenHintText(inboxAction("answer"), "Steve", true), '"Steve, ..." or "reply, ..."');
  assert.equal(spokenHintText(inboxAction("answer-option"), "Steve", true), '"Steve, option B"');
  assert.equal(spokenHintText({ id: "x", label: "X", spoken: null, clickOnly: "navigation" }, "Steve"), null);
});

const voice = (on: boolean, node: ReactElement) => createElement(VoiceHintsContext.Provider, { value: on }, node);

test("a spoken hint renders nothing until voice turns hints on", () => {
  assert.equal(renderToStaticMarkup(createElement(SpokenHint, { action: "answer", name: "Steve" })), "");
  assert.equal(
    renderToStaticMarkup(voice(true, createElement(SpokenHint, { action: "answer", name: "Steve" }))),
    '<span class="spoken-hint" data-spoken-action="answer">&quot;Steve, ...&quot;</span>',
  );
});

test("a relabelled button keeps its action's id and spoken form", () => {
  const draw = (label?: string) => renderToStaticMarkup(voice(true, createElement(InboxActionButton, {
    action: "answer", name: "Steve", tooltip: "Send it", onClick: () => undefined, ...(label ? { label } : {}),
  })));
  const plain = draw();
  const relabelled = draw("Retry");
  assert.match(plain, />Send answer<\/button>/);
  assert.match(relabelled, />Retry<\/button>/);
  for (const html of [plain, relabelled]) {
    assert.match(html, /data-inbox-action="answer"/);
    assert.match(html, /data-spoken-action="answer">&quot;Steve, \.\.\.&quot;</);
  }
  // Off, the button is all there is: no control and no text appears for the seam.
  const off = renderToStaticMarkup(createElement(InboxActionButton, {
    action: "answer", name: "Steve", tooltip: "Send it", onClick: () => undefined,
  }));
  assert.doesNotMatch(off, /spoken-hint/);
});

/**
 * The `<button>` an `InboxActionButton` draws, found in the element tree it returns. Called as a
 * function, as `ensemble-compare.test.ts` does for its rationale links: the repository's tests
 * render without a DOM, so the click is the button's own `onClick` prop, the one React binds.
 */
function drawnButton(props: Parameters<typeof InboxActionButton>[0]): ReactElement<{
  onClick: () => void;
  disabled: boolean;
  "data-inbox-action": string;
  children: string;
}> {
  const fragment = InboxActionButton(props) as ReactElement<{ children: unknown[] }>;
  const tooltip = fragment.props.children.find(isValidElement) as ReactElement<{ children: unknown }>;
  const button = tooltip.props.children;
  assert.ok(isValidElement(button) && button.type === "button", "the control is a <button> inside its Tooltip");
  return button as ReturnType<typeof drawnButton>;
}

test("clicking an inbox action button runs the action it was given, once, under either label", () => {
  for (const label of [undefined, "Retry"]) {
    let calls = 0;
    const button = drawnButton({
      action: "answer", name: "Steve", tooltip: "Send it", onClick: () => { calls++; }, ...(label ? { label } : {}),
    });
    assert.equal(button.props.children, label ?? "Send answer");
    assert.equal(button.props["data-inbox-action"], "answer");
    assert.equal(button.props.disabled, false);
    button.props.onClick();
    assert.equal(calls, 1, `the ${label ?? "default"} label's click runs its handler exactly once`);
  }
  // Disabled reaches the button itself, so the browser withholds the click.
  assert.equal(drawnButton({ action: "answer", name: "Steve", tooltip: "t", onClick: () => undefined, disabled: true }).props.disabled, true);
});

// ---- the question card: a name line and its hints ----

const question: ReviewItem = {
  id: "q1",
  sessionId: "s1",
  kind: "input",
  title: "Which linter should this repo use?",
  body: "Which linter should this repo use?",
  status: "pending",
  response: null,
  createdAt: 1,
  resolvedAt: null,
};
const withOptions: ReviewItem = {
  ...question,
  decisions: [{ id: "q", question: question.title, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] }],
};

function card(review: ReviewItem, flags: { inbox: boolean; voice?: boolean; resident?: boolean }): string {
  const session = mkSession({ id: "s1", name: "lint-session", task: mkTaskSummary({ id: "t1", title: "Add a linter" }) });
  const config: FeatureFlagsConfig = { enableAll: false, overrides: flags.inbox ? { inbox: true } : {} };
  const runs = flags.resident
    ? [{ taskId: "t1", settings: { identity: { name: "Linter watcher" }, board: { colorId: "violet" } } }]
    : [];
  return renderToStaticMarkup(
    createElement(FeatureFlagsContext.Provider, { value: config },
      createElement(ResidentNamesContext.Provider, { value: runs },
        voice(flags.voice ?? false, createElement(ReviewCard, { review, session })))),
  );
}

test("with the inbox flag off a question card draws no name line, exactly as before", () => {
  assert.doesNotMatch(card(question, { inbox: false }), /review-agent/);
  assert.doesNotMatch(card(question, { inbox: false, resident: true }), /Linter watcher/);
});

test("with the inbox flag on a question card names its agent in the head", () => {
  assert.match(card(question, { inbox: true }), /<strong class="review-agent">Add a linter<\/strong><h3>/);
});

test("a resident's name on a question card is drawn in its board colour", () => {
  assert.match(
    card(question, { inbox: true, resident: true }),
    /<strong class="review-agent agent-name-resident" style="--resident:var\(--resident-violet\)">Linter watcher<\/strong>/,
  );
});

test("a question card's spoken hints address the agent, and stay hidden until voice turns them on", () => {
  for (const review of [question, withOptions]) assert.doesNotMatch(card(review, { inbox: true }), /spoken-hint/);
  const open = card(question, { inbox: true, voice: true, resident: true });
  assert.match(open, /data-spoken-action="answer">&quot;Linter watcher, \.\.\.&quot; or &quot;reply, \.\.\.&quot;</);
  const options = card(withOptions, { inbox: true, voice: true, resident: true });
  assert.match(options, /data-spoken-action="answer-option">&quot;Linter watcher, option B&quot;</);
});
