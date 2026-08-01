import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionGoal } from "../src/shared/types.ts";
import { ForemanDrawer } from "../src/web/components/ForemanDrawer.tsx";
import { intentRefreshStamp } from "../src/web/components/layouts/ConsoleDetail.tsx";

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    noteKey: "session-1",
    text: "Make Foreman track the durable objective",
    source: "model",
    objective: "Make Foreman track the durable objective",
    prompt: "Also show the current interpretation in the notes drawer",
    focus: "Show the current interpretation in the notes drawer",
    relationship: "amend",
    rationale: "The new instruction adds a user-visible requirement to the same outcome.",
    objectiveVersion: 2,
    promptRevision: 4,
    resolvedPromptRevision: 4,
    pendingPrompts: [],
    updatedAt: 1,
    ...over,
  };
}

function render(intent: SessionGoal | null): string {
  return renderToStaticMarkup(
    createElement(ForemanDrawer, {
      episodes: [],
      intent,
      open: true,
      onClose: () => undefined,
    }),
  );
}

test("the Foreman drawer exposes the objective, tactical focus, and interpretation", () => {
  const html = render(goal());
  assert.match(html, /Current intent/);
  assert.match(html, /objective v2/);
  assert.match(html, /Make Foreman track the durable objective/);
  assert.match(html, /Show the current interpretation in the notes drawer/);
  assert.match(html, /objective amended/);
  assert.match(html, /adds a user-visible requirement/);
  assert.match(html, /Decision history/);
});

test("the Foreman drawer makes an unresolved instruction visibly pause wrap-up", () => {
  const html = render(goal({ promptRevision: 5, resolvedPromptRevision: 4, relationship: null }));
  assert.match(html, /reconciling/);
  assert.match(html, /Automatic wrap-up is paused/);
});

test("the Foreman drawer has a useful pre-objective state", () => {
  const html = render(null);
  assert.match(html, /Waiting for the session&#x27;s first substantive instruction/);
});

test("the drawer refresh stamp advances when reconciliation resolves", () => {
  const pending = {
    text: "Keep the original objective",
    source: "model" as const,
    focus: "Classify the new instruction",
    relationship: null,
    objectiveVersion: 1,
    promptRevision: 2,
    resolvedPromptRevision: 1,
    updatedAt: 1,
  };

  assert.notEqual(
    intentRefreshStamp(pending),
    intentRefreshStamp({ ...pending, relationship: "steer", resolvedPromptRevision: 2 }),
    "a resolved steering instruction must refetch the full intent",
  );
  assert.notEqual(
    intentRefreshStamp(pending),
    intentRefreshStamp({
      ...pending,
      text: "Use the amended completion contract",
      relationship: "amend",
      objectiveVersion: 2,
      resolvedPromptRevision: 2,
    }),
    "a resolved objective amendment must refetch the full intent",
  );
  assert.notEqual(
    intentRefreshStamp(pending),
    intentRefreshStamp({ ...pending, objectiveVersion: 2 }),
    "an objective-version change must refetch the full intent",
  );
});
