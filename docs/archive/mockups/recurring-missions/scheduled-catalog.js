const screen = document.body.dataset.screen || "catalog";
const app = document.querySelector("#app");

const schedules = [
  { id: "dep", icon: "⌁", name: "Dependency audit", repo: "mission-control", cadence: "Mondays · 8:00 AM", next: "Mon 8:00 AM", nextFull: "Monday, July 27 · 8:00 AM EDT", template: "Run dependency audit and update unsafe packages", last: "PR #477 · 24m", state: "healthy", agent: "Claude", guarantee: "Catch up on wake" },
  { id: "standup", icon: "◎", name: "Daily standup digest", repo: "control-plane", cadence: "Weekdays · 7:30 AM", next: "Tomorrow 7:30 AM", nextFull: "Friday, July 24 · 7:30 AM EDT", template: "Summarize fleet progress and blocked sessions", last: "Delivered · 42s", state: "healthy", agent: "Codex", guarantee: "Catch up on wake" },
  { id: "flaky", icon: "◇", name: "Flaky test sweep", repo: "payments-api", cadence: "Tuesdays · 9:00 AM", next: "Tomorrow 9:00 AM", nextFull: "Tuesday, July 28 · 9:00 AM EDT", template: "Run the flaky-test suite and file reproducible failures", last: "3 tasks filed", state: "attention", agent: "Codex", guarantee: "OS-assisted wake" },
  { id: "cost", icon: "$", name: "Weekly cost report", repo: "mission-control", cadence: "Fridays · 12:00 PM", next: "Fri 12:00 PM", nextFull: "Friday, July 24 · 12:00 PM EDT", template: "Produce the weekly fleet cost and throughput report", last: "$138.42 / 12 ships", state: "healthy", agent: "Claude", guarantee: "Always-on runner" },
  { id: "docs", icon: "⌕", name: "Docs freshness", repo: "docs-site", cadence: "Thursdays · 9:15 AM", next: "Paused", nextFull: "Paused · no occurrence is scheduled", template: "Check product docs against shipped behavior", last: "2 empty runs", state: "paused", agent: "Claude", guarantee: "Catch up on wake" },
];

function header() {
  return `
    <div class="mockup-banner"><b>FEATURE LAB</b><a href="../feature-lab/index.html">All concepts</a><span>›</span><span>Recurring Missions</span><span>›</span><strong>Scheduled Catalog</strong><span class="space"></span><span>Interactive HTML mockup</span></div>
    <header class="topbar">
      <div class="brand"><span class="brand-mark"></span><h1>Mission Control</h1></div>
      <div class="filter" style="width:min(310px,30vw)">⌕<input placeholder="Filter sessions (⌘F)" aria-label="Filter sessions"></div>
      <div class="top-stats">
        <div class="stat"><b>8</b><span>sessions</span></div>
        <div class="stat attn"><b>1</b><span>need you</span></div>
        <div class="stat"><b>4</b><span>working</span></div>
      </div>
      <button class="top-btn">Foreman · live</button>
      <button class="top-btn">＋ Dispatch</button>
      <button class="mission-trigger" data-nav="catalog" title="Open recurring missions"><span>◷</span> Missions <span class="badge">1</span></button>
      <button class="top-btn" data-toast="Sitrep stays unchanged">📡</button>
      <button class="top-btn" data-toast="Settings stays unchanged">⚙</button>
      <span class="status-pill healthy">live</span>
    </header>`;
}

function nav() {
  const entries = [
    ["catalog", "Catalog"],
    ["editor", "Create / edit"],
    ["preview", "Preview & availability"],
    ["history", "Run history"],
  ];
  return `<nav class="subnav" aria-label="Scheduled catalog screens">${entries.map(([id, label]) => `<a class="${screen === id ? "active" : ""}" href="${id === "catalog" ? "catalog.html" : `${id}.html`}">${label}</a>`).join("")}</nav>`;
}

function surfaceHead(title, copy, actions = "") {
  return `<div class="surface-head"><div><p class="eyebrow">Recurring Missions</p><h2>${title}</h2><p>${copy}</p></div><div class="surface-actions">${actions}</div></div>${nav()}`;
}

