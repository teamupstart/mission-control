// Browser fixture for the skipped-stage visual evidence capture.
//
// It mounts the production WorkflowLadder twice: once as an Inspector-only repair and once
// with both checks intentionally unconfigured. The Electron driver hovers the stage chip in
// each scenario so the committed images demonstrate the color and the explanation together.

import { createRoot } from "react-dom/client";
import type { WorkflowCheckSlot, WorkflowRunDetail } from "../src/shared/workflow.ts";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import {
  LADDER_NODE,
  ladderDetail,
} from "../test/helpers/workflow-ladder.ts";
import "../src/web/styles.css";

type Scenario = "inspector" | "unconfigured";

const scenario = (new URLSearchParams(window.location.search).get("scenario")
  ?? "inspector") as Scenario;

function inspectorDetail(): WorkflowRunDetail {
  const detail = ladderDetail("gate");
  const prior = detail.submissions[0]!;
  detail.submissions = [prior, {
    ...prior,
    id: "inspector-only-evidence",
    round: prior.round + 1,
    mode: "inspector_only",
  }];
  detail.summary.bypassedPersonaReview = true;
  return detail;
}

function unconfiguredDetail(): WorkflowRunDetail {
  const detail = ladderDetail("reviewing");
  const checks = new Map<string, WorkflowCheckSlot>([
    [LADDER_NODE.typecheck, "typecheck"],
    [LADDER_NODE.test, "test"],
  ]);
  detail.attempts = detail.attempts.map((item) => {
    const slot = checks.get(item.nodeId);
    if (!slot) return item;
    return {
      ...item,
      output: {
        status: "skipped" as const,
        slot,
        command: null,
        exitCode: null,
        output: "",
        truncatedBytes: 0,
        note: "No command is configured.",
      },
    };
  });
  return detail;
}

const detail = scenario === "inspector" ? inspectorDetail() : unconfiguredDetail();
const title = scenario === "inspector"
  ? "Inspector repair rerun"
  : "Checks not configured";
const caption = scenario === "inspector"
  ? "Previously passed stages are intentionally bypassed."
  : "The workflow advances, but these checks did not run.";

createRoot(document.getElementById("root")!).render(
  <main className="evidence-page">
    <header className="evidence-head">
      <span className="evidence-kicker">Workflow run · status evidence</span>
      <h1>{title}</h1>
      <p>{caption}</p>
    </header>
    <div className="evidence-shell">
      <WorkflowLadder
        summary={detail.summary}
        detail={detail}
        onOpenRun={() => {}}
        sessionBound
      />
    </div>
  </main>,
);
