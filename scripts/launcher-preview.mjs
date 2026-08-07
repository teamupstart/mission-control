/**
 * Render the conversation launchers against the REAL stylesheet, for eyeballing.
 *
 * The dashboard's SSE stream holds its connection open, which hangs headless screenshotting
 * of the live app - so this renders the actual components to static markup, drops them into
 * the two containers they really live in (`.detail-conv > .transcript` and
 * `.card.expanded .card-panels > .transcript`), and links `src/web/styles.css` unmodified.
 * That verifies exactly what a diff cannot: that the class names match rules, that the strip
 * does not eat the log's height, and that the popover anchors where it should.
 *
 * Not a test and not part of the build - `node --import tsx scripts/launcher-preview.mjs`
 * writes an HTML file and prints its path.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { SessionLaunchers, LaunchList } = await import("../src/web/components/LaunchMenu.tsx");

const CWD = "/Users/jordanmance/.treehouse/pool/wt-07";

const paned = {
  id: "s1",
  agent: "claude",
  runtime: "terminal",
  name: "durable-task-completion",
  cwd: CWD,
  agentSessionId: "8f3c1a42-6b90-4d17-a0e5-72c1ff3e8b44",
  terminals: [
    {
      kind: "multiplexer",
      backend: "tmux",
      session: "wt-07",
      sessionName: "wt-07",
      windowName: "claude",
      windowIndex: 0,
      paneId: "%3",
    },
  ],
};
const embedded = { ...paned, id: "s2", runtime: "sdk", terminals: [] };
const homeless = { ...embedded, id: "s3", cwd: null };

const TARGETS = [
  { id: "tmux", label: "tmux", glyph: "▤", blurb: "New session, raised in WezTerm.", detail: "new-session -c", unavailable: null },
  { id: "cmux", label: "cmux", glyph: "▥", blurb: "New workspace in the worktree.", detail: null, unavailable: "cmux is not installed" },
  { id: "wezterm", label: "WezTerm", glyph: "▣", blurb: "New window in the worktree.", detail: null, unavailable: null },
  { id: "ghostty", label: "Ghostty", glyph: "◫", blurb: "New window in the worktree.", detail: null, unavailable: null },
];

const strip = (session) => renderToStaticMarkup(h(SessionLaunchers, { session }));
const rows = (agent) =>
  renderToStaticMarkup(h(LaunchList, { targets: TARGETS, failed: false, verb: "Open a shell in", onChoose() {} }));

/** A transcript log with a couple of turns, so the strip is seen in proportion. */
const LOG = `
<div class="transcript-log">
  <div class="turn turn-user"><div class="turn-role">you</div>
    <div class="turn-text">Phase 1 is the archival re-add. Reproduce the dropped binding first.</div></div>
  <div class="turn turn-assistant"><div class="turn-role">claude</div>
    <div class="turn-text">Reproduced it. <code>invalidateTaskOwnershipInTransaction</code> deletes the
    binding without archiving first, so a merged PR that lands after a rollover has no evidence left.</div></div>
</div>
<div class="transcript-compose"><div class="compose-row">
  <textarea class="transcript-input" rows="2" placeholder="Reply to this session…"></textarea>
  <button class="btn btn-send">Send</button>
</div></div>`;

const panel = (session) =>
  `<div class="transcript" style="--agent-accent:#d97757">${strip(session)}${LOG}</div>`;

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../../src/web/styles.css">
<style>
  body{padding:20px;background:var(--bg);color:var(--fg);font:13px system-ui}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin:26px 0 8px}
  .frame{border:1px solid var(--border);border-radius:13px;background:var(--panel);overflow:hidden}
  .detail-conv{height:340px}
  .frame.card.expanded{height:340px}
  .popdemo{position:relative;height:340px;padding:14px}
</style></head><body>
<h2>Console detail - .detail-conv &gt; .transcript</h2>
<div class="frame"><div class="detail-conv">${panel(paned)}</div></div>

<h2>Expanded grid card - .card.expanded .card-panels &gt; .transcript</h2>
<div class="frame card expanded"><div class="card-panels">${panel(paned)}</div></div>

<h2>Embedded session (no pane) - the agent button gains its chooser</h2>
<div class="frame"><div class="detail-conv">${panel(embedded)}</div></div>

<h2>No checkout - both disabled, with the reason on hover</h2>
<div class="frame"><div class="detail-conv">${panel(homeless)}</div></div>

<h2>The chooser, open</h2>
<div class="frame popdemo" style="--agent-accent:#d97757">
  <div style="position:absolute;right:14px;top:14px"><div class="launch-pop">
    <span class="launch-head">Open a shell in the worktree with</span>${rows()}
  </div></div>
</div>
</body></html>`;

const out = fileURLToPath(new URL("../docs/archive/mockups/_launcher-preview.html", import.meta.url));
writeFileSync(out, page);
console.log(out);
