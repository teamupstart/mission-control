import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HibernatedSection } from "../src/web/components/HibernatedTasks.tsx";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { mkTask } from "./helpers/session-fixture.ts";

const record = {
  sessionId: "sdk:h",
  runtime: "sdk" as const,
  agentSessionId: "conv",
  permissionMode: null,
  checkout: null,
  noteKey: "conv",
  hibernatedAt: Date.now() - 3 * 86_400_000,
  blocker: { kind: "dependency" as const, reason: "Needs the staging Stripe key", waitingOn: "Priya", startedAt: 1 },
  failure: null,
};

test("a hibernated task is drawn with its blocker, its age and Resume", () => {
  const html = renderToStaticMarkup(createElement(HibernatedSection, {
    tasks: [mkTask({ id: "h", title: "Migrate billing webhooks", status: "hibernated", branch: "billing-v2", hibernation: record })],
  }));
  assert.match(html, /aria-label="Hibernated tasks"/);
  assert.match(html, /Hibernated<\/span><span class="bl-hib-n">1</);
  assert.match(html, /aria-label="Hibernated task: Migrate billing webhooks"/);
  assert.match(html, /Dependency<\/span><span class="bl-hib-blocker-reason">Needs the staging Stripe key/);
  assert.match(html, /Hibernated 3d ago/);
  assert.match(html, />Resume<\/button>/);
  assert.match(html, /bl-hib-title">Migrate billing webhooks</);
  assert.doesNotMatch(html, /Could not resume/);
});

test("a failed resume shows its reason and offers Retry", () => {
  const html = renderToStaticMarkup(createElement(HibernatedSection, {
    tasks: [mkTask({
      id: "f",
      title: "Upgrade Hono",
      status: "hibernated",
      hibernation: { ...record, failure: { reason: "its checkout /wt/x no longer exists", at: 2, launch: null } },
    })],
  }));
  assert.match(html, /class="bl-hib-card is-failed"/);
  assert.match(html, /role="alert">Could not resume: its checkout \/wt\/x no longer exists\. Its worktree and conversation are kept\./);
  assert.match(html, />Retry<\/button>/);
});

test("no hibernated task draws nothing, and the Backlog draws the section above its queue", () => {
  assert.equal(renderToStaticMarkup(createElement(HibernatedSection, { tasks: [] })), "");
  const queued = mkTask({ id: "q", title: "Queued work", status: "backlog" });
  const sleeping = mkTask({ id: "s", title: "Sleeping work", status: "hibernated", hibernation: record });
  const html = renderToStaticMarkup(createElement(BacklogColumn, {
    tasks: [queued],
    hibernated: [sleeping],
    allTasks: [queued, sleeping],
    plan: null,
    onAssignError: () => {},
    onDragging: () => {},
    onEdit: () => {},
  }));
  const hib = html.indexOf("Hibernated task: Sleeping work");
  const queue = html.indexOf(">Queued</h3>");
  const card = html.indexOf("Queued work");
  assert.ok(hib >= 0 && queue > hib && card > queue, "Hibernated, then the Queued heading, then the queued cards");
});
