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
import { VoiceAnswersContext } from "../src/web/lib/voice-open-cards.ts";
import { VoiceRosterContext } from "../src/web/lib/voice-roster.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
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

type DrawnButton = ReactElement<{
  onClick: () => void;
  disabled: boolean;
  "data-inbox-action": string;
  children: string;
}>;

/** The first `<button>` in an element tree that names an inbox action, wherever it sits. */
function findActionButton(node: unknown): DrawnButton | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findActionButton(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: unknown; "data-inbox-action"?: string }>(node)) return null;
  if (node.type === "button" && node.props["data-inbox-action"] !== undefined) return node as DrawnButton;
  return findActionButton(node.props.children);
}

/**
 * The `<button>` an `InboxActionButton` draws, found anywhere in the element tree it returns, so
 * the test depends on there being an action button and not on how the markup around it is nested.
 * Called as a function, as `ensemble-compare.test.ts` does for its rationale links: the
 * repository's tests render without a DOM, so the click is the button's own `onClick` prop, the one
 * React binds. Children that are components (`Tooltip`, `SpokenHint`) are not rendered, only walked.
 */
function drawnButton(props: Parameters<typeof InboxActionButton>[0]): DrawnButton {
  const button = findActionButton(InboxActionButton(props));
  assert.ok(button, "InboxActionButton draws a <button> that names its action");
  return button;
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
  const roster: SpokenName[] = flags.resident ? [{ kind: "resident", key: "resident:lint", name: "Linter watcher",
    role: "Watch the linter", colorId: "violet", state: "running", sessionId: review.sessionId, taskId: "t1", agent: "claude" }] : [];
  const questionCard = createElement(VoiceRosterContext.Provider, { value: roster },
    createElement(VoiceAnswersContext.Provider, { value: flags.voice ? new Map() : null }, createElement(ReviewCard, { review, session })));
  return renderToStaticMarkup(
    createElement(FeatureFlagsContext.Provider, { value: config },
      createElement(ResidentNamesContext.Provider, { value: runs },
        voice(flags.voice ?? false, questionCard))),
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
  for (const review of [question, withOptions]) assert.doesNotMatch(card(review, { inbox: true }), /vh-foot|av-key/);
  const open = card(question, { inbox: true, voice: true, resident: true });
  assert.match(open, /Say <q>Linter watcher, answer: …<\/q> to answer in your own words/);
  const options = card(withOptions, { inbox: true, voice: true, resident: true });
  assert.match(options, /Say <q>Linter watcher, option B<\/q> to answer, or/);
  assert.match(card(withOptions, { inbox: true, voice: true }), /with this card open, say <q>reply, option A<\/q>/);
});

// ---- card files: every control is a declared action ----

/** Cards whose controls are all drawn through `InboxActionButton`. */
const CARD_FILES = ["src/web/components/ReportCard.tsx", "src/web/components/ReportEntryCard.tsx", "src/web/components/StuckCard.tsx"];

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
  const { mkReport, reportCardProps } = await import("./helpers/report-fixture.ts");
  const report = mkReport({ id: "r-1", author: { key: "resident:steve", name: "Steve", residentProfileId: "steve" } });
  const draw = (on: boolean) => renderToStaticMarkup(voice(on, createElement(ReportCard, {
    report, open: true, ...reportCardProps(), now: 1,
  })));
  assert.doesNotMatch(draw(false), /spoken-hint/);
  const on = draw(true);
  assert.match(on, /data-spoken-action="mark-read">&quot;Steve, mark read&quot;</);
  assert.doesNotMatch(on, /data-spoken-action="toggle"/);
});

// ---- replying, and following up a report whose agent is gone (Phase 3) ----

test("reply and follow-up are declared with their spoken forms", () => {
  assert.deepEqual(inboxAction("reply").spoken, { named: "{name}, ...", whileOpen: "reply, ..." });
  assert.equal(inboxAction("reply").clickOnly, null);
  assert.deepEqual(inboxAction("follow-up").spoken, { named: "{name}, follow up, ...", whileOpen: "reply, ..." });
  assert.equal(inboxAction("follow-up").label, "Start a follow-up task");
  assert.equal(inboxAction("follow-up").clickOnly, null);
  // Retry is the follow-up action under another label, never an action of its own.
  assert.equal(actions.some((action) => action.id === "retry" || action.label === "Retry"), false);
});

