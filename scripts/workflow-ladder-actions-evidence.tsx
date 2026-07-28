import { createRoot } from "react-dom/client";
import type { WorkflowRunDetail } from "../src/shared/workflow.ts";
import { OverlayHost, useOverlayHost } from "../src/web/components/Overlay.tsx";
import { WorkflowLadderPanel } from "../src/web/workflows/WorkflowLadder.tsx";
import { workflowFeedbackText } from "../src/web/workflows/run-model.ts";
import { ladderDetail } from "../test/helpers/workflow-ladder.ts";
import "../src/web/styles.css";

type EvidenceScenario =
  | "d2"
  | "d3"
  | "d4-disabled"
  | "d4-confirm"
  | "gate-e2e"
  | "delivery-e2e"
  | "prepare-pr-e2e"
  | "mark-delivered-e2e";

interface EvidenceRequest {
  sequence: number;
  method: string;
  path: string;
  status: number;
  body: Record<string, unknown> | null;
  response: Record<string, unknown>;
}

interface EvidenceSnapshot {
  alert: string | null;
  buttons: Array<{ label: string; disabled: boolean }>;
  hasInspectorGate: boolean;
  hasRecheckInspector: boolean;
  hasRepairDelivery: boolean;
  hasPreparePr: boolean;
  confirmTitle: string | null;
  runStatus: WorkflowRunDetail["run"]["status"];
}

declare global {
  interface Window {
    __ladderEvidence: {
      scenario: EvidenceScenario;
      requests: EvidenceRequest[];
      clipboard: string[];
      expectedFeedback: string;
      snapshot: () => EvidenceSnapshot;
    };
  }
}

const scenario = new URLSearchParams(window.location.search)
  .get("scenario") as EvidenceScenario | null ?? "d2";
const requests: EvidenceRequest[] = [];
const clipboard: string[] = [];
let sequence = 0;
let gateFailuresRemaining = scenario === "gate-e2e" ? 1 : 0;

function detailFor(selected: EvidenceScenario): WorkflowRunDetail {
  if (selected === "d2") return ladderDetail("changes");
  if (
    selected === "d4-disabled"
    || selected === "d4-confirm"
    || selected === "delivery-e2e"
    || selected === "mark-delivered-e2e"
  ) {
    const detail = ladderDetail("uncertain");
    if (selected === "d4-disabled") {
      detail.binding = { ...detail.binding, sessionId: null, state: "orphaned" };
    }
    return detail;
  }
  const detail = ladderDetail("gate");
  detail.summary.status = "waiting_for_pr";
  detail.run.status = "waiting_for_pr";
  detail.inspectorGate = {
    ...detail.inspectorGate!,
    state: {
      ...detail.inspectorGate!.state,
      waitReason: "missing_pr",
    },
  };
  return detail;
}

let detail = detailFor(scenario);

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function record(
  method: string,
  path: string,
  status: number,
  body: Record<string, unknown> | null,
  response: Record<string, unknown>,
): void {
  requests.push({ sequence: ++sequence, method, path, status, body, response });
}

globalThis.fetch = async (input, init = {}): Promise<Response> => {
  const path = typeof input === "string"
    ? input
    : input instanceof URL
      ? `${input.pathname}${input.search}`
      : input.url;
  const method = init.method?.toUpperCase() ?? "GET";
  const body = typeof init.body === "string"
    ? JSON.parse(init.body) as Record<string, unknown>
    : null;

  if (method === "GET" && path === "/api/workflow-runs/run") {
    record(method, path, 200, null, {
      runId: detail.run.id,
      waitReason: detail.inspectorGate?.state.waitReason ?? null,
      deliveryStates: detail.deliveries.map((delivery) => delivery.state),
    });
    return json(structuredClone(detail) as unknown as Record<string, unknown>);
  }

  if (method === "POST" && path === "/api/workflow-runs/run/recheck-inspector") {
    if (gateFailuresRemaining > 0) {
      gateFailuresRemaining--;
      const response = { error: "Inspector ledger unavailable for evidence run" };
      record(method, path, 503, body, response);
      return json(response, 503);
    }
    detail.inspectorGate = detail.inspectorGate
      ? {
          ...detail.inspectorGate,
          state: { ...detail.inspectorGate.state, waitReason: null },
        }
      : null;
    const response = { ok: true };
    record(method, path, 200, body, response);
    return json(response);
  }

  if (method === "POST" && path === "/api/workflow-runs/run/prepare-pr") {
    detail.run = { ...detail.run, status: "waiting_for_session" };
    detail.summary = {
      ...detail.summary,
      status: "waiting_for_session",
      phase: "pr_handoff",
    };
    const response = { deliveryId: "pr-handoff", state: "delivered" };
    record(method, path, 200, body, response);
    return json(response);
  }

  if (method === "POST" && path === "/api/workflow-deliveries/delivery/resolve") {
    const delivery = detail.deliveries[0];
    if (delivery) {
      detail.deliveries = [{
        ...delivery,
        state: body?.resolution === "mark_delivered" ? "delivered" : "cancelled",
        error: body?.resolution === "mark_delivered" ? null : "discarded_by_operator",
      }];
    }
    const response = { ok: true };
    record(method, path, 200, body, response);
    return json(response);
  }

  const response = { error: `No evidence response for ${method} ${path}` };
  record(method, path, 404, body, response);
  return json(response, 404);
};

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string): Promise<void> => {
      clipboard.push(text);
    },
  },
});

