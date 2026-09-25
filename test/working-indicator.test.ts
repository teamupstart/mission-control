import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, TranscriptMessage } from "../src/shared/types.ts";
import type { ConversationView } from "../src/shared/protocol.ts";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * The conversation's working indicator: the clock every working row carries, and the two
 * marks an operator can add to it from Display > Working indicator.
 *
 * What is pinned here:
 *
 * - The clock is part of the base row, not an option, and it counts from the prompt that
 *   started the turn - never from the epoch, and never from a guess when that prompt is
 *   not loaded.
 * - Both added marks ship OFF, so with nothing checked the conversation draws what it
 *   drew before they existed.
 * - Both are gated on the row's own gate, so neither can say "working" about a session
 *   the row has already stopped describing.
 *
 * A fake `localStorage` and an accepting fetch go in BEFORE the modules load, for the
 * reason `board-card-items.test.ts` gives: `uiConfig.ts` seeds itself at import, and an
 * update the daemon refuses is rolled back.
 */

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
});

const { currentTurnStartedAt } = await import("../src/web/lib/working-indicator.ts");
const { TranscriptPanel } = await import("../src/web/components/TranscriptPanel.tsx");
const { BoardCardPanel } = await import("../src/web/components/BoardCardPanel.tsx");
const { InProgressRow } = await import("../src/web/components/InProgressRow.tsx");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { resetSessionViews, writeSessionView } = await import(
  "../src/web/lib/conversation-view.ts"
);
const { resetHistories, seedTail } = await import("../src/web/lib/transcript-history.ts");
const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");

const WORKING_IDS = ["workingPinned", "workingProgressBar"] as const;

function msg(id: string, role: "user" | "assistant", ts: number): TranscriptMessage {
  return { id, role, text: `${role} ${id}`, tools: [], ts };
}

/** Everything the default profile hides, minus the ids named: the operator checked those. */
function hiddenExcept(...checked: string[]): string[] {
  return UI_CONFIG_DEFAULTS.hiddenDisplayItems.filter((id) => !checked.includes(id));
}

async function withHidden<T>(hidden: readonly string[], run: () => T): Promise<T> {
  await updateUiConfig({ hiddenDisplayItems: [...hidden] });
  try {
    return run();
  } finally {
    await updateUiConfig({ hiddenDisplayItems: [...UI_CONFIG_DEFAULTS.hiddenDisplayItems] });
  }
}

/** The real panel, hydrated with a real conversation through the history map. */
function renderPanel(
  over: Partial<Session> = {},
  messages: TranscriptMessage[] = [msg("m0", "user", Date.now() - 134_000), msg("m1", "assistant", Date.now() - 120_000)],
  view: ConversationView = "chat",
): string {
  resetHistories();
  seedTail("s1", { messages, start: 0, atStart: true, pos: 1000 });
  writeSessionView("s1", view);
  try {
    return renderToStaticMarkup(
      createElement(TranscriptPanel, {
        session: mkSession({ id: "s1", state: "working", activity: "running Bash", ...over }),
        canSend: true,
      }),
    );
  } finally {
    resetSessionViews();
  }
}

/** The `<p>` that opens the in-progress row, or null. */
function rowTag(html: string): string | null {
  return /<p class="turn-progress[^"]*"/.exec(html)?.[0] ?? null;
}

/** The reply box's opening tag. */
function replyBox(html: string): string {
  const tag = /<textarea[^>]*class="transcript-input[^"]*"[^>]*>/.exec(html)?.[0];
  assert.ok(tag, "the panel should render its reply box");
  return tag;
}

test("the current turn starts at the newest prompt in the loaded conversation", () => {
  assert.equal(
    currentTurnStartedAt([msg("a", "user", 10), msg("b", "assistant", 20), msg("c", "user", 30), msg("d", "assistant", 40)]),
    30,
  );
  // An assistant-only page - a turn long enough to push its own prompt out of what is
  // loaded - has no honest answer, and the first loaded message would undercount it.
  assert.equal(currentTurnStartedAt([msg("a", "assistant", 10), msg("b", "assistant", 20)]), null);
  assert.equal(currentTurnStartedAt([]), null);
  // A record with no timestamp normalizes to 0, and a clock from the epoch is not a clock.
  assert.equal(currentTurnStartedAt([msg("a", "user", 0), msg("b", "assistant", 20)]), null);
});

test("the row carries how long the current turn has run, with nothing checked", async () => {
  const html = await withHidden(UI_CONFIG_DEFAULTS.hiddenDisplayItems, () => renderPanel());
  // 2m 14s ago when the fixture was built; a slow runner may have crossed one more second.
  assert.match(html, /class="turn-progress-clock">2m 1[45]s</);
  // After the activity it describes, so the words read first and clip against the clock.
  assert.ok(html.indexOf("turn-progress-text") < html.indexOf("turn-progress-clock"));
});

test("no clock is drawn when the turn's prompt is not loaded", () => {
  const html = renderPanel({}, [msg("m1", "assistant", Date.now() - 5_000)]);
  assert.ok(rowTag(html), "the row itself still renders");
  assert.doesNotMatch(html, /turn-progress-clock/);
});