async function drawCard(
  target: import("../src/shared/reports.ts").ReplyTarget,
  over: Partial<import("../src/shared/reports.ts").ReportItem> = {},
  hints = false,
): Promise<string> {
  const { ReportCard } = await import("../src/web/components/ReportCard.tsx");
  const { mkReport, reportCardProps } = await import("./helpers/report-fixture.ts");
  const report = mkReport({ id: "r-1", author: { key: "resident:steve", name: "Steve", residentProfileId: "steve" }, ...over });
  return renderToStaticMarkup(voice(hints, createElement(ReportCard, { report, open: true, ...reportCardProps(target), now: 1 })));
}

test("a live agent's report card has a reply box that sends with the reply action", async () => {
  const html = await drawCard({ kind: "live", sessionId: "s1" }, {}, true);
  assert.match(html, /<textarea[^>]*aria-label="Reply to Steve"/);
  assert.match(html, /data-inbox-action="reply"[^>]*>Send reply<\/button>/);
  assert.match(html, /data-spoken-action="reply">&quot;Steve, \.\.\.&quot; or &quot;reply, \.\.\.&quot;</);
  assert.doesNotMatch(html, /data-inbox-action="follow-up"/);
});

test("a resident that is not running gets a line and a relaunch hint, and no control", async () => {
  const html = await drawCard({ kind: "resident-not-running" });
  assert.match(html, /Steve isn&#x27;t running\./);
  assert.match(html, /launch it again from the Residents drawer/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /data-inbox-action="(reply|follow-up)"/);
  // Mark read is still there: reading a report needs no running agent.
  assert.match(html, /data-inbox-action="mark-read"/);
});

test("a gone standard session offers Start a follow-up task; with no repository, a line instead", async () => {
  const gone = await drawCard({ kind: "gone" }, {}, true);
  assert.match(gone, /<textarea[^>]*aria-label="Instructions for the follow-up task"/);
  assert.match(gone, /data-inbox-action="follow-up"[^>]*>Start a follow-up task<\/button>/);
  assert.match(gone, /data-spoken-action="follow-up">&quot;Steve, follow up, \.\.\.&quot;/);
  assert.match(gone, /never resumed/);
  assert.doesNotMatch(gone, /data-inbox-action="reply"/);
  const none = await drawCard({ kind: "gone-no-repository" });
  assert.match(none, /a follow-up task\s+cannot be started from here/);
  assert.doesNotMatch(none, /data-inbox-action="(reply|follow-up)"/);
});

test("a running session that cannot take a message gets a line, and neither a reply nor a follow-up", async () => {
  const html = await drawCard({ kind: "unreachable", sessionId: "s1" });
  assert.match(html, /session is still running but cannot take a message from here/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /data-inbox-action="(reply|follow-up)"/);
  assert.match(html, /data-inbox-action="mark-read"/);
});

test("after a failed dispatch the card says so, and Retry carries the follow-up action id", async () => {
  const html = await drawCard({ kind: "gone" }, { followUpTaskId: "t-follow" }, true);
  assert.match(html, /Follow-up task created but not started\./);
  assert.match(html, /data-inbox-action="follow-up"[^>]*>Retry<\/button>/);
  // Its spoken form is the follow-up action's: Retry has none of its own.
  assert.match(html, /data-spoken-action="follow-up">&quot;Steve, follow up, \.\.\.&quot;/);
  // No box that would file a second task.
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, />Start a follow-up task</);
});

