import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACTIONS, isReservedChord } from "../src/web/lib/keybindings.ts";

/**
 * The board's arrow cursor is a selection layer that opens nothing, and everything that
 * used to be reachable through "selecting is opening" has to survive that.
 *
 * Three things are at stake, and none of them fails loudly:
 *
 *  - `Enter` now means "open the tile the cursor is on", so it can no longer be handed
 *    out as a binding: it would work in Cards and Console and silently not on the board.
 *  - Only the board's DRILL-IN draws an action bar, so a chord aimed at a tile the arrows
 *    merely landed on has nothing registered to run. It has to drill in first, or `s`,
 *    `f`, `q`, Shift+Tab and `k` are dead keys on one layout of three.
 *  - Arrow selection has to take DOM focus with it. Nothing else moves focus, so whatever
 *    was last clicked keeps it - and Enter, which this app deliberately leaves to a
 *    focused control, would fire that instead of opening the board.
 *
 * Driven as source + the pure binding module rather than a click: no jsdom here, and the
 * flow is a global keydown handler reaching a ref through two renders.
 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${rel}`, import.meta.url)), "utf8");

const app = src("App.tsx");
const board = src("components/layouts/BoardView.tsx");
const tile = src("components/layouts/SessionTile.tsx");

test("Enter is reserved, because the board's Enter is structural navigation", () => {
  assert.equal(isReservedChord("Enter"), true);
  assert.equal(isReservedChord("shift+Enter"), true);
  for (const a of ACTIONS) {
    assert.notEqual(a.defaultBinding, "Enter", `${a.id} ships bound to a reserved key`);
  }
});

test("a modified Enter still reaches the chord matching it merely shares a key with", () => {
  // The switch keys off `e.key`, so cmd/alt/shift+Enter lands in the same arm. Claiming
  // it there returned before a single binding was compared, in every layout.
  const arm = app.slice(app.indexOf('case "Enter":'), app.indexOf("// Actions on the selected card."));
  assert.match(arm, /if \(chord !== "Enter"\) break;/, arm);
  // And the paths structural Enter does not apply to fall through rather than return.
  assert.match(arm, /if \(!selectedId\) break;/, arm);
  assert.match(arm, /layout === "board" && !boardOpen/, arm);
});

test("plain Enter on native controls wins over saved bindings", () => {
  const nativeEnter = app.indexOf(
    'if (chord === "Enter" && target?.closest("button, a[href]")) return;',
  );
  assert.notEqual(nativeEnter, -1);
  assert.ok(nativeEnter < app.indexOf("chord === bindings.roundup"));
  assert.ok(nativeEnter < app.indexOf("chord === bindings.dispatch"));
  assert.ok(nativeEnter < app.indexOf("chord === bindings.filter"));
});

test("every action-bar chord is one the board can defer, not just perform", () => {
  const table = app.slice(app.indexOf("const BAR_ACTIONS"), app.indexOf("export function App"));
  for (const [id, method] of [
    ["send", "startSend"],
    ["focus", "focusPane"],
    ["queue", "toggleQueue"],
    ["mode", "cycleMode"],
    ["kill", "requestKill"],
  ]) {
    assert.match(table, new RegExp(`\\["${id}", "${method}"\\]`), `${id} is not in BAR_ACTIONS`);
  }
  // The chain of `else if`s this replaced could only ever run against a bar that already
  // existed, which is exactly what the board's overview does not have.
  assert.doesNotMatch(app, /chord === bindings\.send/);
});

test("a selection chord on the board's overview drills in and then runs", () => {
  assert.match(app, /pendingBarAction\.current = \{ id: selectedId, run \};\s*\n\s*setBoardOpen\(true\);/, app.slice(app.indexOf("const bar = BAR_ACTIONS"), app.indexOf("window.addEventListener")));
  // Reconciled against what actually opened: a selection that moved in between must not
  // hand its neighbour a kill confirm.
  assert.match(app, /if \(!pending \|\| pending\.id !== boardOpenId\) return;/);
});

test("launcher chords focus directly or reveal Conversation for a chooser", () => {
  const table = app.slice(
    app.indexOf("const LAUNCHER_ACTIONS"),
    app.indexOf("function gearDotPhrase"),
  );
  assert.match(table, /\["terminal", "openTerminal"\]/);
  assert.match(table, /\["agent", "openAgent"\]/);
  const launcherBlock = app.slice(
    app.indexOf("const launcher = LAUNCHER_ACTIONS.find"),
    app.indexOf("const bar = BAR_ACTIONS.find"),
  );
  const mounted = launcherBlock.indexOf("launcherHandles.current.get(sel.id)");
  const focus = launcherBlock.indexOf('action === "focus"');
  const reveal = launcherBlock.indexOf("pendingLauncherAction.current");
  assert.notEqual(mounted, -1);
  assert.notEqual(focus, -1);
  assert.ok(mounted < focus, "a visible launcher must own focus feedback");
  assert.ok(focus < reveal);
  assert.match(launcherBlock.slice(focus, reveal), /api\.focus\(sel\.id\)/);
  assert.match(launcherBlock.slice(focus, reveal), /if \(!result\.ok\)/);
  assert.match(launcherBlock.slice(focus, reveal), /showLauncherFocusError/);
  assert.match(launcherBlock.slice(focus, reveal), /return;/);
  assert.match(
    launcherBlock,
    /pendingLauncherAction\.current = \{ id: sel\.id, run \};[\s\S]*?requestConversationTab\(sel\.id\)/,
  );
  assert.match(app, /handle\[pending\.run\]\(\)/);
  assert.match(app, /className="launch-flash is-error" role="status"/);
});

test("the board's drill-in is the selection, not a second id that can drift from it", () => {
  // A flag plus a derivation. Holding an id let another layout's arrows move the
  // selection out from under it, so returning to the board reopened the session you left.
  assert.match(app, /const \[boardOpen, setBoardOpen\] = useState\(false\)/);
  assert.match(app, /const boardOpenId = boardOpen \? selectedId : null;/);
  assert.doesNotMatch(app, /setBoardOpenId/);
});

test("the arrow cursor takes focus onto the tile's own open button", () => {
  assert.match(app, /pendingTileFocus\.current = nextId/);
  assert.match(app, /querySelector<HTMLElement>\("button\.tile-open"\)/);
  // That selector is the whole contract, and nothing compiles it. SessionTile draws the
  // stretched button precisely so the keyboard has something to land on.
  assert.match(tile, /<button[\s\S]*?className="tile-open"/, "the keyboard half of the tile is gone");
});

// Enter owns session detail. The rebindable Expand action owns the workflow disclosure
// inside the selected Board card and must never cross into that detail.

test("Enter opens session detail while Expand only toggles the Board workflow card", () => {
  // Enter: the switch's board arm sets the drill-in open.
  const enterArm = app.slice(app.indexOf('case "Enter":'), app.indexOf("// Actions on the selected card."));
  assert.match(enterArm, /layout === "board" && !boardOpen/);
  assert.match(enterArm, /setBoardOpen\(true\)/, "Enter no longer opens the board detail");
  assert.match(enterArm, /layout === "grid"/);
  assert.match(enterArm, /toggleExpand\(selectedId\)/, "Enter no longer toggles Cards focus mode");

  // Expand: only the selected Board overview tile's registered workflow disclosure runs.
  const expandBlock = app.slice(
    app.indexOf("if (chord === bindings.expand)"),
    app.indexOf('// "Show me this session\'s conversation"'),
  );
  assert.match(expandBlock, /layout !== "board" \|\| boardOpen \|\| !selectedId/);
  assert.match(expandBlock, /workflowDisclosureHandles\.current\.get\(selectedId\)/);
  assert.match(expandBlock, /disclosure\.toggle\(\)/);
  assert.doesNotMatch(expandBlock, /setBoardOpen/);
  assert.doesNotMatch(expandBlock, /toggleExpand/);

  // The handle reaches the same local state setter the pointer button receives.
  assert.match(board, /registerWorkflowDisclosure=\{props\.registerWorkflowDisclosure\}/);
  assert.match(tile, /registerWorkflowDisclosure\(session\.id, \{ toggle: toggleWorkflowExpanded \}\)/);
  assert.match(tile, /onExpandedChange: setWorkflowExpanded/);
});

test("the persisted expand action now describes the Board workflow disclosure", () => {
  const expand = ACTIONS.find((action) => action.id === "expand");
  assert.equal(expand?.defaultBinding, "e");
  assert.equal(expand?.label, "Toggle workflow details");
  assert.match(expand?.description ?? "", /without opening its session detail/);
});

test("Shift+Tab cycles the permission mode in place on the board, without opening the detail", () => {
  // The permission-mode cycle is a live control on the session's pane, not a reveal inside
  // the detail, so on the overview (no action bar) it runs against the API directly and
  // returns BEFORE the drill-in, instead of opening the detail for a keystroke that never
  // needed it - the reported bug.
  const noHandle = app.slice(
    app.indexOf("const overviewSel = visible.find"),
    app.indexOf("window.addEventListener"),
  );
  const cycleIdx = noHandle.indexOf('run === "cycleMode"');
  const drillIdx = noHandle.indexOf("pendingBarAction.current");
  assert.notEqual(cycleIdx, -1, "there is no in-place mode-cycle branch on the board overview");
  assert.ok(cycleIdx < drillIdx, "the mode-cycle branch must precede - and short-circuit - the drill-in");
  const cycleBranch = noHandle.slice(cycleIdx, drillIdx);
  assert.match(cycleBranch, /canCycleMode\(overviewSel\)/, "the in-place cycle is not gated by canCycleMode");
  assert.match(cycleBranch, /api\.cycleMode\(overviewSel\.id\)/, "Shift+Tab does not cycle the mode in place");
  assert.match(cycleBranch, /return;/, "the mode-cycle branch must return before drilling in");
  // `mode` stays a BAR_ACTION so the DRILLED-IN board (and grid/console) still cycle through
  // the real handle; only the overview takes the in-place path.
  assert.match(app, /\["mode", "cycleMode"\]/);
});
