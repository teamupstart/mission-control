/*
 * One fixture, four placements.
 *
 * Every option below renders the SAME session, the SAME two controls and the SAME popover
 * rows - only where the controls sit changes. The menu contents are not invented: the
 * terminal rows are the four backends the registry actually holds today
 * (MULTIPLEXER_IDS = tmux, cmux; EMULATOR_IDS = wezterm, ghostty), and the unavailable
 * rows carry a SENTENCE rather than being hidden, which is the rule OPEN_TARGETS already
 * follows - "not installed" and "no adapter in this build" are different fixes.
 *
 * The layout switcher matters as much as the placement: the request is that this appears
 * on the conversation pane in EVERY layout, and a session is drawn by four components, of
 * which only two ever show a conversation (SessionCard when expanded, ConsoleDetail for
 * Console and the Board drill-in). Flip between them to see whether a placement survives
 * both.
 */

const OPTION = document.body.dataset.option;

const OPTIONS = {
  a: { n: "01", name: "Conversation toolbar", file: "a-toolbar.html" },
  b: { n: "02", name: "Footer action row", file: "b-footer.html" },
  c: { n: "03", name: "Path row", file: "c-path.html" },
  d: { n: "04", name: "Remembered default", file: "d-default.html" },
};

const SESSION = {
  name: "durable-task-completion",
  agent: "claude",
  agentLabel: "Claude Code",
  accent: "#d97757",
  nameSource: "tmux",
  state: "working",
  cwd: "/Users/jordanmance/.treehouse/pool/wt-07",
  cwdShort: "~/.treehouse/pool/wt-07",
  branch: "mancej/durable-task-completion",
  pid: 48122,
  model: "sonnet 4.6",
  agentSessionId: "8f3c1a42-6b90-4d17-a0e5-72c1ff3e8b44",
  goal: "Re-add work-episode archival so a merged PR still settles its task after rollover",
};

/* The terminal backends, in registry order: multiplexers rank above emulators, which is
   the same order homeBackends() walks when it picks the axis for a dispatched agent. */
const BACKENDS = [
  {
    id: "wezterm",
    label: "WezTerm",
    glyph: "▣",
    detail: "cli spawn --cwd",
    blurb: "New tab in the worktree.",
    unavailable: null,
  },
  {
    id: "ghostty",
    label: "Ghostty",
    glyph: "◫",
    detail: "new window",
    blurb: "New window in the worktree.",
    unavailable: null,
  },
  {
    id: "tmux",
    label: "tmux",
    glyph: "▤",
    detail: "new-session -c",
    blurb: "New session, raised in WezTerm.",
    unavailable: null,
  },
  {
    id: "cmux",
    label: "cmux",
    glyph: "▥",
    detail: null,
    blurb: "New workspace in the worktree.",
    unavailable: "cmux is not installed.",
  },
  {
    id: "iterm2",
    label: "iTerm2",
    glyph: "▦",
    detail: null,
    blurb: "New window in the worktree.",
    unavailable: "no adapter in this build yet.",
  },
];

/* ?open=terminal|agent and ?view=card let a still capture land on a given state - the
   headless renders in docs/ are taken this way rather than by hand-driving the page. */
const params = new URLSearchParams(location.search);

let openMenu = params.get("open") || null; // "terminal" | "agent" | null
let flash = null; // { text, error }
let view = params.get("view") === "card" ? "card" : "console";
let lastTerminal = "wezterm"; // option D only: the remembered defaults
let lastAgent = "ghostty";

/* ------------------------------------------------------------------ popover rows --- */

function rows(kind) {
  return BACKENDS.map((b) => {
    const remembered = OPTION === "d" && b.id === (kind === "agent" ? lastAgent : lastTerminal);
    const note = b.unavailable ?? b.blurb;
    return `
      <button class="launch-row" ${b.unavailable ? "disabled" : ""}
              onclick="choose('${kind}','${b.id}')" role="menuitem"
              title="${b.unavailable ?? `Open ${kind === "agent" ? SESSION.agentLabel : "a shell"} in ${b.label}`}">
        <span class="launch-glyph" aria-hidden="true">${b.glyph}</span>
        <span class="launch-text">
          <span class="launch-label">${b.label}${b.detail ? `<em>${b.detail}</em>` : ""}</span>
          <span class="launch-note">${note}</span>
        </span>
        ${remembered ? `<span class="launch-default" title="last used">●</span>` : ""}
      </button>`;
  }).join("");
}