test("a conversation entry draws its toggle and Mark read as declared actions, and says how it stands", async () => {
  const { ReportEntryCard } = await import("../src/web/components/ReportEntryCard.tsx");
  const { mkReport } = await import("./helpers/report-fixture.ts");
  const draw = (over: Partial<import("../src/shared/reports.ts").ReportItem>, open = false) =>
    renderToStaticMarkup(voice(true, createElement(ReportEntryCard, {
      report: mkReport({ id: "r-2", title: "Build failure diagnosed", author: { key: "resident:steve", name: "Steve", residentProfileId: "steve" }, ...over }),
      open,
      onToggle: () => undefined,
      onMarkRead: async () => null,
      onOpenDocument: () => undefined,
    })));
  const waiting = draw({}, true);
  assert.match(waiting, /aria-label="Report: Build failure diagnosed"/);
  assert.match(waiting, />Report<\/span>/);
  assert.match(waiting, /data-inbox-action="toggle"[^>]*>Build failure diagnosed<\/button>/);
  assert.match(waiting, /Waiting to be read/);
  assert.match(waiting, /data-inbox-action="mark-read"[^>]*>Mark read<\/button>/);
  assert.match(waiting, /data-spoken-action="mark-read">&quot;Steve, mark read&quot;</);
  assert.match(waiting, /What I found\./, "open, it shows the body");
  assert.doesNotMatch(draw({}), /What I found\./, "closed, it does not");

  const replied = draw({ readAt: 5, readBy: "reply" });
  assert.match(replied, /Replied to/);
  assert.doesNotMatch(replied, /data-inbox-action="mark-read"/);
  assert.match(draw({ readAt: 5, readBy: "follow-up" }), /Followed up in a new task/);
  const replaced = draw({ supersededBy: "r-3" });
  assert.match(replaced, /Replaced by a later version/);
  assert.doesNotMatch(replaced, /data-inbox-action="mark-read"/);
  assert.match(draw({ version: 2, rootId: "r-1" }), /Version 2, replacing an earlier report/);
});

// ---- a report's attached document: Open report and Publish as scout (Phase 4) ----

test("open-report and publish-scout are declared with their spoken forms; open-archive is click-only navigation", () => {
  assert.deepEqual(inboxAction("open-report").spoken, { named: "{name}, open report", whileOpen: null });
  assert.equal(inboxAction("open-report").label, "Open report");
  assert.equal(inboxAction("open-report").clickOnly, null);
  assert.deepEqual(inboxAction("publish-scout").spoken, { named: "{name}, publish as scout", whileOpen: null });
  assert.equal(inboxAction("publish-scout").label, "Publish as scout");
  assert.equal(inboxAction("publish-scout").clickOnly, null);
  assert.equal(inboxAction("open-archive").spoken, null);
  assert.equal(inboxAction("open-archive").clickOnly, "navigation");
  assert.equal(spokenHintText(inboxAction("open-archive"), "Steve"), null);
});

test("a report card offers Open report and Publish as scout only for a report with a document, then Published and Open archive", async () => {
  const { ReportCard } = await import("../src/web/components/ReportCard.tsx");
  const { mkReport, reportCardProps } = await import("./helpers/report-fixture.ts");
  const author = { key: "resident:steve", name: "Steve", residentProfileId: "steve" };
  const draw = (over: Partial<import("../src/shared/reports.ts").ReportItem>) =>
    renderToStaticMarkup(voice(true, createElement(ReportCard, {
      report: mkReport({ id: "r-7", author, ...over }), open: true, ...reportCardProps(), now: 1,
    })));
  const bare = draw({});
  assert.doesNotMatch(bare, /data-inbox-action="open-report"/);
  assert.doesNotMatch(bare, /data-inbox-action="publish-scout"/);

  const unpublished = draw({ document: { name: "findings.html", kind: "html" } });
  assert.match(unpublished, /Attached: findings\.html/);
  assert.match(unpublished, /data-inbox-action="open-report"[^>]*>Open report<\/button>/);
  assert.match(unpublished, /data-inbox-action="publish-scout"[^>]*>Publish as scout<\/button>/);
  assert.match(unpublished, /data-spoken-action="open-report">&quot;Steve, open report&quot;</);
  assert.match(unpublished, /data-spoken-action="publish-scout">&quot;Steve, publish as scout&quot;</);
  assert.doesNotMatch(unpublished, /data-inbox-action="open-archive"/);

  const published = draw({ document: { name: "findings.html", kind: "html" }, publishedArchiveKey: "a~b" });
  assert.match(published, />Published<\/span>/);
  assert.match(published, /data-inbox-action="open-archive"[^>]*>Open archive<\/button>/);
  assert.doesNotMatch(published, /data-inbox-action="publish-scout"/);
  assert.doesNotMatch(published, /data-spoken-action="open-archive"/, "navigation is never spoken");
});

