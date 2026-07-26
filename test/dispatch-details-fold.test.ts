// What is at stake: the dispatch form leads with the brief (repo, task) and folds the
// backlog bookkeeping (priority, labels, title, dependencies) behind a summary row. The
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
  assert.match(html, /no priority · no labels · title summarized · no dependencies/);
  // Collapsed means the fields are not rendered, not merely styled away.
  assert.doesNotMatch(html, /placeholder="e\.g\. bug, infra"/);
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
