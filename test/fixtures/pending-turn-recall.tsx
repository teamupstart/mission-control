import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PendingTurn, Session } from "../../src/shared/types.ts";
import { ActionBar } from "../../src/web/components/ActionBar.tsx";
import { PendingTurnView } from "../../src/web/components/TranscriptPanel.tsx";
import "../../src/web/styles.css";
import { mkSession } from "../helpers/session-fixture.ts";

declare global {
  interface Window {
    __pendingTurnRecallStage?: "queued" | "recalled";
    __triggerPendingTurnRecall?: () => Promise<void>;
    __pendingTurnRecallResult?: {
      error: string | null;
      tagName: string | null;
      value: string | null;
    };
  }
}

const recalled = "race.\nDo not steer";
const pending: PendingTurn = {
  id: "pending-multiline",
  noteKey: "agent-1",
  seq: 0,
  text: recalled,
  state: "queued",
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
  claimedAt: null,
  lastError: null,
};
const initialSession: Session = mkSession({ pendingTurns: [pending] });

window.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/api/sessions/s1/pending-turns/pending-multiline/recall")) {
    window.dispatchEvent(new CustomEvent("pending-turn-recalled"));
    return new Response(JSON.stringify({ text: recalled }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function Fixture(): React.JSX.Element {
  const [queued, setQueued] = useState(true);
  const session = queued ? initialSession : { ...initialSession, pendingTurns: [] };

  useEffect(() => {
    const recalledTurn = () => setQueued(false);
    window.addEventListener("pending-turn-recalled", recalledTurn);
    return () => window.removeEventListener("pending-turn-recalled", recalledTurn);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const open = document.querySelector<HTMLButtonElement>(".actions > .btn");
        if (!open) throw new Error("Missing Send button");
        open.click();

        let composer: HTMLTextAreaElement | null = null;
        for (let i = 0; i < 50 && !composer; i += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 20));
          composer = document.querySelector<HTMLTextAreaElement>(".compose-input");
        }
        if (!composer) throw new Error("Missing card composer");

        window.__triggerPendingTurnRecall = async () => {
          composer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
          for (let i = 0; i < 50; i += 1) {
            const fullTurnGone = document.querySelector(".pending-turn") === null;
            if (composer.value === recalled && fullTurnGone) break;
            await new Promise((resolve) => window.setTimeout(resolve, 20));
          }
          if (composer.value !== recalled) throw new Error("Recalled text did not reach composer");
          if (document.querySelector(".pending-turn")) {
            throw new Error("Recalled turn remained in the pending queue");
          }
          window.scrollTo(0, 0);
          window.__pendingTurnRecallResult = {
            error: null,
            tagName: composer.tagName,
            value: composer.value,
          };
          window.__pendingTurnRecallStage = "recalled";
        };
        window.__pendingTurnRecallStage = "queued";
      } catch (error) {
        window.__pendingTurnRecallResult = {
          error: error instanceof Error ? error.message : String(error),
          tagName: null,
          value: null,
        };
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="pending-turn-evidence">
      <header className="pending-turn-evidence-head">
        <span className="pending-turn-evidence-kicker">Mission Control conversation</span>
        <h1>Queued message recall</h1>
        <p>
          {queued
            ? "Before Up Arrow: Mission Control owns the queued turn."
            : "After Up Arrow: the queued turn is back in the composer."}
        </p>
      </header>
      <section className="card expanded tone-idle pending-turn-evidence-card">
        <div className="pending-turn-evidence-session">
          <span>Claude Code</span>
          <strong>review-reset-race</strong>
          <span className="pending-turn-evidence-state">idle</span>
        </div>
        <div className="transcript">
          <div className="transcript-log">
            {queued ? (
              <PendingTurnView turn={pending} editable />
            ) : (
              <div className="transcript-empty">No message remains in the pending queue.</div>
            )}
          </div>
        </div>
        <ActionBar session={session} />
      </section>
    </main>
  );
}

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Missing pending-turn recall root");
createRoot(root).render(<Fixture />);