function pop(kind, { up = false, left = false } = {}) {
  const head =
    kind === "agent"
      ? `${SESSION.agentLabel} · resume this conversation in`
      : "Open a shell in the worktree with";
  return `
    <div class="launch-pop${up ? " up" : ""}${left ? " left" : ""}${kind === "agent" ? " launch-agent-pop" : ""}"
         role="menu" aria-label="${head}">
      <span class="head">${head}</span>
      ${rows(kind)}
    </div>`;
}

/* --------------------------------------------------------------------- controls --- */

/* Option A / B / C: a plain button that opens the chooser. */
function launcher(kind, { klass = "launch-btn", up = false } = {}) {
  const isAgent = kind === "agent";
  const open = openMenu === kind;
  const label = isAgent ? SESSION.agentLabel : "Terminal";
  const glyph = isAgent ? "◆" : "❯_";
  return `
    <span class="launch">
      <button class="${klass}${isAgent ? " launch-agent" : ""}" aria-haspopup="menu"
              aria-expanded="${open}" onclick="toggle('${kind}')"
              title="${isAgent ? `Open ${SESSION.agentLabel} on this conversation, in a terminal` : "Open a terminal in this session's worktree"}">
        <span class="glyph" aria-hidden="true">${glyph}</span>${label}<span class="launch-caret" aria-hidden="true">▾</span>
      </button>
      ${open ? pop(kind, { up }) : ""}
    </span>`;
}

/* Option C: the same control shrunk to a glyph, riding the path it acts on. */
function iconLauncher(kind) {
  const isAgent = kind === "agent";
  const open = openMenu === kind;
  return `
    <span class="launch">
      <button class="icon-launch${isAgent ? " is-agent" : ""}" aria-haspopup="menu"
              aria-expanded="${open}" onclick="toggle('${kind}')"
              title="${isAgent ? `Open ${SESSION.agentLabel} on this conversation here` : "Open a terminal here"}">
        ${isAgent ? "◆" : "❯_"}
      </button>
      ${open ? pop(kind, { left: true }) : ""}
    </span>`;
}

/* Option D: click launches the remembered backend, the caret re-opens the chooser. */
function splitLauncher(kind) {
  const isAgent = kind === "agent";
  const open = openMenu === kind;
  const rememberedId = isAgent ? lastAgent : lastTerminal;
  const backend = BACKENDS.find((b) => b.id === rememberedId);
  const label = isAgent ? SESSION.agentLabel : "Terminal";
  return `
    <span class="launch">
      <span class="launch-split${isAgent ? " launch-agent-split" : ""}${open ? " is-open" : ""}">
        <button class="go" onclick="choose('${kind}','${rememberedId}')"
                title="${isAgent ? `Open ${SESSION.agentLabel} on this conversation in ${backend.label}` : `Open a terminal in ${backend.label}`}">
          <span class="glyph" aria-hidden="true">${isAgent ? "◆" : "❯_"}</span>${label}<span class="last">${backend.label}</span>
        </button>
        <button class="pick" aria-haspopup="menu" aria-expanded="${open}"
                onclick="toggle('${kind}')" title="Choose a different terminal">▾</button>
      </span>
      ${open ? pop(kind) : ""}
    </span>`;
}

function pair(mode) {
  const make = mode === "icon" ? iconLauncher : mode === "split" ? splitLauncher : launcher;
  const opts = mode === "foot" ? { klass: "act", up: true } : mode === "card" ? { klass: "btn" } : {};
  const build = (k) => (mode === "icon" || mode === "split" ? make(k) : make(k, opts));
  return build("terminal") + build("agent");
}

function flashChip() {
  if (!flash) return "";
  return `<span class="launch-flash${flash.error ? " is-error" : ""}">${flash.text}</span>`;
}

