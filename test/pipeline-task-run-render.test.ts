import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaskPipelineRunChip,
  TaskPipelineRunRailMark,
  TaskPipelineRunTileFlag,
} from "../src/web/components/session-bits.tsx";

const link = {
  provider: "ai-conductor" as const,
  repoRoot: "/repo/demo",
  slug: "existing-run",
};

test("task-owned Pipeline leaves distinguish planned and observed runs from worker ownership", () => {
  const planned = renderToStaticMarkup(
    React.createElement(TaskPipelineRunChip, { link, observed: false }),
  );
  const observed = renderToStaticMarkup(
    React.createElement(TaskPipelineRunChip, { link, observed: true }),
  );

  assert.match(planned, /This task plans existing-run\. Open its run in Runs\./);
  assert.match(observed, /This task continues in existing-run\. Open its run in Runs\./);
  assert.doesNotMatch(planned + observed, /reads no input|is driving/);
});

test("Board and rail task-run leaves use the shared accessible sentence", () => {
  const tile = renderToStaticMarkup(
    React.createElement(TaskPipelineRunTileFlag, { link, observed: true }),
  );
  const rail = renderToStaticMarkup(
    React.createElement(TaskPipelineRunRailMark, { link, observed: true }),
  );
  const sentence = "This task continues in existing-run. Open its run in Runs.";

  assert.ok(tile.includes(sentence));
  assert.ok(rail.includes(sentence));
  assert.match(tile, /existing-run/);
});

test("task-run leaves render nothing without a task-owned link", () => {
  assert.equal(
    renderToStaticMarkup(React.createElement(TaskPipelineRunChip, { link: null, observed: false })),
    "",
  );
  assert.equal(
    renderToStaticMarkup(
      React.createElement(TaskPipelineRunTileFlag, { link: null, observed: false }),
    ),
    "",
  );
  assert.equal(
    renderToStaticMarkup(
      React.createElement(TaskPipelineRunRailMark, { link: null, observed: false }),
    ),
    "",
  );
});
