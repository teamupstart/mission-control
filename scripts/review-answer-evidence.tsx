import { createRoot } from "react-dom/client";
import type { ReviewItem, TranscriptMessage } from "../src/shared/types.ts";
import { OverlayHost, useOverlayHost } from "../src/web/components/Overlay.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession } from "../test/helpers/session-fixture.ts";
import "../src/web/styles.css";

const SESSION_ID = "review-answer-evidence";

// Local constructors keep the reviewer-facing clock stable in whichever timezone runs the
// capture. The product formatter still owns the visible locale-specific text.
const at = (hour: number, minute: number, second = 0): number =>
  new Date(2026, 6, 31, hour, minute, second).getTime();

/**
 * All four voices, in one conversation, in the order they spoke.
 *
 * The point of the capture is the CONTRAST: gold review answers have to be tellable at a
 * glance from a blue turn the human typed and a purple one Foreman delivered. Showing any of
 * them alone would prove the colour exists without proving it distinguishes anything.
 *
 * The tool run at 9:44 is deliberately included: `mission-control:request_input` as a grey
 * chip is exactly what the whole conversation used to show of a decision, and it sits
 * directly above the gold entry that now says what was decided.
 */
const messages: TranscriptMessage[] = [
  {
    id: "ev-user-1",
    role: "user",
    text: "Cache the transcript window, but ask me before you commit to a strategy.",
    tools: [],
    ts: at(9, 42, 7),
  },
  {
    id: "ev-assistant-1",
    role: "assistant",
    text: "Three approaches are workable and they trade off differently. Putting the choice to you.",
    tools: [],
    ts: at(9, 43, 15),
  },
  {
    id: "ev-tools-1",
    role: "assistant",
    text: "",
    tools: [
      { name: "mcp__mission-control__request_input", input: "Which caching strategy should the transcript reader use?" },
    ],
    ts: at(9, 44, 30),
  },
  // The three-option answer lands here (9:45:10), between this run and the turn below.
  {
    id: "ev-assistant-2",
    role: "assistant",
    text: "Ring buffer it is, capped at 200 turns per session as you asked.",
    tools: [],
    ts: at(9, 46, 2),
  },
  {
    id: "ev-foreman-1",
    role: "user",
    origin: "foreman",
    text: "Permission prompt answered on your behalf: allowed `npm test` in this checkout.",
    tools: [],
    ts: at(9, 47, 20),
  },
  // The direct-text answer lands here (9:48:40), between Foreman's turn and the last one.
  {
    id: "ev-assistant-3",
    role: "assistant",
    text: "Retry budget wired to two attempts. The suite is green.",
    tools: [],
    ts: at(9, 49, 30),
  },
];

/**
 * The two shapes a submitted review takes in the log.
 *
 * `selections` present means the question had options, so the entry replays the form - every
 * option, with the taken one marked. `selections` absent means it was a direct-text ask, so
 * the entry shows the text as submitted. Both are `resolvedBy: "human"`, which is what admits
 * them to the conversation at all.
 */
const reviews: ReviewItem[] = [
  {
    id: "ev-review-options",
    sessionId: SESSION_ID,
    kind: "input",
    title: "Which caching strategy should the transcript reader use?",
    body: "Which caching strategy should the transcript reader use?",
    status: "answered",
    response:
      "Answered:\n\n• Which caching strategy should the transcript reader use?\n  → Single shared ring buffer\n  Other: cap it at 200 turns per session",
    decisions: [
      {
        id: "q",
        question: "Which caching strategy should the transcript reader use?",
        options: [
          {
            id: "o0",
            label: "Bounded LRU per session",
            detail: "Simple, predictable memory ceiling",
            recommended: true,
          },
          {
            id: "o1",
            label: "Single shared ring buffer",
            detail: "One allocation, but sessions evict each other",
          },
          { id: "o2", label: "No cache at all", detail: "Re-read the JSONL window on every scroll" },
        ],
        allowOther: true,
      },
    ],
    selections: [{ decisionId: "q", selected: ["o1"], other: "cap it at 200 turns per session" }],
    resolvedBy: "human",
    createdAt: at(9, 44, 30),
    resolvedAt: at(9, 45, 10),
  },
  {
    id: "ev-review-text",
    sessionId: SESSION_ID,
    kind: "input",
    title: "What should the retry budget be?",
    body: "What should the retry budget be?",
    status: "answered",
    response: "two attempts, then fail loudly",
    decisions: null,
    selections: null,
    resolvedBy: "human",
    createdAt: at(9, 48, 10),
    resolvedAt: at(9, 48, 40),
  },
];

resetHistories();
seedTail(SESSION_ID, { messages, start: 0, atStart: true, pos: 900 });

/** The panel reconnects after mounting; evidence stays on its seeded, deterministic tail. */
class EvidenceEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = EvidenceEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    queueMicrotask(() => {
      this.readyState = EvidenceEventSource.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  close(): void {
    this.readyState = EvidenceEventSource.CLOSED;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

globalThis.EventSource = EvidenceEventSource as unknown as typeof EventSource;

const session = mkSession({
  id: SESSION_ID,
  name: "Review answers in the conversation",
  cwd: "/worktrees/mission-control",
  gitBranch: "feature/review-answers-in-conversation",
});

function EvidenceApp(): React.JSX.Element {
  const overlays = useOverlayHost();
  return (
    <OverlayHost value={overlays}>
      <style>{`
        html, body, #root { min-height: 100%; }
        body {
          margin: 0;
          background:
            radial-gradient(circle at 18% 0%, color-mix(in oklab, var(--attention) 8%, transparent), transparent 34%),
            var(--bg);
          color: var(--fg);
        }
        .evidence-page {
          box-sizing: border-box;
          min-height: 100vh;
          padding: 42px;
        }
        .evidence-label,
        .evidence-note {
          width: 860px;
          margin-right: auto;
          margin-left: auto;
        }
        .evidence-label {
          margin-top: 0;
          margin-bottom: 9px;
          color: var(--fg);
          font: 600 12px/1 var(--sans);
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .evidence-note {
          margin-top: 10px;
          margin-bottom: 0;
          color: var(--dim);
          font: 10px/1.4 var(--mono);
        }
        /* Height hugs the seeded conversation: tall enough that the log never scrolls (the
           capture script refuses to shoot a scrolled log), and no taller, so the evidence is
           the conversation rather than a field of empty panel above the reply box. */
        .evidence-shell {
          box-sizing: border-box;
          width: 860px;
          height: 868px;
          margin: 0 auto;
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--bg-1);
          box-shadow: 0 18px 55px rgb(0 0 0 / 24%);
        }
        .evidence-shell .detail-body {
          height: 100%;
        }
        .evidence-shell .detail-conv {
          box-sizing: border-box;
        }
      `}</style>
      <main className="evidence-page">
        <p className="evidence-label">Conversation · review answer evidence</p>
        <section className="evidence-shell" aria-label="Review answers in a conversation">
          <div className="detail-body">
            <div className="detail-conv">
              <TranscriptPanel session={session} canSend reviews={reviews} />
            </div>
          </div>
        </section>
        <p className="evidence-note">
          gold = your review answers · blue = your typed turn · purple = Foreman · agent accent = the agent
        </p>
      </main>
    </OverlayHost>
  );
}

createRoot(document.getElementById("root")!).render(<EvidenceApp />);