/* ---------------------------------------------------------------- the two views --- */

function toolbar() {
  return `
    <div class="conv-toolbar">
      <span class="where">
        <span class="lbl">worktree</span>
        <span class="path" dir="ltr" title="${SESSION.cwd}">${SESSION.cwdShort}</span>
      </span>
      <span class="sp"></span>
      ${flashChip()}
      ${pair(OPTION === "d" ? "split" : "plain")}
    </div>`;
}

function transcript(withToolbar) {
  return `
    <div class="transcript">
      ${withToolbar ? toolbar() : ""}
      <div class="transcript-log">
        <div class="turn turn-user">
          <div class="turn-role">you</div>
          <div class="turn-text">Phase 1 is the archival re-add. Start by reproducing the dropped
            binding end to end, then write the migration.</div>
        </div>
        <div class="turn turn-assistant">
          <div class="turn-role">claude</div>
          <div class="turn-text">Reproduced it. <code>invalidateTaskOwnershipInTransaction</code>
            deletes the binding without archiving first, so a merged PR that lands after a
            rollover has no evidence left to settle against. Adding the archival write inside the
            same transaction.</div>
          <div class="turn-tools">
            <span class="tool-chip">Read db.ts</span>
            <span class="tool-chip">Edit db.ts</span>
            <span class="tool-chip">Bash npm test</span>
          </div>
        </div>
        <div class="turn turn-assistant">
          <div class="turn-role">claude</div>
          <div class="turn-text">All 41 task tests pass. Writing
            <code>task-durable-merge.test.ts</code> to pin that a rollover keeps the merge
            evidence.</div>
        </div>
      </div>
      <div class="transcript-compose">
        <textarea class="transcript-input" rows="2" placeholder="Reply to this session…"></textarea>
        <button class="btn" style="color:var(--working)">Send</button>
      </div>
    </div>`;
}

function consoleDetail() {
  const inFoot = OPTION === "b";
  const onPath = OPTION === "c";
  const inToolbar = OPTION === "a" || OPTION === "d";
  return `
    <div class="cdetail" style="--agent-accent:${SESSION.accent}">
      <header class="detail-head">
        <span class="agent-dot"></span>
        <h2>${SESSION.name}</h2>
        <span class="name-source">${SESSION.nameSource}</span>
        <span class="badge">working</span>
        <span class="spacer"></span>
        <span class="runtime-pill">${SESSION.model} · 42% context</span>
      </header>

      <dl class="detail-sub">
        <span class="kv"><dt>path</dt><dd title="${SESSION.cwd}">${SESSION.cwdShort}</dd>
          ${onPath ? `<span class="path-launch">${pair("icon")}</span>` : ""}
        </span>
        <span class="kv"><dt>branch</dt><dd class="branch">${SESSION.branch}</dd></span>
        ${onPath ? `<span class="spacer"></span>${flashChip()}` : ""}
      </dl>

      <div class="detail-tabs" role="tablist">
        <button class="detail-tab on">Conversation</button>
        <button class="detail-tab">Work queue<span class="detail-pip">2</span></button>
        <button class="detail-tab">Gate</button>
        <button class="detail-tab">Diff</button>
        <button class="detail-tab">Files</button>
      </div>

      <div class="detail-body">
        <div class="detail-conv">
          <p class="goal"><b>goal</b>${SESSION.goal}</p>
          <p class="activity">editing src/server/db.ts · 4s ago</p>
          ${transcript(inToolbar)}
        </div>
      </div>

      <footer class="detail-foot">
        <span>${SESSION.agentLabel}</span>
        <span>·</span>
        <span class="mono">pid ${SESSION.pid}</span>
        <span class="spacer"></span>
        ${inFoot ? flashChip() : ""}
        <div class="actions" style="border:0;padding:0;margin:0">
          ${inFoot ? pair("foot") : ""}
          <button class="act act-focus"><kbd>f</kbd>focus</button>
          <button class="act"><kbd>d</kbd>diff</button>
          <button class="act"><kbd>^r</kbd>reset</button>
          <button class="act act-danger"><kbd>k</kbd>kill</button>
        </div>
      </footer>
    </div>`;
}

