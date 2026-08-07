import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../src/shared/types.ts";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { SessionWorkflowsPane } from "../src/web/components/SessionWorkflowsPane.tsx";
import { detailTabs } from "../src/web/lib/detailTabs.ts";
import { ACTIONS, resolveKeybindings } from "../src/web/lib/keybindings.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function view(session: Session, over: Partial<SessionViewProps> = {}): SessionViewProps {
  return mkSessionView(session, {
    workflowRunBySession: new Map([[session.id, { ...LADDER_SUMMARY, sessionId: session.id }]]),
    onOpenWorkflowRun: () => {},
    ...over,
  });
}

function detailHtml(session: Session): string {
  return renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: view(session) }),
  );
}

test("the conversation window does not render workflow progress", () => {
  const html = detailHtml(mkSession());
  assert.doesNotMatch(html, /wf-ladder|tile-workflow/);
  assert.match(html, /detail-conv/);
  assert.match(html, /workflow-/);
});

test("the Workflows pane starts loading the session's bound workflow", () => {
  const session = mkSession();
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      run: { ...LADDER_SUMMARY, sessionId: session.id },
      onOpenRun: () => {},
    }),
  );
  assert.match(html, /Loading workflow stages/);
  assert.doesNotMatch(html, /detail-empty/);
});

test("the Workflows pane names its empty state", () => {
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, { run: null, onOpenRun: () => {} }),
  );
  assert.match(html, /No workflow is bound to this session/);
});

test("Workflows sits between Work queue and Diff", () => {
  const tabs = detailTabs({ queueCount: 0 });
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ["conversation", "queue", "workflows", "diff", "files"],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ["Conversation", "Work queue", "Workflows", "Diff", "Files"],
  );
  assert.equal(detailTabs({ queueCount: 4 })[1]?.pip, 4);
});

test("every detail tab has a registered keybinding action", () => {
  const ids = new Set(ACTIONS.map((action) => action.id));
  for (const tab of detailTabs({ queueCount: 0 })) {
    assert.ok(ids.has(tab.action), tab.id);
  }
});

test("the selected-session Workflows tab remains bound to y", () => {
  const action = ACTIONS.find((candidate) => candidate.id === "sessionWorkflows");
  assert.equal(action?.defaultBinding, "y");
  assert.equal(action?.group, "selection");
  assert.equal(ACTIONS.find((candidate) => candidate.id === "workflows")?.group, "global");

  const resolved = resolveKeybindings({});
  assert.equal(resolved.sessionWorkflows, "y");
  assert.equal(resolved.workflows, "w");
});

test("App's chord and the detail tab remain wired together", () => {
  const app = read("../src/web/App.tsx");
  const detail = read("../src/web/components/layouts/ConsoleDetail.tsx");
  assert.match(app, /chord === bindings\.sessionWorkflows/);
  assert.match(app, /requestWorkflowsTab\(sel\.id\)/);
  assert.match(detail, /view\.workflowsTabRequest\?\.sessionId === session\.id/);
});
