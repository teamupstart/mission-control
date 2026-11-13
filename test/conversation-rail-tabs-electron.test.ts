import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationActivity, type ActivityTab } from "../src/web/components/ConversationActivity.tsx";
import { SUBAGENT_LIMIT } from "../src/shared/subagents.ts";
import type { SubagentSummary, TranscriptMessage } from "../src/shared/types.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

/**
 * The conversation rail's head with a third tab, in both of the conversation's fonts.
 *
 * Chip and popover gives the rail an Agents tab beside Activity and Yours, in the same 244px
 * column that already holds the head's count and its fold. Three uppercase tabs are the
 * widest the head has ever been asked to hold, and the terminal rendering sets them in the
 * monospace face, which is wider again. If they do not fit, the fold is pushed out of the
 * column or the head wraps onto a second line - neither of which a markup assertion can see.
 *
 * The widest content each tab can carry is used: the Agents tab's "12+" when a full list may
 * have been cut short, and a three-digit Activity count, which the two-tab head prints and the
 * three-tab head gives up for the room (with it, the chat face overlapped the count by 12px).
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

const require = createRequire(import.meta.url);

/** Same backstop the other geometry tests use: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

/** The rail's column, from `.activity-rail` in the stylesheet. */
const RAIL_WIDTH = 244;

/** A full list of running agents, so the Agents tab prints its widest count, "12+". */
const FULL: SubagentSummary = {
  agents: Array.from({ length: SUBAGENT_LIMIT }, (_, i) => ({
    id: `agent-${i}`,
    type: "Explore",
    description: `Background agent ${i}`,
    state: "running",
    startedAt: 1_000,
    endedAt: null,
    toolUses: 18,
    tokens: 41_000,
    lastTool: "Grep",
    summary: null,
    launchTurnId: null,
  })),
  finishedFolded: 0,
};

/** Enough observed tool calls for a three-digit Activity count. */
const MESSAGES: TranscriptMessage[] = Array.from({ length: 60 }, (_, i) => ({
  id: `m${i}`,
  role: "assistant",
  text: "",
  tools: [
    { name: "Bash", input: `{"command":"ls /repo/${i}"}` },
    { name: "Read", input: `{"file_path":"/repo/src/${i}.ts"}` },
  ],
  ts: i,
}));

function rail(tab: ActivityTab, subagents: SubagentSummary | null): string {
  return renderToStaticMarkup(
    createElement(ConversationActivity, {
      messages: MESSAGES,
      open: true,
      onToggle: () => {},
      tab,
      onTab: () => {},
      selectedTurnId: null,
      onSelectTurn: () => {},
      collapsed: false,
      onCollapsed: () => {},
      subagents,
    }),
  );
}

const VIEWS = ["chat", "terminal"] as const;
const CASES = VIEWS.flatMap((view) => [
  { name: `${view}-two-tabs`, view, markup: rail("activity", null) },
  { name: `${view}-three-tabs-activity`, view, markup: rail("activity", FULL) },
  { name: `${view}-three-tabs-agents`, view, markup: rail("agents", FULL) },
]);

/** Each case in its own conversation pane, wide enough that the rail is a side column. */
function page(styles: string): string {
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style>
    <div style="display:flex;flex-direction:column;gap:24px;align-items:flex-start">${
      CASES.map(({ name, view, markup }) =>
        `<div data-case="${name}"><div class="transcript" data-view="${view}" style="width:900px;height:320px">` +
        `<div class="find-split" style="height:300px">${markup}</div></div></div>`).join("")
    }</div>`;
}

interface Measured {
  railWidth: number;
  headHeight: number;
  headOverflow: boolean;
  tabs: { name: string; top: number; height: number; right: number; clipped: boolean }[];
  tabsRight: number;
  endLeft: number;
  foldRight: number;
  foldVisible: boolean;
  innerRight: number;
  railRight: number;
}

let measured: Record<string, Measured>;

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = mkdtempSync(join(tmpdir(), "mission-rail-tabs-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-rail-tabs-profile-"));
  try {
    const htmlPath = join(dir, "rail.html");
    const styles = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
    writeFileSync(htmlPath, page(styles));
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/rail-tabs-browser.cjs", import.meta.url)),
      htmlPath,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

for (const { name } of CASES.filter((c) => c.name.includes("three-tabs"))) {
  test(`three rail tabs fit the 244px column on one line (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);
    assert.equal(m.railWidth, RAIL_WIDTH, "the rail kept its column width");
    assert.equal(m.tabs.length, 3, "the rail offers three tabs");
    // One line: every tab on the same row, and the head no taller than the two-tab head.
    const tops = new Set(m.tabs.map((t) => t.top));
    assert.equal(tops.size, 1, `the tabs wrapped onto ${tops.size} rows`);
    const two = measured[name.replace(/three-tabs-(activity|agents)/, "two-tabs")]!;
    assert.ok(m.headHeight <= two.headHeight, `the head grew from ${two.headHeight}px to ${m.headHeight}px`);
    // Nothing clipped, nothing pushed past the column: the tabs end before the count and the
    // fold begin, and the fold is still inside the head.
    for (const tab of m.tabs) assert.equal(tab.clipped, false, `"${tab.name}" is clipped`);
    assert.equal(m.headOverflow, false, "the head overflows the column");
    // Measured off the last tab, not the tab list: the list may shrink (`min-width: 0`) while
    // its unwrappable tabs spill past it and paint over the count.
    const lastTab = Math.max(m.tabsRight, ...m.tabs.map((t) => t.right));
    assert.ok(lastTab <= m.endLeft + 0.5, `the tabs run ${(lastTab - m.endLeft).toFixed(1)}px into the count and fold`);
    assert.equal(m.foldVisible, true, "the fold is not drawn");
    assert.ok(m.foldRight <= m.innerRight + 0.5, `the fold sits ${(m.foldRight - m.innerRight).toFixed(1)}px past the head's padding`);
    assert.ok(m.foldRight <= m.railRight, "the fold left the rail");
  });
}

test("the two-tab rail is unchanged: two tabs on one line with room to spare", () => {
  for (const view of VIEWS) {
    const m = measured[`${view}-two-tabs`]!;
    assert.equal(m.tabs.length, 2);
    assert.equal(new Set(m.tabs.map((t) => t.top)).size, 1);
    assert.ok(Math.max(...m.tabs.map((t) => t.right)) <= m.endLeft + 0.5);
  }
});