function card() {
  const inFoot = OPTION === "b";
  const onPath = OPTION === "c";
  const inToolbar = OPTION === "a" || OPTION === "d";
  return `
    <div class="card" style="--agent-accent:${SESSION.accent}">
      <div class="card-head">
        <span class="agent-dot"></span>
        <h3>${SESSION.name}</h3>
        <span class="name-source">${SESSION.nameSource}</span>
        <span class="spacer"></span>
        <span class="badge">working</span>
      </div>
      <p class="goal"><b>goal</b>${SESSION.goal}</p>
      <div class="card-meta">
        <span class="mono" title="${SESSION.cwd}">${SESSION.cwdShort}</span>
        ${onPath ? `<span class="path-launch">${pair("icon")}</span>` : ""}
        <span style="color:var(--idle)">${SESSION.branch}</span>
        <span class="mono">pid ${SESSION.pid}</span>
        ${onPath ? `<span class="spacer"></span>${flashChip()}` : ""}
      </div>
      <p class="activity">editing src/server/db.ts · 4s ago</p>

      <div class="actions">
        ${inFoot ? pair("card") + flashChip() : ""}
        <button class="btn">Focus</button>
        <button class="btn">Files</button>
        <button class="btn">Queue</button>
        <button class="btn">Reset</button>
        <span class="actions-spacer"></span>
        <button class="btn btn-danger-ghost">Kill</button>
      </div>

      <div class="card-panels">${transcript(inToolbar)}</div>
    </div>`;
}

/* ------------------------------------------------------------------- page chrome --- */

function mockbar() {
  const me = OPTIONS[OPTION];
  const links = Object.entries(OPTIONS)
    .map(([k, o]) => `<a class="${k === OPTION ? "on" : ""}" href="${o.file}">${o.n} ${o.name}</a>`)
    .join("");
  return `
    <div class="mockbar">
      <b>Option ${me.n} · ${me.name}</b>
      <span class="sp"></span>
      <span class="opts">${links}</span>
      <a href="index.html">← all options</a>
    </div>`;
}

function layoutSwitch() {
  return `
    <div class="layout-switch">
      <span>Same control, drawn by:</span>
      <span class="seg">
        <button class="${view === "console" ? "on" : ""}" onclick="setView('console')">Console detail</button>
        <button class="${view === "card" ? "on" : ""}" onclick="setView('card')">Grid card (expanded)</button>
      </span>
      <span class="why">${
        view === "console"
          ? "ConsoleDetail.tsx - also what the Board drills into."
          : "SessionCard.tsx - the only other renderer that shows a conversation."
      }</span>
    </div>`;
}

function render() {
  document.getElementById("app").innerHTML =
    mockbar() +
    document.getElementById("note").innerHTML +
    layoutSwitch() +
    `<div class="stage">${view === "console" ? consoleDetail() : card()}</div>`;
}

/* ---------------------------------------------------------------- interactions --- */

window.toggle = (kind) => {
  openMenu = openMenu === kind ? null : kind;
  flash = null;
  render();
};

window.choose = (kind, backendId) => {
  const b = BACKENDS.find((x) => x.id === backendId);
  openMenu = null;
  if (b.unavailable) {
    flash = { text: b.unavailable, error: true };
  } else {
    if (OPTION === "d") {
      if (kind === "agent") lastAgent = backendId;
      else lastTerminal = backendId;
    }
    flash =
      kind === "agent"
        ? { text: `${b.label} ← claude --resume ${SESSION.agentSessionId.slice(0, 8)}…`, error: false }
        : { text: `${b.label} ← ${SESSION.cwdShort}`, error: false };
  }
  render();
};

window.setView = (v) => {
  view = v;
  openMenu = null;
  flash = null;
  render();
};

document.addEventListener("pointerdown", (e) => {
  if (openMenu && !e.target.closest(".launch")) {
    openMenu = null;
    render();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    openMenu = null;
    render();
  }
});

render();
