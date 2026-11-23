/**
 * What is at stake: every control on an inbox card is declared once, with the words a voice
 * command would use for it or the reason it has none, so voice can be turned on later without
 * finding a card full of controls nobody declared.
 *
 * Two layers here. The registry itself: each entry has a spoken form or a click-only reason and
 * never both, and ids are unique. The control that draws an entry: a relabelled button keeps its
 * action's id and spoken form, and its hint stays hidden until voice turns hints on.
 *
 * The scan below reads each card file that draws its controls through `InboxActionButton` and
 * fails on a raw button or link, or on an action id the registry does not declare. The Stuck
 * card is the first such file; a later card adds its own file to `CARD_FILES`.
 *
 * The question card predates the registry, so only its two spoken forms are declared. Its name
 * line and hints are pinned below by rendering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
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

// ---- card files: every control is a declared action ----

const CARD_FILES = ["../src/web/components/StuckCard.tsx"];

test("a card file draws no raw button or link, and every action it draws is declared", () => {
  const declared = new Set(actions.map((action) => action.id));
  for (const file of CARD_FILES) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /<button\b/, `${file} draws a raw <button>`);
    assert.doesNotMatch(source, /<a\b/, `${file} draws a raw <a>`);
    const used = [...source.matchAll(/action="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(used.length > 0, `${file} draws no InboxActionButton`);
    for (const id of used) assert.ok(declared.has(id), `${file} draws undeclared action ${id}`);
  }
});

test("the Stuck card's ten actions are declared with the spoken forms or reasons the plan gives", () => {
  const stuck: Record<string, InboxActionSpec["spoken"] | InboxActionSpec["clickOnly"]> = {
    nudge: { named: "{name}, nudge", whileOpen: null },
    continue: { named: "{name}, continue", whileOpen: null },
    "mark-done": { named: "{name}, mark done", whileOpen: null },
    resubmit: { named: "{name}, resubmit", whileOpen: null },
    push: { named: "{name}, push", whileOpen: null },
    stop: { named: "{name}, stop", whileOpen: null },
    message: { named: "{name}, ...", whileOpen: "reply, ..." },
    "open-session": "navigation",
    "open-run": "navigation",
    dismiss: "dismissal",
  };
  assert.equal(Object.keys(stuck).length, 10);
  for (const [id, expected] of Object.entries(stuck)) {
    const action = actions.find((entry) => entry.id === id);
    assert.ok(action, `${id} is declared`);
    if (typeof expected === "string") assert.equal(action.clickOnly, expected, id);
    else assert.deepEqual(action.spoken, expected, id);
  }
  assert.equal(actions.find((entry) => entry.id === "stop")?.label, "Interrupt");
  assert.equal(actions.find((entry) => entry.id === "push")?.label, "Tell it to push");
  assert.ok(!actions.some((entry) => /cancel/i.test(entry.id) || /cancel/i.test(entry.label)), "no inbox action is Cancel");
});
