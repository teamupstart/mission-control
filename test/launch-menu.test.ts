import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchList, SessionLaunchers } from "../src/web/components/LaunchMenu.tsx";
import type { TerminalTargetView } from "../src/shared/terminal.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// What is at stake: the two launchers are a FOLD over what the daemon reports for
// `TERMINAL_BACKEND_IDS`, so a fifth adapter is a file under `src/server/terminal/` and
// changes nothing here and nothing in the stylesheet. The way that breaks is a row learning
// a backend's name - a hard-coded entry, a `target.id === "…"` branch - after which the next
// adapter needs a component change and gets a different disabled-reason story than the first.
//
// The rest pins what a row has to SAY. An unavailable backend that will not explain itself
// is a greyed control with no fix attached: "not installed" and "installed, but nothing can
// raise its session" are different things for a human to do. And an empty list drawn for a
// dropped connection reads as "you have no terminals", which is a worse answer than the
// error it hides.

const view = (over: Partial<TerminalTargetView> = {}): TerminalTargetView => ({
  id: "tmux",
  label: "tmux",
  glyph: "▤",
  blurb: "A named session that survives its window closing.",
  detail: "new-session -c",
  unavailable: null,
  ...over,
});

const render = (targets: TerminalTargetView[] | null, failed = false): string =>
  renderToStaticMarkup(
    createElement(LaunchList, { targets, failed, verb: "Open a shell in", onChoose: () => {} }),
  );

test("an available backend names what it will run", () => {
  const html = render([view()]);
  assert.match(html, /tmux/);
  assert.match(html, /A named session that survives/);
  assert.match(html, /<em>new-session -c<\/em>/);
  assert.match(html, /role="menuitem"/);
  assert.doesNotMatch(html, /disabled/);
});

test("an unavailable backend is disabled and says why, in place of its blurb", () => {
  const html = render([
    view({ unavailable: "no emulator installed can raise its session", detail: null }),
  ]);
  assert.match(html, /disabled/);
  assert.match(html, /no emulator installed can raise its session/);
  assert.doesNotMatch(html, /A named session that survives/);
});

test("a failed fetch says so rather than rendering an empty menu", () => {
  const html = render(null, true);
  assert.match(html, /Could not ask the daemon/);
  assert.doesNotMatch(html, /menuitem/);
});

test("no answer yet and a build with no terminal at all read differently", () => {
  const checking = render(null);
  const empty = render([]);
  assert.match(checking, /Checking/);
  assert.match(empty, /no terminal it can open/);
  assert.notEqual(checking, empty);
});

test("every backend the daemon reports gets a row, in the order it reported them", () => {
  const html = render([
    view(),
    view({ id: "ghostty", label: "Ghostty", glyph: "◇", detail: "osascript" }),
  ]);
  assert.equal(html.match(/role="menuitem"/g)?.length, 2);
  assert.ok(html.indexOf("tmux") < html.indexOf("Ghostty"));
});

const source = (): string =>
  readFileSync(
    fileURLToPath(new URL("../src/web/components/LaunchMenu.tsx", import.meta.url)),
    "utf8",
  );

// What is at stake here is one keystroke doing two things. This menu is drawn over the
// conversation pane, so Escape has three claimants while it is up - the menu, any open
// overlay, and App's grid handler - and only the topmost may act, or dismissing the menu
// also collapses the card behind it. The menu wins by listening in the CAPTURE phase on
// `window` - ahead of the other two, which bubble - and by stopping IMMEDIATE propagation
// rather than plain propagation: the weaker call leaves correctness resting on the phase
// every other listener happened to choose, and the next capture-phase window listener would
// take Escape alongside the menu with nothing failing.
test("the menu takes Escape exclusively, ahead of the overlay and the grid", () => {
  const src = source();
  assert.match(src, /addEventListener\("keydown", onKey, true\)/, "capture phase, or it runs last");
  assert.match(
    src,
    /removeEventListener\("keydown", onKey, true\)/,
    "a capture listener must be removed as one",
  );
  assert.match(src, /stopImmediatePropagation\(\)/);
  assert.doesNotMatch(
    src,
    /event\.stopPropagation\(\)/,
    "the weaker call is what this test exists to prevent",
  );
  // Only while the menu is open: a closed menu that kept eating Escape would be worse than
  // one that shared it.
  assert.match(src, /if \(!open\) return;\s*function seize/);
});

test("the menu names no backend itself - rows come only from what the daemon reports", () => {
  const lowered = source().toLowerCase();
  for (const id of ["tmux", "cmux", "wezterm", "ghostty", "iterm", "kitty", "alacritty"]) {
    assert.ok(
      !lowered.includes(id),
      `${id} is named in the menu - a backend's identity belongs to its adapter`,
    );
  }
});

test("the focus control does not promise to raise a terminal window", () => {
  const src = source();
  assert.match(src, /Go to the terminal \$\{agentLabel\} is running in/);
  assert.doesNotMatch(src, /Raise the terminal \$\{agentLabel\}/);
});

test("the agent control is always plain, including blocked SDK and exited states", () => {
  const embedded = renderToStaticMarkup(
    createElement(SessionLaunchers, {
      session: mkSession({ runtime: "sdk", terminals: [], tty: null }),
    }),
  );
  const exited = renderToStaticMarkup(
    createElement(SessionLaunchers, { session: mkSession({ state: "exited" }) }),
  );
  const unboundSdk = renderToStaticMarkup(
    createElement(SessionLaunchers, {
      session: mkSession({
        runtime: "sdk",
        terminals: [],
        tty: null,
        agentSessionId: null,
      }),
    }),
  );

  assert.match(embedded, />Continue in terminal</);
  assert.equal(embedded.match(/aria-haspopup="menu"/g)?.length, 1);
  assert.equal(exited.match(/aria-haspopup="menu"/g)?.length, 1);
  assert.match(exited, /disabled/);
  assert.match(exited, /not running/);
  assert.equal(unboundSdk.match(/aria-haspopup="menu"/g)?.length, 1);
  assert.match(unboundSdk, />Continue in terminal</);
  assert.match(unboundSdk, /disabled/);
  assert.match(unboundSdk, /conversation id/);
});