test("a conversation entry offers Open report for a report with a document, and never Publish as scout", async () => {
  const { ReportEntryCard } = await import("../src/web/components/ReportEntryCard.tsx");
  const { mkReport } = await import("./helpers/report-fixture.ts");
  const draw = (over: Partial<import("../src/shared/reports.ts").ReportItem>) =>
    renderToStaticMarkup(createElement(ReportEntryCard, {
      report: mkReport({ id: "r-8", ...over }),
      open: true,
      onToggle: () => undefined,
      onMarkRead: async () => null,
      onOpenDocument: () => undefined,
    }));
  assert.doesNotMatch(draw({}), /data-inbox-action="open-report"/);
  const withDocument = draw({ document: { name: "notes.md", kind: "markdown" } });
  assert.match(withDocument, /data-inbox-action="open-report"[^>]*>Open report<\/button>/);
  assert.doesNotMatch(withDocument, /data-inbox-action="publish-scout"/);
});

test("a report card draws Publish as scout's state from the dashboard, so a refusal or a request in flight survives a remount", async () => {
  const { ReportCard } = await import("../src/web/components/ReportCard.tsx");
  const { mkReport, reportCardProps } = await import("./helpers/report-fixture.ts");
  const report = mkReport({ id: "r-9", document: { name: "live.html", kind: "html" } });
  const draw = (publishState: import("../src/web/lib/sessionReports.ts").ReportPublishState) =>
    renderToStaticMarkup(createElement(ReportCard, { report, open: true, ...reportCardProps(), publishState, now: 1 }));

  // A fresh mount handed a stored refusal shows it: nothing about it lived in the card.
  const refused = draw({ busy: false, refusal: { error: "a", problems: ["<script> is not allowed in an archived report", "the https: scheme is not allowed in an archived report"], failed: false } });
  assert.match(refused, /Not published\. The archive refused this document:/);
  assert.match(refused, /<li>&lt;script&gt; is not allowed in an archived report<\/li>/);
  assert.match(refused, /<li>the https: scheme is not allowed in an archived report<\/li>/);

  // A request still in flight keeps the button disabled on a fresh mount, so it cannot be sent twice.
  assert.match(draw({ busy: true, refusal: null }), /<button[^>]*disabled=""[^>]*data-inbox-action="publish-scout"/);
  assert.doesNotMatch(draw({ busy: false, refusal: null }), /role="alert"/);
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

// ---- report noise controls (Phase 7) ----

test("Mute has its spoken form; Mark all read is click-only and section-wide", () => {
  assert.deepEqual(inboxAction("mute").spoken, { named: "{name}, mute reports", whileOpen: null });
  assert.equal(inboxAction("mute").clickOnly, null);
  assert.equal(spokenHintText(inboxAction("mute"), "Steve", true), '"Steve, mute reports"');
  assert.equal(inboxAction("mark-all-read").spoken, null);
  assert.equal(inboxAction("mark-all-read").clickOnly, "section-wide");
  assert.equal(inboxAction("mark-all-read").label, "Mark all read");
  // Declined by the operator: there is no per-agent Mark all read.
  assert.equal(actions.filter((action) => /mark-all/.test(action.id)).length, 1);
});

test("the report card draws Mute through its action with the spoken hint, and none for a muted author", async () => {
  const { ReportCard } = await import("../src/web/components/ReportCard.tsx");
  const { mkReport, reportCardProps } = await import("./helpers/report-fixture.ts");
  const report = mkReport({ id: "r-1", author: { key: "resident:steve", name: "Steve", residentProfileId: "steve" } });
  const draw = (muted: boolean) => renderToStaticMarkup(voice(true, createElement(ReportCard, {
    report, open: true, ...reportCardProps(), muted, onMute: () => undefined, now: 1,
  })));
  const open = draw(false);
  assert.match(open, /data-inbox-action="mute"[^>]*>Mute Steve&#x27;s reports<\/button>/);
  assert.match(open, /data-spoken-action="mute">&quot;Steve, mute reports&quot;</);
  const muted = draw(true);
  assert.doesNotMatch(muted, /data-inbox-action="mute"/);
  assert.match(muted, /Steve&#x27;s reports are muted/);
  assert.match(muted, /Unmute in Settings &gt; Reports\./);
});
