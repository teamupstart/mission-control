// What is at stake: the dispatch form leads with the brief (repo, task) and folds the
// backlog bookkeeping (priority, labels, title, autopilot, dependencies) behind a summary row. The
// failure this guards against is a fold that HIDES state: a draft carrying a priority or a
// dependency whose collapsed row does not say so, or an editor that opens with the task's
// own fields out of reach behind a closed fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";

const fresh = (): string =>
  renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, { open: true, editTask: null, onClose: () => {} })),
  );

test("a fresh dispatch leads with the task and folds the backlog details", () => {
  const html = fresh();
  // The composer sits above the crew row - the brief is the dispatch, the crew is a default.
  const taskAt = html.indexOf("What should this agent do?");
  const crewAt = html.indexOf(">Crew<");
  assert.ok(taskAt >= 0 && crewAt > taskAt, "the task composer leads and the crew row follows");
  // Collapsed, with the summary naming every field it hides - set or not.
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /no priority · no labels · title summarized · autopilot on · no dependencies/);
  // Collapsed means the fields are not rendered, not merely styled away.
  assert.doesNotMatch(html, /placeholder="e\.g\. bug, infra"/);
});

test("the Kind control offers every kind, in the registry's order", () => {
  // The options moved from two hand-written `<option>`s onto `TASK_KINDS`, which is what
  // made adding `plan` reach this control for free - the two `<select>`s that had NOT
  // moved compiled cleanly and silently kept offering two. Order is the contract: the
  // tuple's order is picker order, and `ship` leads because it is the default.
  const html = fresh();
  const options = [
    ...html.matchAll(/<option value="(ship|scout|plan|chat)"[^>]*>([^<]*)<\/option>/g),
  ];
  assert.deepEqual(
    options.map((m) => [m[1], m[2]]),
    [
      ["ship", "ship"],
      ["scout", "scout"],
      ["plan", "plan"],
      ["chat", "chat"],
    ],
  );
  // Selected by the draft, not by document order, so a scout draft still opens on scout.
  assert.match(html, /<option value="ship" selected=""/);
});

test("a fresh dispatch quick-selects published after-work Workflows outside backlog details", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, {
      open: true,
      editTask: null,
      onClose: () => {},
      foremanEnabled: true,
      workflowSummaries: [{
        id: "workflow-review",
        name: "Release review",
        description: "",
        draftRevision: 1,
        currentVersionId: "version-1",
        publishedVersion: 1,
        archivedAt: null,
        updatedAt: 1,
        errorCount: 0,
        warningCount: 0,
        nodeCount: 2,
        personaCount: 1,
        builtin: false,
      }],
    })),
  );
  assert.match(html, /After work/);
  assert.match(html, /Release review · v1/);
  assert.match(html, /No handoff/);
});

test("an after-work Workflow can be saved while Foreman is off but not dispatched", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, {
      open: true,
      editTask: mkTask({
        status: "backlog",
        workflowId: "workflow-review",
      }),
      onClose: () => {},
      foremanEnabled: false,
      workflowSummaries: [{
        id: "workflow-review",
        name: "Release review",
        description: "",
        draftRevision: 1,
        currentVersionId: "version-1",
        publishedVersion: 1,
        archivedAt: null,
        updatedAt: 1,
        errorCount: 0,
        warningCount: 0,
        nodeCount: 2,
        personaCount: 1,
        builtin: false,
      }],
    })),
  );
  const save = html.match(/<button class="btn btn-ghost"[^>]*>Save<\/button>/)?.[0];
  const dispatch = html.match(/<button class="btn btn-primary"[^>]*>Dispatch now<\/button>/)?.[0];
  assert.ok(save);
  assert.doesNotMatch(save, /disabled/);
  assert.ok(dispatch);
  assert.match(dispatch, /disabled/);
  assert.match(html, /You can add this task to the backlog, but turn on Foreman before dispatching it/);
});

test("the launch-mode toggle lives in the modal header", () => {
  const html = fresh();
  const header = html.slice(html.indexOf('class="modal-head"'), html.indexOf("dispatch-body"));
  assert.match(header, /Single agent/);
  assert.match(header, /Ensemble/);
});

test("returning from Ensemble opens populated backlog details", () => {
  const source = readFileSync(
    new URL("../src/web/components/DispatchModal.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const previousEnsembleMode = useRef\(ensembleMode\)/);
  assert.match(source, /returnedToSingle && draftHasBacklogDetails/);
});

test("an editor opens with the fold open and the summary withheld", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(DispatchLayer, {
        open: true,
        editTask: mkTask({ title: "Fix the flake", priority: "high", labels: ["test"] }),
        onClose: () => {},
      }),
    ),
  );
  assert.match(html, /aria-expanded="true"/);
  // Open shows the real fields: the title input holds the task's own title.
  assert.match(html, /value="Fix the flake"/);
  assert.match(html, /<option value="high" selected=""/);
});

test("an unmet dependency speaks in the attention tone at the point of commit", () => {
  const blocked = mkTask({
    dependencies: [
      {
        type: "task",
        taskId: "pre",
        title: "Merge this first",
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: null,
      },
      {
        type: "task",
        taskId: "done",
        title: "Already merged",
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: 1,
      },
    ],
  });
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, { open: true, editTask: blocked, onClose: () => {} })),
  );
  // The chip names the dependency; the note says what waiting means; the primary says it too.
  assert.match(html, /Merge this first/);
  assert.match(html, /Waits for 1 dependency/);
  assert.doesNotMatch(html, /Waits for 2 dependencies/);
  assert.match(html, /Waiting for dependencies/);
});
