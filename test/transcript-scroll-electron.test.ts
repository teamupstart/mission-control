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
import type { TranscriptMessage } from "../src/shared/types.ts";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { ConversationFindBar, ConversationFindRail } from "../src/web/components/ConversationFind.tsx";
import type { FindHit } from "../src/web/lib/find.ts";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * Whether you can scroll a conversation.
 *
 * Find-in-conversation gave the log a wrapper - `.find-split > .find-logwrap` - so that
 * the rail could sit beside it. The wrapper became the flex item the log's bounded
 * height had hung off, and a flex item's automatic minimum size is the height of its
 * content. So it refused to shrink to the pane, the log inherited an unbounded height,
 * and `overflow-y: auto` had nothing left to scroll: the conversation froze at its first
 * screenful and the reply box was pushed out of a pane that clips. Measured on the
 * shipped code, the log was 3230px tall inside a 600px pane, and the reply box sat
 * 2770px below the bottom of it.
 *
 * That is a geometry defect, and only laid-out geometry can catch it. Every part of the
 * chain here is the real thing - the panel's own markup, the real stylesheet, the two
 * height-bounded ancestors it mounts under - because the bug lived in the relationship
 * between them and not in any one of them. A markup assertion would have passed
 * throughout: the DOM was correct, its used heights were not.
 *
 * Four cases, because the wrapper is load-bearing in two directions: find CLOSED (the
 * split collapses to `display: contents` and the wrapper is the flex item) and find OPEN
 * (the split is a real flex row), each in the Console detail and in an expanded card.
 */

const require = createRequire(import.meta.url);

/** Same backstop the workflow geometry test uses: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

/** A conversation comfortably taller than any pane it is measured in. */
const TURNS = 40;

interface Measured {
  boxHeight: number;
  logHeight: number;
  contentHeight: number;
  scrolledTo: number;
  composeBottomOverflow: number;
  composeHeight: number;
  railBottomOverflow: number | null;
  railHeight: number | null;
}

function hit(i: number): FindHit {
  return {
    key: `k${i}`,
    rowId: `m${i}`,
    toolIndex: null,
    start: 0,
    end: 4,
    scope: "user",
    who: "you",
    pre: "…before ",
    hit: "pane",
    post: " after…",
  };
}

/** The panel's real markup, hydrated with a real conversation through the history map. */
function panelMarkup(): string {
  resetHistories();
  const messages: TranscriptMessage[] = Array.from({ length: TURNS }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `turn ${i} - a line of conversation long enough to wrap inside the pane, so the log is taller than any box it is measured in.`,
    tools: [],
    ts: i,
  }));
  seedTail("s1", { messages, start: 0, atStart: true, pos: 1000 });
  return renderToStaticMarkup(
    createElement(TranscriptPanel, {
      session: mkSession({
        id: "s1",
        pendingTurns: [
          {
            id: "pending-editable",
            noteKey: "agent-1",
            seq: 0,
            text: "A queued follow-up remains visible and editable below the live conversation.",
            state: "queued",
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
            claimedAt: null,
            lastError: null,
          },
          {
            id: "pending-uncertain",
            noteKey: "agent-1",
            seq: 1,
            text: "A terminal message whose pickup could not be confirmed.",
            state: "uncertain",
            revision: 2,
            createdAt: 2,
            updatedAt: 3,
            claimedAt: 2,
            lastError: "Mission Control could not confirm terminal pickup.",
          },
        ],
      }),
      canSend: true,
    }),
  );
}

/** The find surfaces' real markup, for the fixture to mount into an opened split. */
function findMarkup(): { bar: string; rail: string } {
  const hits = Array.from({ length: 30 }, (_, i) => hit(i));
  return {
    bar: renderToStaticMarkup(
      createElement(ConversationFindBar, {
        query: "pane",
        onQuery: () => {},
        caseSensitive: false,
        onCaseSensitive: () => {},
        hits,
        index: 0,
        onStep: () => {},
        onClose: () => {},
      }),
    ),
    rail: renderToStaticMarkup(
      createElement(ConversationFindRail, {
        query: "pane",
        scope: "all",
        onScope: () => {},
        hits,
        index: 0,
        onJump: () => {},
        loadedOnly: false,
        onLoadOlder: () => {},
      }),
    ),
  };
}

/**
 * The two hosts that give the conversation a bounded height, as they nest in the app:
 * the Console detail's pane (`ConsoleDetail`) and an expanded card's panel row
 * (`SessionCard`). Their heights are the app's own - a detail pane fills the window, an
 * expanded card is the fixed-height box `.card.expanded` describes.
 */
function page(panel: string, styles: string): string {
  const cases = [
    ["detail-closed", `<div class="detail-body" style="height:600px;width:640px"><div class="detail-conv">${panel}</div></div>`],
    ["detail-open", `<div class="detail-body" style="height:600px;width:640px"><div class="detail-conv">${panel}</div></div>`],
    ["card-closed", `<div class="card expanded" style="height:636px;width:900px"><div class="card-panels">${panel}</div></div>`],
    ["card-open", `<div class="card expanded" style="height:636px;width:900px"><div class="card-panels">${panel}</div></div>`],
  ];
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style>
    <script type="application/json" id="find-markup">${JSON.stringify(findMarkup())}</script>
    <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start">${
      cases.map(([name, host]) => `<div data-case="${name}">${host}</div>`).join("")
    }</div>`;
}

let measured: Record<string, Measured>;

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = mkdtempSync(join(tmpdir(), "mission-transcript-scroll-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-transcript-scroll-profile-"));
  try {
    const htmlPath = join(dir, "transcript.html");
    const styles = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
    writeFileSync(htmlPath, page(panelMarkup(), styles));
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/transcript-scroll-browser.cjs", import.meta.url)),
      htmlPath,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

for (const name of ["detail-closed", "detail-open", "card-closed", "card-open"]) {
  test(`the conversation log scrolls inside its pane (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);

    // The log yields to the pane instead of growing to its content. This is the
    // assertion the shipped defect failed, and it fails LOUDLY: the log was more than
    // five times the height of the pane holding it.
    assert.ok(
      m.logHeight < m.boxHeight,
      `log must fit its pane, got ${m.logHeight}px inside ${m.boxHeight}px`,
    );
    // The conversation is genuinely longer than the view, so there is something to
    // scroll - without this the check above would pass on an empty log.
    assert.ok(
      m.contentHeight > m.logHeight,
      `fixture must overflow the log, got ${m.contentHeight}px of content in ${m.logHeight}px`,
    );
    // And it scrolls. Asked for the bottom, a clipped log answers 0.
    assert.ok(m.scrolledTo > 0, "log must scroll when asked to");

    // The reply box is the other half of the same failure: with the log unbounded it was
    // pushed below a pane that clips, so the session could be neither read nor answered.
    assert.ok(m.composeHeight > 0, "reply box must be rendered");
    assert.ok(
      m.composeBottomOverflow <= 1,
      `reply box must stay inside the pane, got ${m.composeBottomOverflow}px past its bottom`,
    );
  });
}

for (const name of ["detail-open", "card-open"]) {
  test(`an open find keeps its rail inside the pane (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);
    // The rail is visible exactly when find is open - the feature's stated invariant -
    // which means it has to fit as well as exist. Sized to its content it would hang out
    // of the same clipping pane the log did.
    assert.ok((m.railHeight ?? 0) > 0, "an open find renders its rail");
    assert.ok(
      (m.railBottomOverflow ?? 0) <= 1,
      `rail must stay inside the pane, got ${m.railBottomOverflow}px past its bottom`,
    );
  });
}
