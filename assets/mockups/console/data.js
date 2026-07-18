/*
 * Fixture fleet + shared render helpers for the layout mockups.
 *
 * One dataset across all four mockups on purpose: the layouts are only
 * comparable if they're showing the same eight sessions in the same states.
 * The shape mirrors src/shared/types.ts Session closely enough that each mockup
 * is a fair test of "does this layout have room for every fact a card carries".
 */

const SESSIONS = [
  {
    id: "s1",
    name: "reset-parks-detached-head",
    agent: "claude",
    tone: "attention",
    state: "needs input",
    nameSource: "tmux · %14",
    goal: { text: "Release the branch a reset was standing on, so a reset doesn't park the checkout on a detached HEAD.", source: "refined" },
    cwd: "~/workspace/ai-harness",
    branch: "mancej/reset-parks-detached-head",
    pr: { num: 62, state: "open", checks: "failing" },
    meta: { model: "Opus 4.8", longContext: true, thinking: "high", ctx: 62 },
    activity: "waiting on you · asked a question 2m ago",
    pendingReviews: 1,
    gated: true,
    instrumented: true,
    mode: "acceptEdits",
    pid: 48213,
    seen: "2m ago",
    nm: {
      steps: ["completed", "completed", "completed", "fix_review", "pending", "pending"],
      stepNames: ["review", "test", "lint", "docs", "push", "ci"],
      gate: "fix_review",
      line: "docs · 2 findings to triage before the branch can push",
      findings: [
        "README doesn't mention that reset now re-attaches the branch",
        "docs/plans/reset.md still describes the detached-HEAD behaviour",
      ],
    },
    fixes: [{ sha: "3e1c614", msg: "fix(reset): release the branch a reset was standing on" }],
    transcript: [
      { role: "user", text: "Reset leaves the worktree on a detached HEAD - fix it." },
      { role: "claude", text: "Reproduced: `git checkout --detach` runs before the branch move, so the branch is still checked out when we try to reset it. Moving the detach after the branch update fixes it." },
      { role: "tool", text: "Bash · git worktree list" },
      { role: "claude", text: "The gate found 2 docs findings. Do you want me to update README and the plan doc, or skip docs for this branch?" },
    ],
  },
  {
    id: "s2",
    name: "persist-compose-drafts",
    agent: "claude",
    tone: "working",
    state: "working",
    nameSource: "tmux · %9",
    goal: { text: "Persist compose-box drafts across reloads so a half-typed reply survives a refresh.", source: "refined" },
    cwd: "~/workspace/ai-harness",
    branch: "mancej/persist-compose-drafts",
    pr: { num: 61, state: "merged", checks: "passing" },
    meta: { model: "Opus 4.8", longContext: true, thinking: "medium", ctx: 38 },
    activity: "running Bash · npm test -- compose-drafts",
    pendingReviews: 0,
    gated: true,
    instrumented: true,
    mode: "acceptEdits",
    pid: 47901,
    seen: "8s ago",
    queue: { open: 2, intent: "address review findings", round: 1, state: "running" },
    nm: {
      steps: ["completed", "running", "pending", "pending", "pending", "pending"],
      stepNames: ["review", "test", "lint", "docs", "push", "ci"],
      gate: null,
      line: "test · running the suite (0 findings so far)",
      findings: [],
    },
    fixes: [],
    transcript: [
      { role: "user", text: "Drafts should survive a reload." },
      { role: "claude", text: "Storing per-session drafts in localStorage keyed by session id + surface, cleared on a successful send." },
      { role: "tool", text: "Edit · src/web/lib/drafts.ts" },
    ],
  },
  {
    id: "s3",
    name: "skills-catalog-sync",
    agent: "codex",
    tone: "working",
    state: "working",
    nameSource: "wezterm",
    goal: null,
    cwd: "~/workspace/ai-harness",
    branch: "codex/skills-catalog-sync",
    pr: null,
    meta: { model: "gpt-5-codex", thinking: null, ctx: 44 },
    activity: "editing src/server/skills/catalog.ts",
    pendingReviews: 0,
    gated: false,
    instrumented: true,
    mode: null,
    pid: 46550,
    seen: "31s ago",
    transcript: [
      { role: "user", text: "Reconcile the skills catalog with what's on disk." },
      { role: "codex", text: "Walking .claude/skills and diffing against the catalog manifest." },
    ],
  },
  {
    id: "s4",
    name: "mission-control-and-card-ux",
    agent: "claude",
    tone: "idle",
    state: "idle",
    nameSource: "tmux · %3",
    goal: { text: "Polish the card UX and the Mission Control topbar.", source: "refined" },
    cwd: "~/workspace/ai-harness",
    branch: "mancej/mission-control-and-card-ux",
    pr: { num: 60, state: "merged", checks: "passing" },
    meta: { model: "Opus 4.8", longContext: true, thinking: "high", ctx: 84 },
    activity: "idle · last turn finished 6m ago",
    pendingReviews: 0,
    gated: true,
    instrumented: true,
    mode: "plan",
    pid: 44120,
    seen: "6m ago",
    task: { kind: "pr", title: "Mission control and card UX", status: "done", outcome: "merged #60" },
    transcript: [
      { role: "user", text: "Tighten up the topbar spacing." },
      { role: "claude", text: "Done - merged as #60. Anything else on the card UX?" },
    ],
  },
  {
    id: "s5",
    name: "harness-runtime-probe",
    agent: "claude",
    tone: "attention",
    state: "needs input",
    nameSource: "tmux · %21",
    goal: { text: "Probe the harness runtime for a stable version handshake.", source: "heuristic" },
    cwd: "~/workspace/ai-harness",
    branch: "mancej/harness-runtime-probe",
    pr: null,
    meta: { model: "Sonnet 5", thinking: "medium", ctx: 27 },
    activity: "waiting on you · Foreman escalated a decision",
    pendingReviews: 1,
    gated: false,
    instrumented: true,
    mode: "default",
    pid: 49002,
    seen: "just now",
    note: {
      disposition: "escalated",
      text: "It's asking whether to pin the runtime version or read it from the manifest at boot. That's an architecture call with a migration attached - I'm not deciding it for you.",
    },
    transcript: [
      { role: "user", text: "Add a version handshake to the harness runtime." },
      { role: "claude", text: "Should the version be pinned in the package, or read from the manifest at boot? Pinning is simpler but means a release to change it." },
    ],
  },
  {
    id: "s6",
    name: "html-plans-drift-followup",
    agent: "claude",
    tone: "idle",
    state: "idle",
    nameSource: "tmux · %7",
    goal: { text: "Generate plan.html from plan.md instead of hand-writing both.", source: "refined" },
    cwd: "~/workspace/ai-harness",
    branch: "mancej/html-plans-drift",
    pr: { num: 63, state: "open", checks: "passing" },
    meta: { model: "Opus 4.8", thinking: "medium", ctx: 19 },
    activity: "idle · waiting for review on #63",
    pendingReviews: 0,
    gated: true,
    instrumented: true,
    mode: "acceptEdits",
    pid: 43880,
    seen: "22m ago",
    task: { kind: "backlog", title: "Drift-check plan.html against plan.md", status: "backlog" },
    transcript: [
      { role: "user", text: "The html-plans skill makes you hand-write plan.html. Fix the drift." },
      { role: "claude", text: "Opened #63 with a generator. Waiting on your review." },
    ],
  },
  {
    id: "s7",
    name: "codex-triage",
    agent: "codex",
    tone: "neutral",
    state: "running",
    nameSource: "process",
    goal: null,
    cwd: "~/workspace/scratch",
    branch: null,
    pr: null,
    meta: { model: "gpt-5-codex", thinking: null, ctx: null },
    activity: null,
    pendingReviews: 0,
    gated: false,
    instrumented: false,
    mode: null,
    pid: 50117,
    seen: "up 14m",
    transcript: [{ role: "codex", text: "(no hooks reporting - transcript unavailable)" }],
  },
  {
    id: "s8",
    name: "old-experiment",
    agent: "claude",
    tone: "exited",
    state: "exited",
    nameSource: "tmux · %1",
    goal: { text: "Spike a tray-icon menu for the desktop build.", source: "refined" },
    cwd: "~/workspace/ai-harness",
    branch: "mancej/tray-spike",
    pr: null,
    meta: { model: "Opus 4.8", thinking: "low", ctx: 11 },
    activity: null,
    pendingReviews: 0,
    gated: false,
    instrumented: true,
    mode: null,
    pid: 41002,
    seen: "exited 1h ago",
    transcript: [{ role: "claude", text: "Spike done - notes are in todo/tray.md." }],
  },
];

