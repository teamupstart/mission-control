/**
 * What is at stake: every control on an inbox card is declared once, with the words a voice
 * command would use for it or the reason it has none, so voice can be turned on later without
 * finding a card full of controls nobody declared.
 *
 * Two layers here. The registry itself: each entry has a spoken form or a click-only reason and
 * never both, and ids are unique. The control that draws an entry: a relabelled button keeps its
 * action's id and spoken form, and its hint stays hidden until voice turns hints on.
 *
 * Every card file that draws its controls through `InboxActionButton` is scanned for a control
 * drawn any other way: a raw `<button>` or an `onClick` on anything else would be a control voice
 * could never reach. The report card and the Stuck card are scanned; later cards join `CARD_FILES`.
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

/** Cards whose controls are all drawn through `InboxActionButton`. */
const CARD_FILES = ["src/web/components/ReportCard.tsx", "src/web/components/StuckCard.tsx"];

test("a card file draws no control except through InboxActionButton, and names only declared actions", () => {
  const declared = new Set(actions.map((action) => action.id));
  for (const file of CARD_FILES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /<button\b/, `${file} draws a raw <button>`);
    assert.doesNotMatch(source, /<(?!InboxActionButton\b)[A-Za-z][\w.]*[^>]*\sonClick=/, `${file} puts onClick on something other than InboxActionButton`);
    const used = [...source.matchAll(/<InboxActionButton[\s\S]*?action="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(used.length > 0, `${file} draws no InboxActionButton`);
    for (const id of used) assert.ok(declared.has(id), `${file} draws undeclared action ${id}`);
  }
});

test("the report card's two controls: toggle is click-only disclosure, Mark read has its spoken form", () => {
  assert.deepEqual(inboxAction("toggle").spoken, null);
  assert.equal(inboxAction("toggle").clickOnly, "disclosure");
  assert.deepEqual(inboxAction("mark-read").spoken, { named: "{name}, mark read", whileOpen: null });
  assert.equal(inboxAction("mark-read").clickOnly, null);
  assert.equal(spokenHintText(inboxAction("mark-read"), "Steve", true), '"Steve, mark read"');
  assert.equal(spokenHintText(inboxAction("toggle"), "Steve"), null);
});

test("the report card's Mark read shows its hint once voice turns hints on; the toggle never does", async () => {
  const { ReportCard } = await import("../src/web/components/ReportCard.tsx");
  const { mkReport } = await import("./helpers/report-fixture.ts");
  const report = mkReport({ id: "r-1", author: { key: "resident:steve", name: "Steve", residentProfileId: "steve" } });
  const draw = (on: boolean) => renderToStaticMarkup(voice(on, createElement(ReportCard, {
    report, open: true, onToggle: () => undefined, onMarkRead: () => undefined, now: 1,
  })));
  assert.doesNotMatch(draw(false), /spoken-hint/);
  const on = draw(true);
  assert.match(on, /data-spoken-action="mark-read">&quot;Steve, mark read&quot;</);
  assert.doesNotMatch(on, /data-spoken-action="toggle"/);
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
