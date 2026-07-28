import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import {
  LADDER_VERSION,
  ladderDetail,
} from "./helpers/workflow-ladder.ts";

test("a freehand graph renders the workflow chip and link, not an empty ladder", () => {
  const detail = ladderDetail("reviewing");
  detail.version = {
    ...LADDER_VERSION,
    graph: {
      ...LADDER_VERSION.graph,
      // A disconnected node makes this a valid historical graph but not a stage projection.
      nodes: [
        ...LADDER_VERSION.graph.nodes,
        {
          id: "30000000-0000-4000-8000-000000000001",
          kind: "persona",
          persona: {
            sourcePersonaId: "stray",
            sourceRevision: 1,
            name: "Freehand reviewer",
            description: "",
            guidanceMarkdown: "",
            runner: null,
            model: null,
          },
          position: { x: 50, y: 500 },
        },
      ],
    },
  };
  const html = renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
  }));
  assert.match(html, /workflow-chip/);
  assert.match(html, /Open run/);
  assert.doesNotMatch(html, /wf-ladder-rung/);
});