function snapshot(): EvidenceSnapshot {
  const text = document.body.textContent ?? "";
  const alert = document.querySelector<HTMLElement>('[role="alert"]')?.innerText ?? null;
  return {
    alert,
    buttons: [...document.querySelectorAll<HTMLButtonElement>("button")].map((button) => ({
      label: button.innerText.trim(),
      disabled: button.disabled,
    })),
    hasInspectorGate: text.includes("Inspector gate"),
    hasRecheckInspector: text.includes("Recheck Inspector"),
    hasRepairDelivery: text.includes("Repair delivery"),
    hasPreparePr: text.includes("Prepare PR in session"),
    confirmTitle:
      document.querySelector<HTMLElement>(".workflow-confirm h2")?.innerText ?? null,
    runStatus: detail.run.status,
  };
}

window.__ladderEvidence = {
  scenario,
  requests,
  clipboard,
  expectedFeedback: workflowFeedbackText(detailFor("d2")),
  snapshot,
};

function EvidenceApp(): React.JSX.Element {
  const overlays = useOverlayHost();
  return (
    <OverlayHost value={overlays}>
      <style>{`
        html, body, #root { min-height: 100%; }
        body { margin: 0; background: var(--bg); color: var(--fg); }
        .evidence-page {
          box-sizing: border-box;
          width: 100%;
          min-height: 100vh;
          padding: 26px;
          background:
            radial-gradient(circle at 92% 8%, color-mix(in oklab, var(--working) 8%, transparent), transparent 28%),
            var(--bg);
        }
        .evidence-shell {
          width: min(720px, 100%);
          margin: 0 auto;
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 13px;
          background: var(--panel);
          box-shadow: var(--shadow);
        }
        .evidence-session-head {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-soft);
          background: var(--panel-2);
        }
        .evidence-session-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #d97757;
          box-shadow: 0 0 0 3px color-mix(in oklab, #d97757 14%, transparent);
        }
        .evidence-session-name { font-size: 12px; font-weight: 680; }
        .evidence-session-meta {
          margin-left: auto;
          color: var(--dim);
          font: 10px var(--mono);
        }
        .evidence-detail.detail-conv {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 0;
          padding: 16px;
          background: color-mix(in oklab, var(--panel) 92%, var(--bg));
        }
        .evidence-transcript {
          min-height: 74px;
          padding: 12px 14px;
          border: 1px solid var(--border-soft);
          border-radius: 9px;
          background: var(--bg-2);
        }
        .evidence-transcript-label {
          color: var(--dim);
          font: 9px var(--mono);
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .evidence-transcript p {
          margin: 7px 0 0;
          color: var(--muted);
          font-size: 11px;
          line-height: 1.45;
        }
      `}</style>
      <main className="evidence-page">
        <section className="evidence-shell" aria-label="Session detail evidence">
          <header className="evidence-session-head">
            <span className="evidence-session-dot" aria-hidden />
            <span className="evidence-session-name">harness/workflow-ladder</span>
            <span className="evidence-session-meta">SESSION DETAIL · CLAUDE</span>
          </header>
          <div className="evidence-detail detail-conv">
            <WorkflowLadderPanel
              run={detail.summary}
              onOpenRun={() => {}}
            />
            <div className="evidence-transcript" aria-hidden>
              <span className="evidence-transcript-label">Session transcript</span>
              <p>The workflow ladder stays above the conversation so recovery actions remain
                attached to the stage that needs the operator.</p>
            </div>
          </div>
        </section>
      </main>
    </OverlayHost>
  );
}

createRoot(document.getElementById("root")!).render(<EvidenceApp />);
