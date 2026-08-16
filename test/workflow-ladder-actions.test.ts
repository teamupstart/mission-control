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
  assert.match(render(), /Recheck GitHub Inspector/);

  const detail = ladderDetail("gate");
  detail.inspectorGate = {
    ...detail.inspectorGate!,
    state: { ...detail.inspectorGate!.state, waitReason: null },
  };
  assert.doesNotMatch(render(detail), /Recheck GitHub Inspector/);
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
  assert.match(buttonFor(pending, "Recheck GitHub Inspector"), /disabled/);
  assert.doesNotMatch(buttonFor(pending, "Open PR"), /disabled/);

  const idle = render();
  assert.doesNotMatch(buttonFor(idle, "Recheck GitHub Inspector"), /disabled/);
});

/**
 * The URL gate is in the SHARED factory, so it has to hold from this side too.
 *
 * This rung is where the disabled `Open PR` was most visible: the ladder's own comment records
 * it printing "three unknowns and a dead control" from the first submission of every Inspector
 * workflow. The ladder never read `href` - it renders every descriptor as a button plus a
 * callback - so absence is the only thing that could ever have fixed it here.
 */
test("Open PR leaves the Inspector rung when the gate has no pull request to open", () => {
  assert.match(render(), /Open PR/);

  const unadopted = ladderDetail("gate");
  unadopted.inspectorGate = {
    ...unadopted.inspectorGate!,
    state: { ...unadopted.inspectorGate!.state, prUrl: null, prKey: null },
  };
  const html = render(unadopted);
  assert.doesNotMatch(html, /Open PR/);
  assert.doesNotMatch(html, /This run has no adopted pull request/);
  // The rung itself and its other action survive: this removed a control, not the gate.
  assert.match(html, /Recheck GitHub Inspector/);
});

/** The policy still decides whether the rung exists at all, which is the ladder's own gate. */
test("the Inspector rung renders under an inspector policy and not under none", () => {
  assert.match(render(), /Inspector/);
  assert.match(render(), /Recheck GitHub Inspector/);

  const unpolicied = ladderDetail("gate");
  unpolicied.version = {
    ...unpolicied.version!,
    completionPolicy: { kind: "none" },
  };
  const html = render(unpolicied);
  assert.doesNotMatch(html, /Recheck GitHub Inspector/);
  assert.doesNotMatch(html, /Open PR/);
});
