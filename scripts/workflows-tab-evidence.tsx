// Browser harness for the Workflows-tab relocation evidence.
//
// Mounts the REAL `ConsoleDetail` - the same component Console and the Board drill-in
// render - against a fixture session, and photographs two of its tabs. Only `fetch` and the
// session-files controller are replaced; the tab strip, the tab bodies, `detailTabs`, the
// `Keycap`, `SessionWorkflowsPane`, `NomistakesStrip`, `NomistakesFixLog` and
// `WorkflowLadderPanel` are all production code reading production `styles.css`.
//
// A fixture rather than the live fleet for two reasons. A screenshot of the real dashboard
// is operator data - other people's session names, branches, PR numbers and spend - which
// this repository does not commit. And the state worth photographing (a session that has a
// bound workflow run AND a parked no-mistakes gate AND fix commits, all at once) is exactly
// the state a live fleet does not happen to be holding when you need the picture.
//
// The `workflows` scenario opens the tab by setting `workflowsTabRequest`, which is the
// literal value App's `y` handler produces - so the capture exercises the chord's effect,
// not a click that happens to reach the same place.

import { createRoot } from "react-dom/client";
import type { NmFixSummary, Session } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { OverlayHost, useOverlayHost } from "../src/web/components/Overlay.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import { seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession, nm } from "../test/helpers/session-fixture.ts";
import { ladderDetail } from "../test/helpers/workflow-ladder.ts";
import "../src/web/styles.css";

type Scenario = "conversation" | "workflows";

const scenario = (new URLSearchParams(window.location.search).get("scenario")
  ?? "conversation") as Scenario;

const detail = ladderDetail("gate");

// Enough fix commits that the log's per-step rollup has something to say.
const FIXES: NmFixSummary[] = [
  {
    sha: "abc1234",
    step: "lint",
    summary: "drop the unused import",
    committedAt: 1_753_600_000_000,
    filesChanged: 1,
    added: 0,
    removed: 1,
    decision: "auto",
    repliedBy: null,
    findingCount: 1,
  },
  {
    sha: "def5678",
    step: "review",
    summary: "guard the empty pane",
    committedAt: 1_753_601_000_000,
    filesChanged: 2,
    added: 14,
    removed: 3,
    decision: "replied",
    repliedBy: "you",
    findingCount: 2,
  },
];

// Everything at once: a bound workflow run, a PARKED gate (so Approve / Fix / Skip render),
// and fix commits. One session carrying all three is what makes the two captures decisive.
const session: Session = mkSession({
  id: "session",
  name: "Move Workflows to Tab, Remove Progress Bars",
  activity: "running Bash",
  nomistakesGated: true,
  // Elapsed is rendered against the wall clock, so a fixed epoch would photograph as
  // "running for 369d" the year after it was written. Anchored to now instead.
  nomistakes: nm({
    status: "running",
    gateStep: "review",
    awaitingAgent: "waiting on you",
    startedAt: Date.now() - 41 * 60_000,
  }),
  nomistakesFixes: FIXES,
  goal: {
    text: "Move the existing no-mistakes strip and Gate tab content to the new Workflows tab",
    source: "model",
    updatedAt: 0,
  },
});

// Taken from the detail the stubbed fetch serves, not from LADDER_SUMMARY, so the header
// chip and the ladder below it describe the same run. Mixing the two photographs an
// Inspector gate whose PR is "not resolved" and whose head is "not pinned" - a state the
// ladder renders faithfully and which would read, in evidence, as missing data.
const run: WorkflowRunSummary = { ...detail.summary, sessionId: session.id };

// A populated transcript, seeded into the history store TranscriptPanel hydrates from.
// Without this the conversation capture is a "Loading…" placeholder over dead space, and
// "no no-mistakes UI here" would read as "nothing loaded" rather than as the point.
seedTail(session.id, {
  start: 0,
  atStart: true,
  pos: 4,
  messages: [
    {
      id: "m1",
      role: "user",
      text: "Move the no-mistakes strip and the Gate tab into the new Workflows tab.",
      tools: [],
      ts: 1_753_594_100_000,
    },
    {
      id: "m2",
      role: "assistant",
      text: "The Conversation tab is the transcript alone now. Both readouts moved to Workflows.",
      tools: [{ name: "Edit", input: JSON.stringify({ file_path: "src/web/components/layouts/ConsoleDetail.tsx" }) }],
      ts: 1_753_594_200_000,
    },
    {
      id: "m3",
      role: "assistant",
      text: "Tab strip: Conversation, Work queue, Workflows, Diff, Files. Gate folded in.",
      tools: [{ name: "Write", input: JSON.stringify({ file_path: "src/web/components/SessionWorkflowsPane.tsx" }) }],
      ts: 1_753_594_300_000,
    },
  ],
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The daemon this harness does not have. Only the reads ConsoleDetail makes on mount.
globalThis.fetch = async (input): Promise<Response> => {
  const path = typeof input === "string"
    ? input
    : input instanceof URL
      ? `${input.pathname}${input.search}`
      : input.url;
  if (path.includes(`/api/workflow-runs/${run.id}`)) return json(detail);
  if (path.includes("/episodes")) return json([]);
  return json([]);
};

const files = {
  sessions: {},
  pathIndex: {},
  ensure: () => {},
  refresh: () => {},
  warmPaths: () => {},
  probe: async () => false,
  select: () => {},
  setMode: () => {},
  edit: () => {},
  flush: () => {},
  retry: () => {},
  reloadDisk: () => {},
  drop: () => {},
} as unknown as SessionFilesController;

const view: SessionViewProps = {
  sessions: [session],
  tasks: [],
  backlog: [],
  onEditTask: () => {},
  backlogPlan: null,
  // The gate is parked on a question, which is what puts the pip on the tab's face.
  gateAlerts: new Set([session.id]),
  selectedId: session.id,
  consoleZone: "detail",
  onConsoleZoneChange: () => {},
  onSelect: () => {},
  onDeselect: () => {},
  expandedId: session.id,
  onToggleExpand: () => {},
  onOpenReviews: () => {},
  onOpenDiff: () => {},
  onOpenFiles: () => {},
  onOpenFile: () => false,
  fileTabRequest: null,
  conversationTabRequest: null,
  // Exactly what App's `y` handler sets. This IS the chord's effect.
  workflowsTabRequest: scenario === "workflows" ? { sessionId: session.id, nonce: 1 } : null,
  diffTabRequest: null,
  files,
  onReset: () => {},
  onComplete: () => {},
  onKill: () => {},
  onKilled: () => {},
  resetNonces: {},
  registerEl: () => {},
  registerActions: () => {},
  registerLaunchers: () => {},
  registerFind: () => {},
  registerDetailScroll: () => {},
  registerReaderTab: () => {},
  renamingId: null,
  onRenameStart: () => {},
  onRenameClose: () => {},
  foremanMode: "dry-run",
  foremanEnabled: false,
  foremanAllowlist: [],
  inputReviewBySession: new Map<string, string>(),
  pendingReviewIds: new Set<string>(),
  workflowRunBySession: new Map([[session.id, run]]),
  onOpenWorkflowRun: () => {},
};

function Harness(): React.JSX.Element {
  const overlays = useOverlayHost();
  return (
    <OverlayHost value={overlays}>
      <div className="evidence-shell">
        <ConsoleDetail session={session} view={view} />
      </div>
    </OverlayHost>
  );
}

const host = document.getElementById("root");
if (host) createRoot(host).render(<Harness />);