test("with nothing checked, the row is not pinned and the reply box has no bar", async () => {
  const html = await withHidden(UI_CONFIG_DEFAULTS.hiddenDisplayItems, () => renderPanel());
  assert.equal(rowTag(html), '<p class="turn-progress"');
  assert.doesNotMatch(replyBox(html), /has-progress-bar/);
});

test("both working marks ship off, for fresh and upgraded profiles alike", () => {
  for (const id of WORKING_IDS) {
    assert.ok(
      UI_CONFIG_DEFAULTS.hiddenDisplayItems.includes(id),
      `"${id}" should ship unchecked`,
    );
  }
});

test("checking Pin the working row pins the row, and only the row", async () => {
  const html = await withHidden(hiddenExcept("workingPinned"), () => renderPanel());
  assert.equal(rowTag(html), '<p class="turn-progress is-pinned"');
  assert.doesNotMatch(replyBox(html), /has-progress-bar/);
  // The terminal drawing keeps its stream entry as well as the pin.
  const terminal = await withHidden(hiddenExcept("workingPinned"), () =>
    renderPanel({}, undefined, "terminal"),
  );
  assert.equal(rowTag(terminal), '<p class="turn-progress pty-entry is-pinned"');
});

test("checking Reply box progress bar marks the reply box, and only the reply box", async () => {
  const html = await withHidden(hiddenExcept("workingProgressBar"), () => renderPanel());
  assert.match(replyBox(html), /class="transcript-input has-progress-bar"/);
  assert.equal(rowTag(html), '<p class="turn-progress"');
});

test("neither mark says working once the row has stopped saying it", async () => {
  // The row's gate is `liveActivity`: a settled session keeps an `activity` word, and a
  // lapsed push channel keeps a stale one. The marks ask the same question, so a bar cannot
  // sweep under a session the row has already gone quiet about.
  const both = hiddenExcept(...WORKING_IDS);
  for (const over of [{ state: "idle" as const, activity: "idle" }, { instrumented: false }, { activity: null }]) {
    const html = await withHidden(both, () => renderPanel(over));
    assert.equal(rowTag(html), null);
    assert.doesNotMatch(replyBox(html), /has-progress-bar/, JSON.stringify(over));
  }
});

test("a frozen row does not tick, which is what the Display preview relies on", () => {
  const html = renderToStaticMarkup(
    createElement(InProgressRow, {
      agentLabel: "claude",
      activity: "running Bash",
      terminal: false,
      startedAt: 1_000,
      now: 1_000 + 3_725_000,
    }),
  );
  assert.match(html, /class="turn-progress-clock">1h 02m</);
});

/** The working customizer's preview stage, cut out of the whole panel's markup. */
async function workingPreview(hidden: readonly string[]): Promise<string> {
  const html = await withHidden(hidden, () => renderToStaticMarkup(createElement(BoardCardPanel)));
  const at = html.indexOf('<div class="working-preview"');
  assert.ok(at >= 0, "the Display panel should mount the working indicator preview");
  return html.slice(at);
}

test("the Display panel lists both marks under their own heading, unchecked", async () => {
  const html = await withHidden(UI_CONFIG_DEFAULTS.hiddenDisplayItems, () =>
    renderToStaticMarkup(createElement(BoardCardPanel)),
  );
  assert.ok(html.includes("Working indicator"), "the section should name itself");
  for (const label of ["Pin the working row", "Reply box progress bar"]) {
    const box = new RegExp(`<input type="checkbox" aria-label="${label}"[^>]*>`).exec(html)?.[0];
    assert.ok(box, `the panel should offer "${label}"`);
    assert.doesNotMatch(box, /checked/, `"${label}" should ship unchecked`);
  }
});

test("the preview shows the clock with nothing checked, and moves with each box", async () => {
  const none = await workingPreview(UI_CONFIG_DEFAULTS.hiddenDisplayItems);
  // The base experience, visible before anything is checked.
  assert.match(none, /class="turn-progress-clock">2m 14s</);
  assert.doesNotMatch(none, /is-pinned/);
  assert.doesNotMatch(none, /has-progress-bar/);

  const pinned = await workingPreview(hiddenExcept("workingPinned"));
  assert.match(pinned, /class="turn-progress is-pinned"/);
  assert.doesNotMatch(pinned, /has-progress-bar/);

  const bar = await workingPreview(hiddenExcept("workingProgressBar"));
  assert.match(bar, /class="transcript-input has-progress-bar"/);
  assert.doesNotMatch(bar, /is-pinned/);
});

test("the preview mounts the real row and is unreachable", async () => {
  const html = await withHidden(UI_CONFIG_DEFAULTS.hiddenDisplayItems, () =>
    renderToStaticMarkup(createElement(BoardCardPanel)),
  );
  const stage = html.lastIndexOf('<div class="board-card-preview-stage" inert="');
  assert.ok(stage >= 0 && stage < html.indexOf('<div class="working-preview"'));
  // The same tooltip copy the live row carries: this is `InProgressRow`, not a picture of it.
  assert.match(html.slice(stage), /What claude reports it is doing right now: running Bash\./);
});
