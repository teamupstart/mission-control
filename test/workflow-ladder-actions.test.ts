import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import { ladderDetail } from "./helpers/workflow-ladder.ts";

function render(
  detail = ladderDetail("gate"),
  props: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
    onRecheckInspector: () => {},
    onPreparePr: () => {},
    onOpenPr: () => {},
    onCopyFeedback: () => {},
    sessionBound: detail.binding.sessionId !== null,
    ...props,
  }));
}

function buttonFor(html: string, label: string): string {
  const end = html.indexOf(`>${label}</button>`);
  assert.notEqual(end, -1, `${label} button is present`);
  const start = html.lastIndexOf("<button", end);
  return html.slice(start, end + label.length + 10);
}

test("the Inspector rung offers recheck only while the gate has a wait reason", () => {
  assert.match(render(), /Recheck Inspector/);

  const detail = ladderDetail("gate");
  detail.inspectorGate = {
    ...detail.inspectorGate!,
    state: { ...detail.inspectorGate!.state, waitReason: null },
  };
  assert.doesNotMatch(render(detail), /Recheck Inspector/);
});

test("Prepare PR follows the run version's missing-PR policy", () => {
  const offered = ladderDetail("gate");
  offered.run.status = "waiting_for_pr";
  offered.summary.status = "waiting_for_pr";
  offered.inspectorGate = {
    ...offered.inspectorGate!,
    state: { ...offered.inspectorGate!.state, waitReason: "missing_pr" },
  };
  assert.match(render(offered), /Prepare PR in session/);

  offered.inspectorGate = {
    ...offered.inspectorGate,
    state: { ...offered.inspectorGate.state, waitReason: "unadopted_pr" },
  };
  assert.match(render(offered), /Prepare PR in session/);

  offered.inspectorGate = {
    ...offered.inspectorGate,
    state: { ...offered.inspectorGate.state, waitReason: "review_pending" },
  };
  assert.doesNotMatch(render(offered), /Prepare PR in session/);

  offered.inspectorGate = {
    ...offered.inspectorGate,
    state: { ...offered.inspectorGate.state, waitReason: "missing_pr" },
  };
  offered.version = {
    ...offered.version!,
    completionPolicy: {
      kind: "inspector",
      onFindings: "inspector_only",
      missingPrAction: "wait",
    },
  };
  assert.doesNotMatch(render(offered), /Prepare PR in session/);
});

test("changes requested offers the shared feedback action and copied state", () => {
  const detail = ladderDetail("changes");
  assert.match(render(detail), /Copy feedback/);
  assert.match(render(detail, { feedbackCopied: true }), />Copied<\/button>/);
});

test("the renderer disables only the action reported pending", () => {
  const pending = render(ladderDetail("gate"), {
    isPending: (id: string) => id === "recheck-inspector",
  });
  assert.match(buttonFor(pending, "Recheck Inspector"), /disabled/);
  assert.doesNotMatch(buttonFor(pending, "Open PR"), /disabled/);

  const idle = render();
  assert.doesNotMatch(buttonFor(idle, "Recheck Inspector"), /disabled/);
});