const TONE_ORDER = { attention: 0, working: 1, idle: 2, neutral: 3, exited: 4 };
const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" };
const NM_TONE = {
  completed: "nm-done",
  running: "nm-run",
  awaiting_approval: "nm-gate",
  fix_review: "nm-gate",
  pending: "nm-pending",
  skipped: "nm-skip",
  failed: "nm-fail",
};

const sorted = [...SESSIONS].sort(
  (a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.name.localeCompare(b.name),
);
const counts = {
  total: SESSIONS.length,
  attention: SESSIONS.filter((s) => s.tone === "attention").length,
  working: SESSIONS.filter((s) => s.tone === "working").length,
  reviews: SESSIONS.reduce((n, s) => n + s.pendingReviews, 0),
};

/* ---- small render helpers, shared by the mockups ---- */

const h = (html) => html; // tag-free marker: these strings are HTML

function ctxTone(pct) {
  if (pct == null) return "ok";
  if (pct >= 80) return "danger";
  if (pct >= 60) return "warn";
  return "ok";
}

function prChip(s) {
  if (!s.pr) return "";
  const merged = s.pr.state === "merged";
  const icon = merged
    ? `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden><path fill="currentColor" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"/></svg>`
    : `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`;
  const alert =
    s.pr.checks === "failing"
      ? `<a class="pr-checks-alert" href="#" onclick="return false" title="A CI check failed on this PR"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path fill="currentColor" d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg></a>`
      : "";
  return `<a class="pr-chip ${merged ? "pr-merged" : "pr-open"}" href="#" onclick="return false" title="${merged ? "Pull request merged" : "Open pull request"} - open on GitHub">${icon}<span>#${s.pr.num}</span></a>${alert}`;
}

function badge(s) {
  const btn = s.pendingReviews > 0;
  return `<span class="badge badge-${s.tone}${btn ? " badge-btn" : ""}"><span class="badge-dot"></span>${s.state}${btn ? " →" : ""}</span>`;
}

function goalLine(s) {
  if (!s.goal) {
    return `<p class="goal goal-none" title="Goal is derived from a session's prompts. Codex sessions don't expose them.">No goal · Codex sessions don't expose their prompts</p>`;
  }
  return `<p class="goal goal-${s.goal.source}" title="${s.goal.text}">${s.goal.text}</p>`;
}

function runtimeRow(s) {
  const m = s.meta;
  if (!m || (!m.model && !m.thinking && m.ctx == null)) return "";
  const out = [];
  if (m.model)
    out.push(
      `<span class="rt-pill rt-model">${m.model}${m.longContext ? '<span class="rt-1m">1M</span>' : ""}</span>`,
    );
  if (m.thinking)
    out.push(
      `<span class="rt-pill rt-think" title="Reasoning effort: ${m.thinking}"><span class="rt-think-glyph">✦</span>${m.thinking}</span>`,
    );
  if (m.ctx != null)
    out.push(
      `<span class="rt-ctx rt-ctx-${ctxTone(m.ctx)}" title="${m.ctx}% of the context window used"><span class="rt-meter"><span class="rt-meter-fill" style="width:${m.ctx}%"></span></span><span class="rt-ctx-num">${m.ctx}%</span></span>`,
    );
  return out.join("");
}

function nmStrip(s, needsYou) {
  if (!s.nm) return "";
  const dots = s.nm.steps
    .map(
      (st, i) =>
        `<span class="nm-dot ${NM_TONE[st]}" title="${s.nm.stepNames[i]}: ${st.replace("_", " ")}"></span>`,
    )
    .join("");
  const gate =
    s.nm.gate && needsYou
      ? `<div class="nm-gate-row"><span class="nm-gate-label">parked at ${s.nm.gate.replace("_", " ")} - needs you</span>
           <button class="nm-btn">approve</button><button class="nm-btn">fix</button><button class="nm-btn">skip</button></div>`
      : s.nm.gate
        ? `<div class="nm-gate-row"><span class="nm-line">parked at ${s.nm.gate.replace("_", " ")} · agent resolving</span></div>`
        : "";
  const findings = s.nm.findings.length
    ? `<ul class="nm-findings">${s.nm.findings.map((f) => `<li>${f}</li>`).join("")}</ul>`
    : "";
  return `<div class="nm-strip${needsYou && s.nm.gate ? " needs-you" : ""}">
      <div class="nm-head"><span class="nm-brand">◇ no-mistakes</span><span class="nm-line">${s.nm.line}</span><span class="nm-dots">${dots}</span></div>
      ${gate}${findings}
    </div>`;
}

function transcript(s) {
  return `<div class="xcript">${s.transcript
    .map(
      (m) =>
        `<div class="msg msg-${m.role === "user" ? "user" : m.role === "tool" ? "tool" : "agent"}"><span class="msg-role">${m.role}</span><span class="msg-body">${m.text}</span></div>`,
    )
    .join("")}</div>`;
}

function composeBox(s) {
  const can = s.state !== "exited" && s.nameSource !== "process";
  if (!can)
    return `<div class="compose"><textarea disabled placeholder="No pane to send into - this session was discovered by process only"></textarea></div>`;
  return `<div class="compose"><textarea placeholder="Reply to ${s.name}…"></textarea><button class="send-btn">Send</button></div>`;
}

function topbar(layoutName) {
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark"></span><h1>Mission Control</h1><span class="layout-tag">${layoutName}</span></div>
    <div class="filter-box"><span class="filter-icon">⌕</span><input class="filter-input" placeholder="Filter (/)" aria-label="Filter sessions by title or status"></div>
    <div class="summary">
      <div class="stat"><span class="stat-n">${counts.total}</span><span class="stat-label">sessions</span></div>
      <div class="stat stat-attention"><span class="stat-n">${counts.attention}</span><span class="stat-label">need you</span></div>
      <div class="stat stat-working"><span class="stat-n">${counts.working}</span><span class="stat-label">working</span></div>
      <button class="stat-btn"><div class="stat stat-attention"><span class="stat-n">${counts.reviews}</span><span class="stat-label">reviews</span></div></button>
    </div>
    <span style="flex:1"></span>
    <button class="ghost-btn" title="Alert settings">🔔 Alerts</button>
    <button class="ghost-btn" title="Foreman: drafting replies, 2 queued">◈ Foreman <span class="ghost-key">dry-run</span></button>
    <button class="ghost-btn" title="Settings (⌘,)">⚙</button>
    <button class="ghost-btn">Roundup <kbd class="ghost-key">R</kbd><span class="ghost-badge">1</span></button>
    <button class="dispatch-btn"><span>＋</span> Dispatch</button>
    <div class="link"><span class="link-dot"></span>live</div>
  </header>`;
}

function mockbar(current) {
  const all = [
    ["console.html", "1 · Console"],
    ["board.html", "2 · Board"],
    ["table.html", "3 · Ops table"],
    ["triage.html", "4 · Triage"],
  ];
  return `<div class="mockbar"><b>LAYOUT MOCKUP</b>${all
    .map(([href, label]) => `<a href="${href}"${label === current ? ' class="on"' : ""}>${label}</a>`)
    .join("")}<span class="sep"></span><a href="index.html">↩ All four</a></div>`;
}