function scheduleRows() {
  return schedules.map((s, i) => `
    <tr class="${i === 0 ? "selected" : ""}" data-schedule="${s.id}">
      <td><div class="mission-name"><span class="mission-icon">${s.icon}</span><div><strong>${s.name}</strong><span>${s.repo} · ${s.agent}</span></div></div></td>
      <td><strong>${s.cadence}</strong><br><span class="dim">${s.guarantee}</span></td>
      <td>${s.next}<br><span class="dim">${s.last}</span></td>
      <td><span class="status-pill ${s.state}">${s.state}</span></td>
    </tr>`).join("");
}

function selectedDetail(s = schedules[0]) {
  return `
    <div class="panel-head">
      <div class="detail-title"><span class="mission-icon">${s.icon}</span><div><h3>${s.name}</h3><p>${s.repo} · revision 4</p></div></div>
      <div class="detail-actions"><button class="btn" data-toast="Mission paused; future occurrences stay in history">Pause</button><button class="btn" data-nav="editor">Edit</button></div>
    </div>
    <div class="panel-body stack">
      <div class="next-run"><span class="tiny dim">NEXT OCCURRENCE</span><div class="time">${s.nextFull}</div><p>Will create a normal backlog task. Foreman may dispatch it only after the existing live-mode, allowlist, dependency, and capacity checks pass.</p></div>
      <dl class="kv">
        <dt>Template</dt><dd><strong>${s.template}</strong></dd>
        <dt>Cadence</dt><dd>${s.cadence}</dd>
        <dt>Time zone</dt><dd>America/New_York · DST aware</dd>
        <dt>Task defaults</dt><dd>${s.agent} · ship · high · model follows harness default</dd>
        <dt>Overlap</dt><dd>Skip if an earlier generated task is still active</dd>
        <dt>Missed runs</dt><dd>Coalesce to one task when Mission Control resumes</dd>
      </dl>
      <div class="guarantee" style="--tone:var(--attention)"><span class="mark">☾</span><div><strong>${s.guarantee} · ${s.guarantee === "Always-on runner" ? "wall-clock capable" : "best effort"}</strong>${s.guarantee === "Always-on runner" ? "A trusted always-on host claims the occurrence even if this laptop is off; runner availability is still visible in history." : "If this laptop is asleep when the mission is due, the occurrence is durably accounted for after the daemon resumes. It is not promised to run at the original wall-clock instant."}</div></div>
      <div class="row">${[["12", "runs"], ["10", "created"], ["1", "coalesced"], ["1", "skipped"]].map(([n,l]) => `<div class="metric" style="flex:1"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
      <div class="row"><button class="btn" data-nav="preview">Preview next 10</button><button class="btn" data-nav="history">Open history</button><span class="space"></span><button class="btn primary" data-toast="Run-now creates a manual occurrence through the same exact-once claim path">Run now</button></div>
    </div>`;
}

function catalog() {
  return `${header()}<main class="surface">${surfaceHead(
    "Scheduled Catalog",
    "Durable task templates with explicit cadence, laptop-availability behavior, exact-once occurrence history, and the same backlog safety gates as work created by a human.",
    `<button class="btn">Export</button><button class="btn primary" data-nav="editor">＋ Create recurring mission</button>`
  )}
  <div class="catalog-layout">
    <section class="panel">
      <div class="catalog-toolbar"><div class="filter">⌕<input id="catalog-search" placeholder="Search name or repository…" aria-label="Search schedules"></div><div class="seg" id="state-filter"><button class="active" data-state="all">All</button><button data-state="healthy">Healthy</button><button data-state="paused">Paused</button><button data-state="attention">Attention</button></div></div>
      <div style="overflow:auto"><table class="schedule-table"><thead><tr><th>Mission</th><th>Schedule & execution</th><th>Next / last</th><th>Status</th></tr></thead><tbody id="schedule-rows">${scheduleRows()}</tbody></table></div>
    </section>
    <section class="panel" id="selected-detail">${selectedDetail()}</section>
  </div></main>`;
}

function editor() {
  return `${header()}<main class="surface">${surfaceHead(
    "Create recurring mission",
    "The editor separates what the task should do, when it becomes due, and what Mission Control may promise when this machine is unavailable.",
    `<button class="btn" data-nav="catalog">Cancel</button>`
  )}
  <div class="editor-layout">
    <aside class="panel"><div class="panel-head"><h3>Setup</h3><span class="meta">draft</span></div><div class="step-list">
      <div class="step done"><span class="num">✓</span><div><b>Task template</b><span>Repo and agent</span></div></div>
      <div class="step done"><span class="num">✓</span><div><b>Cadence</b><span>Wall-clock rules</span></div></div>
      <div class="step active"><span class="num">3</span><div><b>Availability</b><span>Sleep and offline policy</span></div></div>
      <div class="step"><span class="num">4</span><div><b>Guardrails</b><span>Overlap and catch-up</span></div></div>
      <div class="step"><span class="num">5</span><div><b>Review</b><span>Preview and enable</span></div></div>
    </div></aside>
    <section class="panel">
      <div class="form-section"><h3>Task template</h3><p>Every occurrence creates an ordinary backlog task from this immutable revision.</p><div class="form-grid">
        <div class="field"><label for="name">Mission name</label><input class="input" id="name" value="Dependency audit"></div>
        <div class="field"><label for="repo">Repository</label><input class="input mono" id="repo" value="/Users/jordan/workspace/mission-control"></div>
        <div class="field full"><label for="intent">Agent instructions</label><textarea class="input" id="intent">Run the dependency audit, update unsafe packages, execute the full test suite, and open a PR if anything changed. If no changes are required, report the evidence and finish without editing files.</textarea><div class="hint">Stored as the generated task’s intent. A title is required so recurring runs never spend an LLM call naming themselves.</div></div>
        <div class="field"><label for="agent">Agent</label><select class="input" id="agent"><option>Claude</option><option>Codex</option></select></div>
        <div class="field"><label for="kind">Task kind</label><select class="input" id="kind"><option>Ship</option><option>Scout</option></select></div>
      </div></div>
      <div class="form-section"><h3>Cadence</h3><p>Presets remain human-readable; the advanced expression is the stored, validated schedule.</p><div class="form-grid">
        <div class="field"><label>Repeats</label><select class="input"><option>Weekly</option><option>Weekdays</option><option>Daily</option><option>Monthly</option><option>Advanced cron</option></select></div>
        <div class="field"><label>Day and time</label><div class="row"><select class="input"><option>Monday</option></select><input class="input" type="time" value="08:00"></div></div>
        <div class="field"><label>Time zone</label><select class="input"><option>America/New_York (EDT)</option><option>UTC</option><option>America/Los_Angeles (PDT)</option></select></div>
        <div class="field"><label>Stored expression</label><input class="input mono" value="0 8 * * 1" readonly></div>
      </div></div>
      <div class="form-section"><h3>Laptop availability</h3><p>No local timer can run while the CPU is suspended. Pick the guarantee this mission actually needs.</p>
        <div class="radio-cards" id="availability-options">
          <label class="radio-card selected"><input type="radio" name="availability" value="catchup" checked><span><strong>Catch up when Mission Control resumes</strong>Persist every due instant. If the laptop sleeps through one or more runs, create one coalesced backlog task after wake and record what was missed.</span><span class="tag">Recommended v1</span></label>
          <label class="radio-card"><input type="radio" name="availability" value="os"><span><strong>Ask the operating system to wake this machine</strong>Install a native scheduled wake when the platform and power settings support it. Fall back to catch-up and show when the wake guarantee is unavailable.</span><span class="tag">Optional helper</span></label>
          <label class="radio-card"><input type="radio" name="availability" value="remote"><span><strong>Run on an always-on Mission runner</strong>Lease the occurrence to a trusted always-on host. This is the only option that can promise wall-clock execution when the laptop is off.</span><span class="tag">Future</span></label>
        </div>
      </div>
      <div class="form-section"><h3>Guardrails</h3><div class="form-grid">
        <div class="field"><label>When prior generated work is still active</label><select class="input"><option>Skip and record the occurrence</option><option>Create another backlog task</option></select></div>
        <div class="field"><label>After multiple missed occurrences</label><select class="input"><option>Coalesce to the latest occurrence</option><option>Create every missed task</option><option>Skip all missed tasks</option></select></div>
        <div class="field"><label>Priority</label><select class="input"><option>High</option><option>Medium</option><option>Low</option><option>Blocker</option></select></div>
        <div class="field"><label>Labels</label><input class="input" value="maintenance, dependencies"></div>
      </div></div>
      <div class="form-section"><div class="footer-bar"><span class="small muted">Draft · not enabled</span><span class="space"></span><button class="btn" data-toast="Saved as paused — no clock started">Save paused</button><button class="btn" data-nav="preview">Preview 10 occurrences</button><button class="btn primary" data-toast="Saved and enabled — first occurrence Monday at 8:00 AM">Save & enable</button></div></div>
    </section>
    <aside class="panel"><div class="panel-head"><h3>Execution assurance</h3></div><div class="panel-body stack">
      <div class="assurance-meter" id="assurance-meter"><div class="active" data-mode="catchup"><b>Catch-up</b><span>selected</span></div><div data-mode="os"><b>Wake</b><span>not installed</span></div><div data-mode="remote"><b>Remote</b><span>not connected</span></div></div>
      <div class="guarantee" style="--tone:var(--idle)"><span class="mark">✓</span><div><strong>Guaranteed durable</strong>The due instant, template revision, and outcome survive daemon and app restarts.</div></div>
      <div class="guarantee" style="--tone:var(--attention)"><span class="mark">≈</span><div><strong>Best-effort wall clock</strong>A sleeping or powered-off laptop may file the task late. The catalog will show the actual delay.</div></div>
      <div class="guarantee" style="--tone:var(--working)"><span class="mark">→</span><div><strong>Backlog first</strong>Creation never types into a pane. Foreman remains the only autonomous path from backlog to execution.</div></div>
      <button class="btn" data-nav="preview">See standby simulation</button>
    </div></aside>
  </div></main>`;
}

function preview() {
  const occurrences = [
    ["Mon Jul 27", "08:00 EDT", "var(--purple)", "Scheduled", "Normal local occurrence · revision 4", "healthy", "on time"],
    ["Mon Aug 03", "08:00 EDT", "var(--attention)", "Laptop asleep", "Simulated: daemon resumes at 10:14 and claims this due instant once", "attention", "+2h 14m"],
    ["Mon Aug 10", "08:00 EDT", "var(--working)", "Capacity overlap", "Task is created on time; Foreman may hold it behind the 5-agent ceiling", "healthy", "backlog"],
    ["Mon Oct 26", "08:00 EDT", "var(--purple)", "DST preview", "Still 8:00 AM America/New_York; UTC offset changes on Nov 1", "healthy", "12:00 UTC"],
    ["Mon Nov 02", "08:00 EST", "var(--purple)", "After DST", "Wall-clock time stays fixed; the UTC instant moves by one hour", "healthy", "13:00 UTC"],
  ];
  return `${header()}<main class="surface">${surfaceHead(
    "Occurrence preview & availability",
    "Preview uses the same recurrence evaluator and missed-run policy as the daemon. The simulation makes sleep, DST, overlap, and capacity outcomes legible before a schedule is enabled.",
    `<button class="btn" data-nav="editor">← Edit mission</button><button class="btn primary" data-toast="Preview accepted; mission enabled">Enable mission</button>`
  )}
  <div class="preview-layout">
    <section class="panel">
      <div class="panel-head"><h3>Dependency audit · next occurrences</h3><span class="meta">America/New_York · revision 4</span></div>
      <div class="occurrence-list">${occurrences.map(([date,time,tone,title,copy,state,tag]) => `<div class="occurrence"><time>${date}<br>${time}</time><span class="node" style="--tone:${tone}">◇</span><div><h4>${title}</h4><p>${copy}</p></div><span class="status-pill ${state}">${tag}</span></div>`).join("")}</div>
    </section>
    <aside class="stack">
      <section class="panel"><div class="panel-head"><h3>Standby simulation</h3></div><div class="panel-body stack">
        <div class="simulation"><h4>Sleep from 7:42–10:14 AM</h4><p>The 8:00 AM due instant is not lost. At 10:14 the daemon inserts one claimed occurrence, creates one backlog task, advances next run to Aug 10, and records a 2h 14m delay.</p></div>
        <dl class="kv"><dt>Policy</dt><dd>Catch up on wake</dd><dt>Missed count</dt><dd>1 occurrence</dd><dt>Task created</dt><dd>10:14:03 AM</dd><dt>Dispatch</dt><dd>Still governed by Foreman</dd></dl>
        <button class="btn" data-toast="Simulation changed to 8 days offline: 8 misses coalesce to one task">Simulate 8 days offline</button>
      </div></section>
      <section class="panel"><div class="panel-head"><h3>Execution options</h3><span class="meta">honest guarantees</span></div><div style="overflow:auto"><table class="coverage-table"><thead><tr><th>Mode</th><th>Sleep</th><th>Powered off</th><th>Privilege</th></tr></thead><tbody>
        <tr><td>Local catch-up</td><td class="partial">After wake</td><td class="partial">After start</td><td class="yes">None</td></tr>
        <tr><td>OS-assisted wake</td><td class="partial">Hardware dependent</td><td class="no">No guarantee</td><td class="partial">Often elevated</td></tr>
        <tr><td>Always-on runner</td><td class="yes">On time</td><td class="yes">On time</td><td class="partial">Remote trust</td></tr>
      </tbody></table></div></section>
      <section class="panel"><div class="panel-head"><h3>Recommendation</h3></div><div class="panel-body"><div class="guarantee" style="--tone:var(--purple)"><span class="mark">1</span><div><strong>Ship durable catch-up first</strong>It is deterministic, privilege-free, and testable. Label it “best effort,” then add platform wake adapters and remote runners as explicit higher assurance modes.</div></div></div></section>
    </aside>
  </div></main>`;
}

function history() {
  const rows = [
    ["Jul 20 · 8:00", "Created", "On time", "MC-482 · backlog → done", "PR #477", "rev 4", "healthy"],
    ["Jul 13 · 10:14", "Created", "Catch-up +2h 14m", "MC-468 · backlog → done", "No changes", "rev 4", "attention"],
    ["Jul 06 · 8:00", "Skipped", "Prior task active", "MC-451 was still running", "Policy decision", "rev 3", "paused"],
    ["Jun 29 · 8:00", "Created", "On time", "MC-439 · backlog → done", "PR #461", "rev 3", "healthy"],
    ["Jun 22 · 8:00", "Failed", "Repo unavailable", "No task created", "Path check failed", "rev 2", "attention"],
  ];
  const audits = [
    ["10:14:03", "var(--attention)", "Daemon resumed", "Sleep gap detected from 07:42:11 to 10:14:03."],
    ["10:14:03", "var(--purple)", "Occurrence claimed", "Unique key dep-audit / 2026-07-13T12:00:00Z inserted."],
    ["10:14:03", "var(--working)", "Backlog task created", "MC-468 created from schedule revision 4; next run advanced."],
    ["10:14:08", "var(--idle)", "SSE delivered", "Catalog and backlog updated over the existing live connection."],
    ["10:22:41", "var(--working)", "Foreman dispatched", "Existing capacity, allowlist, and dependency gates passed."],
  ];
  return `${header()}<main class="surface">${surfaceHead(
    "Run history",
    "Every due instant gets an immutable occurrence record, whether it creates a task, coalesces after standby, skips because prior work is active, or fails validation.",
    `<button class="btn" data-nav="catalog">← Catalog</button><button class="btn">Export CSV</button>`
  )}
  <div class="history-layout">
    <section class="panel">
      <div class="history-filter"><div class="filter">⌕<input placeholder="Task, result, revision…" aria-label="Filter history"></div><div class="seg"><button class="active">All</button><button>Created</button><button>Skipped</button><button>Failed</button></div></div>
      <div style="overflow:auto"><table><thead><tr><th>Scheduled for</th><th>Outcome</th><th>Timing</th><th>Generated task</th><th>Result</th><th>Template</th></tr></thead><tbody>${rows.map((r, i) => `<tr class="${i === 1 ? "selected" : ""}" data-history-row><td class="mono">${r[0]}</td><td><span class="status-pill ${r[6]}">${r[1]}</span></td><td>${r[2]}</td><td><a class="receipt-link" href="#" data-toast="Would open the ordinary backlog task">${r[3]}</a></td><td>${r[4]}</td><td><span class="chip">${r[5]}</span></td></tr>`).join("")}</tbody></table></div>
    </section>
    <aside class="panel">
      <div class="panel-head"><div><h3>Jul 13 · catch-up run</h3><span class="tiny dim">occ_01K09… · immutable</span></div><span class="status-pill attention" style="margin-left:auto">2h 14m late</span></div>
      <div class="panel-body stack">
        <dl class="kv"><dt>Scheduled for</dt><dd>Jul 13 · 8:00 AM EDT</dd><dt>Claimed at</dt><dd>Jul 13 · 10:14:03 AM</dd><dt>Template</dt><dd>Revision 4</dd><dt>Result</dt><dd>Task MC-468 · no changes needed</dd><dt>Guarantee</dt><dd>Local catch-up</dd></dl>
        <div>${audits.map(([time,tone,title,copy]) => `<div class="audit" style="--tone:${tone}"><time>${time}</time><span class="track"><i></i></span><div><b>${title}</b><p>${copy}</p></div></div>`).join("")}</div>
        <div class="guarantee" style="--tone:var(--idle)"><span class="mark">✓</span><div><strong>No duplicate task</strong>A second scheduler tick found the occurrence key already claimed and performed no work.</div></div>
      </div>
    </aside>
  </div></main>`;
}

const renderers = { catalog, editor, preview, history };
app.innerHTML = renderers[screen]();

function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  window.setTimeout(() => el.remove(), 2600);
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-toast], [data-nav]");
  if (!target) return;
  if (target.dataset.toast) {
    event.preventDefault();
    toast(target.dataset.toast);
  }
  if (target.dataset.nav) {
    const destination = target.dataset.nav;
    window.location.href = destination === "catalog" ? "catalog.html" : `${destination}.html`;
  }
});

document.querySelectorAll("#availability-options input").forEach((input) => {
  input.addEventListener("change", () => {
    document.querySelectorAll("#availability-options .radio-card").forEach((card) => card.classList.remove("selected"));
    input.closest(".radio-card").classList.add("selected");
    document.querySelectorAll("#assurance-meter [data-mode]").forEach((item) => item.classList.toggle("active", item.dataset.mode === input.value));
    const label = input.value === "catchup" ? "Catch-up selected: durable, best-effort wall clock" : input.value === "os" ? "OS wake selected: capability check required before enabling" : "Always-on runner selected: trusted runner connection required";
    toast(label);
  });
});

const search = document.querySelector("#catalog-search");
const stateButtons = document.querySelectorAll("#state-filter button");
let stateFilter = "all";
function applyCatalogFilter() {
  const query = (search?.value || "").trim().toLowerCase();
  document.querySelectorAll("[data-schedule]").forEach((row) => {
    const schedule = schedules.find((s) => s.id === row.dataset.schedule);
    row.hidden = !schedule || (stateFilter !== "all" && schedule.state !== stateFilter) || !`${schedule.name} ${schedule.repo}`.toLowerCase().includes(query);
  });
}
search?.addEventListener("input", applyCatalogFilter);
stateButtons.forEach((button) => button.addEventListener("click", () => {
  stateFilter = button.dataset.state;
  stateButtons.forEach((item) => item.classList.toggle("active", item === button));
  applyCatalogFilter();
}));

document.querySelectorAll("[data-schedule]").forEach((row) => row.addEventListener("click", () => {
  const schedule = schedules.find((s) => s.id === row.dataset.schedule);
  if (!schedule) return;
  document.querySelectorAll("[data-schedule]").forEach((item) => item.classList.toggle("selected", item === row));
  const detail = document.querySelector("#selected-detail");
  if (detail) detail.innerHTML = selectedDetail(schedule);
}));
