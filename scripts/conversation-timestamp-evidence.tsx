import { createRoot } from "react-dom/client";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { OverlayHost, useOverlayHost } from "../src/web/components/Overlay.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession } from "../test/helpers/session-fixture.ts";
import "../src/web/styles.css";

const SESSION_ID = "conversation-timestamp-evidence";

// Local constructors keep the reviewer-facing clock stable in whichever timezone runs
// the capture. The product formatter still owns the visible locale-specific text.
const at = (hour: number, minute: number, second = 0): number =>
  new Date(2026, 6, 31, hour, minute, second).getTime();

const messages: TranscriptMessage[] = [
  {
    id: "timestamp-user-1",
    role: "user",
    text: "Add a local timestamp beside each speaker in the conversation.",
    tools: [],
    ts: at(9, 42, 7),
  },
  {
    id: "timestamp-assistant-1",
    role: "assistant",
    text: "Implemented Option 1. Every dated row shows its month, day, and time without adding a second line.",
    tools: [],
    ts: at(9, 43, 15),
  },
  {
    id: "timestamp-user-2",
    role: "user",
    text: "Keep the timestamp subtle, but visible.",
    tools: [],
    ts: at(9, 44, 3),
  },
  {
    id: "timestamp-tools-1",
    role: "assistant",
    text: "",
    tools: [{ name: "Read", input: "src/web/components/TranscriptPanel.tsx" }],
    ts: at(9, 45, 22),
  },
  {
    id: "timestamp-assistant-2",
    role: "assistant",
    text: "Done. Hovering a timestamp reveals the complete local instant.",
    tools: [],
    ts: at(9, 46, 1),
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
  name: "Conversation timestamps",
  cwd: "/worktrees/mission-control",
  gitBranch: "feature/conversation-timestamps",
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
            radial-gradient(circle at 18% 0%, color-mix(in oklab, var(--working) 8%, transparent), transparent 34%),
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
          width: 780px;
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
        .evidence-shell {
          box-sizing: border-box;
          width: 780px;
          height: 550px;
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
        <p className="evidence-label">Conversation · timestamp evidence</p>
        <section className="evidence-shell" aria-label="Timestamped conversation evidence">
          <div className="detail-body">
            <div className="detail-conv">
              <TranscriptPanel session={session} canSend />
            </div>
          </div>
        </section>
        <p className="evidence-note">
          Option 1 · full local month, day, and time beside every dated speaker label
        </p>
      </main>
    </OverlayHost>
  );
}

createRoot(document.getElementById("root")!).render(<EvidenceApp />);
