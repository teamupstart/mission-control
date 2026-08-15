// Render the away digest for a run parked on an UNPUSHED head, from the real pipeline.
//
// Evidence for the reviewer question "show the new wording on a surface a person actually
// reads". Every step below is the shipped code path: a real git repository with real commits
// no remote holds, the real binding row, the real `WorkflowManager.bindingCheckout` resolver,
// the real observer shelling out to real git, the real away watcher, the real `stuckAlert`,
// the real away buffer, and the real `AwayDigestCard` component with the app's own stylesheet.
// Nothing here hand-writes the sentence being demonstrated - it comes back out of the daemon.
//
// Writes into `e2e/.artifacts/`, which is gitignored: evidence attaches to the pull request
// and is never committed.
//
//   node --import tsx scripts/evidence-unpushed-digest.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-evidence-unpushed-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { startAwayWatcher } = await import("../src/server/away/watcher.ts");
const { createUnpushedObserver } = await import("../src/server/away/unpushed-observer.ts");
const { setAwayConfig } = await import("../src/server/away/config.ts");
const { stuckAlert } = await import("../src/shared/alerts.ts");
const { emptyBuffer, foldAlerts, closeBuffer, digestLines, rollupLine } = await import(
  "../src/shared/away-buffer.ts"
);
const { AwayDigestCard } = await import("../src/web/components/AwayDigestCard.tsx");
const { OverlayHost } = await import("../src/web/components/Overlay.tsx");
const { renderToStaticMarkup } = await import("react-dom/server");
const React = (await import("react")).default;

const db = openDb();
const MIN = 60_000;

// ---- 1. a real checkout holding two commits no remote has ----
const repo = join(home, "review-checkout");
mkdirSync(repo, { recursive: true });
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "evidence",
      GIT_AUTHOR_EMAIL: "evidence@example.com",
      GIT_COMMITTER_NAME: "evidence",
      GIT_COMMITTER_EMAIL: "evidence@example.com",
    },
  });
execFileSync("git", ["init", "-q", "-b", "fix/inspector-findings", repo], { stdio: "pipe" });
writeFileSync(join(repo, "README.md"), "# base\n");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "base");
const bare = join(home, "origin.git");
execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "pipe" });
git(repo, "remote", "add", "origin", bare);
git(repo, "push", "-q", "-u", "origin", "fix/inspector-findings");
git(repo, "commit", "-q", "--allow-empty", "-m", "address the Inspector's findings");
git(repo, "commit", "-q", "--allow-empty", "-m", "tighten the guard it asked for");
// The same comparison the reader makes, so this line corroborates it rather than measuring
// something else and appearing to agree.
console.log(
  `[evidence] checkout is ahead of @{upstream} by ${
    git(repo, "rev-list", "--count", "@{upstream}..HEAD").trim()
  }`,
);

