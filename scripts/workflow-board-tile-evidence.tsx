import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost, useOverlayHost } from "../src/web/components/Overlay.tsx";
import { WorkflowLadderPanel } from "../src/web/workflows/WorkflowLadder.tsx";
import { ladderDetail } from "../test/helpers/workflow-ladder.ts";
import "../src/web/styles.css";

const detail = ladderDetail("changes");

globalThis.fetch = async (input): Promise<Response> => {
  const path = typeof input === "string"
    ? input
    : input instanceof URL
      ? `${input.pathname}${input.search}`
      : input.url;
  if (path !== "/api/workflow-runs/run") {
    return new Response(JSON.stringify({ error: `No evidence response for ${path}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(structuredClone(detail)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function EvidenceApp(): React.JSX.Element {
  const overlays = useOverlayHost();
  const [expanded, setExpanded] = useState(false);
  return (
    <OverlayHost value={overlays}>
      <style>{`
        html, body, #root { min-height: 100%; }
        body {
          margin: 0;
          background:
            radial-gradient(circle at 18% 4%, color-mix(in oklab, var(--working) 7%, transparent), transparent 32%),
            var(--bg);
          color: var(--fg);
        }
        .evidence-page {
          box-sizing: border-box;
          min-height: 100vh;
          padding: 32px;
        }
        .evidence-label {
          width: 360px;
          margin: 0 auto 9px;
          color: var(--dim);
          font: 9px var(--mono);
          letter-spacing: .1em;
          text-transform: uppercase;
        }
        .evidence-shell {
          width: 360px;
          margin: 0 auto;
        }
        .evidence-shell .tile {
          box-sizing: border-box;
        }
      `}</style>
      <main className="evidence-page">
        <p className="evidence-label">Board · needs you</p>
        <section className="evidence-shell" aria-label="D prime Board tile evidence">
          <article className={`tile attention${expanded ? " workflow-expanded" : ""}`}>
            <header className="tile-head">
              <span
                className="agent-dot"
                style={{ "--agent-accent": "#d97757" } as React.CSSProperties}
                aria-hidden
              />
              <span className="tile-name">harness/workflow-ladder</span>
              <span className="badge attention">needs you</span>
            </header>
            <span className="tile-goal">
              Move the workflow ladder into the Board tile without losing the exact objection.
            </span>
            <span className="tile-activity">
              <span className="ta-glyph" aria-hidden>◌</span>
              <span className="ta-txt">waiting for workflow repair</span>
            </span>
            <WorkflowLadderPanel
              run={detail.summary}
              onOpenRun={() => {}}
              tileDisclosure={{ expanded, onExpandedChange: setExpanded }}
            />
            <footer className="tile-foot">
              <span className="tile-branch">feature/stage-ladder</span>
              <span className="tile-seen">now</span>
            </footer>
          </article>
        </section>
      </main>
    </OverlayHost>
  );
}

createRoot(document.getElementById("root")!).render(<EvidenceApp />);
