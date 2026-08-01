import { createRoot } from "react-dom/client";
import type { PendingTurn, Session } from "../../src/shared/types.ts";
import { ActionBar } from "../../src/web/components/ActionBar.tsx";
import { mkSession } from "../helpers/session-fixture.ts";

declare global {
  interface Window {
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
const session: Session = mkSession({ pendingTurns: [pending] });

window.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/api/sessions/s1/pending-turns/pending-multiline/recall")) {
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

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Missing pending-turn recall root");

createRoot(root).render(<ActionBar session={session} />);

window.setTimeout(async () => {
  try {
    const open = document.querySelector<HTMLButtonElement>(".actions > .btn");
    if (!open) throw new Error("Missing Send button");
    open.click();

    let composer: HTMLTextAreaElement | null = null;
    for (let i = 0; i < 50 && !composer; i++) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      composer = document.querySelector<HTMLTextAreaElement>(".compose-input");
    }
    if (!composer) throw new Error("Missing card composer");

    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    for (let i = 0; i < 50 && composer.value === ""; i++) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
    window.__pendingTurnRecallResult = {
      error: null,
      tagName: composer.tagName,
      value: composer.value,
    };
  } catch (error) {
    window.__pendingTurnRecallResult = {
      error: error instanceof Error ? error.message : String(error),
      tagName: null,
      value: null,
    };
  }
}, 50);