// ---- 2. the real binding, and the real resolver over it ----
const GRAPH = { nodes: [], edges: [] };
const DEFAULTS = JSON.stringify({
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
});
db.prepare(
  `INSERT INTO workflow_definitions (
     id, name, normalized_name, description, draft_graph_json, completion_policy_json,
     binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
   ) VALUES ('w', 'No-Mistakes Review', 'no-mistakes review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
).run(JSON.stringify(GRAPH), DEFAULTS);
db.prepare(
  `INSERT INTO workflow_versions (
     id, workflow_id, version, source_draft_revision, graph_json,
     completion_policy_json, binding_defaults_json, published_at
   ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
).run(JSON.stringify(GRAPH), DEFAULTS);

const store = new WorkflowStore(db);
store.insertBinding({
  id: "b",
  workflowVersionId: "v",
  noteKey: "note",
  sessionId: "session",
  sessionAgent: "claude",
  sessionName: "Fix the Inspector findings",
  sessionCwd: repo,
  sessionRepoRoot: repo,
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
  now: 1,
});

const registry = new Registry();
new PersonaManager(registry, store);
const workflows = new WorkflowManager(registry, store);
setAwayConfig({ detectStalls: true });

// ---- 3. the real observer and the real watcher ----
const session = {
  id: "session",
  agent: "claude",
  name: "Fix the Inspector findings",
  runtime: "terminal",
  foremanInvite: null,
  nameSource: "process",
  state: "idle",
  cwd: repo,
  gitBranch: "fix/inspector-findings",
  gitRoot: repo,
  repoRoot: repo,
  pid: 4242,
  tty: null,
  permissionMode: null,
  terminals: [],
  agentSessionId: null,
  transcriptPath: null,
  instrumented: true,
  stateConfirmed: true,
  hooksSeen: true,
  activity: null,
  startedAt: null,
  firstSeen: 0,
  lastSeen: 0,
  lastActivity: 0,
  pendingReviews: 0,
  task: null,
  prUrl: null,
  prNumber: null,
  prState: null,
  prChecks: null,
  meta: null,
  effortBaselineReady: false,
  note: null,
  cost: null,
  goal: null,
  queue: null,
  pendingTurns: [],
  orphanedQueue: null,
  inspector: null,
  paneDialog: null,
};
const run = {
  id: "6007166e",
  bindingId: "b",
  workflowId: "w",
  workflowName: "No-Mistakes Review",
  workflowVersion: 8,
  sessionId: "session",
  noteKey: "note",
  status: "waiting_for_new_head",
  phase: "inspector_findings",
  round: 2,
  maxRepairRounds: 5,
  activePersonaNames: [],
  failedPersonaCount: 0,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  uncertainDeliveryCount: 0,
  refusedDeliveryCount: 0,
  updatedAt: 0,
};

const observer = createUnpushedObserver({
  checkoutFor: (r) => workflows.bindingCheckout(r.bindingId),
});
const source = {
  snapshot: () => ({ sessions: [session], tasks: [], workflowRunSummaries: [run] }),
};
const watcher = startAwayWatcher(source, () => 42 * MIN, { unpushedObserver: observer });
watcher.tick();
for (let i = 0; i < 200 && !observer.snapshot().has(run.id); i++) {
  await new Promise((r) => setTimeout(r, 25));
}
watcher.tick();
const stalls = watcher.stalls();
watcher.stop();

if (!stalls.length) throw new Error("no stall was produced - evidence would be a fabrication");
console.log(`[evidence] daemon said: ${JSON.stringify(stalls[0].reason)}`);
if (!stalls[0].reason.includes("not pushed")) {
  throw new Error("the daemon did not name the unpushed commits; refusing to render evidence");
}

// ---- 4. the real alert, the real buffer, the real digest ----
let buffer = emptyBuffer(0);
buffer = foldAlerts(buffer, [stuckAlert(stalls[0], [session])], 42 * MIN);
const closed = closeBuffer(buffer, 42 * MIN);
const digest = {
  since: 0,
  until: 42 * MIN,
  awayMs: 42 * MIN,
  rollup: rollupLine(closed),
  lines: digestLines(closed),
  narrative: null,
  empty: false,
};
console.log(`[evidence] digest line: ${JSON.stringify(digest.lines[0])}`);

// ---- 5. the real component, with the app's own stylesheet ----
// `Overlay` refuses to render outside a host, on purpose - an unregistered overlay leaves the
// global key handler live. So the real host wraps it here rather than the guard being stubbed.
const host = {
  openEntries: [],
  anyOpen: false,
  onlyOpenIs: () => true,
  register: () => () => {},
};
const markup = renderToStaticMarkup(
  React.createElement(
    OverlayHost,
    { value: host },
    React.createElement(AwayDigestCard, { digest, onDismiss: () => {}, onOpenReport: () => {} }),
  ),
);
const css = readFileSync(join(import.meta.dirname, "..", "src", "web", "styles.css"), "utf8");
const out = join(import.meta.dirname, "..", "e2e", ".artifacts", "unpushed-digest");
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "digest.html"),
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;padding:32px;display:flex;justify-content:center;align-items:flex-start}
.away-digest{position:static!important;transform:none!important;inset:auto!important}</style>
</head><body class="theme-dark">${markup}</body></html>`,
);
writeFileSync(join(out, "reason.txt"), `${stalls[0].reason}\n${digest.lines.join("\n")}\n`);
console.log(`[evidence] wrote ${join(out, "digest.html")}`);
rmSync(home, { recursive: true, force: true });
