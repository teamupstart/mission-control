import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingInstructionsView } from "../src/shared/protocol.ts";
import type { StandingInstructionsDelivery } from "../src/shared/standing-instructions.ts";
import { StandingInstructionsPanel } from "../src/web/components/StandingInstructionsPanel.tsx";
import { StandingInstructionsDeliveryView } from "../src/web/components/StandingInstructionsDelivery.tsx";
import { DEFAULT_CARD } from "../src/web/standing-instructions-reconcile.ts";
import type {
  StandingInstructionsCard,
  StandingInstructionsState,
} from "../src/web/useStandingInstructions.ts";

// What is at stake: this panel writes a rule an agent will OBEY, on repositories the
// operator names, and it is the only place that rule can be read or changed. Two things a
// control cannot say by itself have to be said here.
//
//  - WHICH SESSIONS GET IT. A standing instruction that silently reaches half the fleet is
//    worse than none: it is trusted and wrong. The reach block is the answer, and it is
//    asserted row by row below - a generic "the reach block renders" assertion passes
//    while a row is missing, which is exactly the case that matters.
//  - WHETHER A REPOSITORY HAS ONE. `inherited` and `override` are not decoration: a key
//    stored EMPTY means "send nothing here" and beats the machine-wide default, while an
//    absent key inherits it. The two render identically if nobody insists otherwise.
//
// Rendered rather than driven through a browser, for the reason every other settings test
// is: static markup runs no effects, so nothing fetches and the pre-poll state is what
// draws. The browser half - a rule reaching an actual dispatch - is `e2e/`.

function viewOf(
  repositories: Record<string, string> = {},
  def = "",
): StandingInstructionsView {
  return { default: def, repositories, etag: "e1" };
}

function cardsFrom(view: StandingInstructionsView | null): StandingInstructionsCard[] {
  if (!view) return [];
  const mk = (key: string, value: string, override: boolean): StandingInstructionsCard => ({
    key,
    value,
    dirty: false,
    override,
    theirs: null,
  });
  return [
    mk(DEFAULT_CARD, view.default, false),
    ...Object.entries(view.repositories).map(([k, v]) => mk(k, v, true)),
  ];
}

function mkState(
  view: StandingInstructionsView | null,
  over: Partial<StandingInstructionsState> = {},
): StandingInstructionsState {
  return {
    view,
    cards: cardsFrom(view),
    edit: () => {},
    save: async () => true,
    revert: () => {},
    useGlobalDefault: async () => true,
    addRepository: async () => null,
    conflictCards: [],
    keepMine: () => {},
    takeTheirs: () => {},
    saving: null,
    error: null,
    ...over,
  };
}

function render(
  view: StandingInstructionsView | null,
  over: Partial<StandingInstructionsState> = {},
): string {
  return renderToStaticMarkup(
    createElement(StandingInstructionsPanel, { state: mkState(view, over) }),
  );
}

// ---- The three states that render identically if nobody insists otherwise ----

// A static render is the pre-poll state. Drawing an empty list there tells an operator no
// repository has a rule, while the daemon may hold four.
test("with no answer from the daemon, the panel says so rather than showing an empty list", () => {
  const html = render(null);
  assert.match(html, /daemon has not answered yet/);
  assert.doesNotMatch(
    html,
    /No repository has a rule of its own/,
    "an unanswered panel must not assert emptiness",
  );
});

test("an answered, empty document says nothing is configured and why that is safe", () => {
  const html = render(viewOf());
  assert.match(html, /No repository has a rule of its own/);
  assert.match(html, /machine-wide default[\s\S]*?empty unless you write one/);
  assert.doesNotMatch(html, /daemon has not answered yet/);
});

// The gate the settings search index depends on: an anchor that only exists once the daemon
// has answered is a jump that lands on nothing exactly when the daemon is slow.
test("both anchored sections exist before the daemon has answered", () => {
  for (const html of [render(null), render(viewOf())]) {
    assert.match(html, /data-anchor="standing-instructions\/default"/);
    assert.match(html, /data-anchor="standing-instructions\/repositories"/);
  }
});

// ---- override versus inherited ----

test("a repository with a stored rule is an override, and the count follows", () => {
  const html = render(viewOf({ "/ws/alpha": "never run E2E locally" }));
  assert.match(html, /si-chip-override/);
  assert.match(html, /1 configured/);
});

test("a repository stored EMPTY is still an override, not an inherited card", () => {
  // The distinction the whole store is built on: "" means send nothing HERE and beats the
  // machine-wide default, while an absent key inherits it. Collapse the two and clearing a
  // box quietly reinstates the default text.
  const html = render(viewOf({ "/ws/alpha": "" }, "house rules"));
  assert.match(html, /si-chip-override/);
  assert.doesNotMatch(html, /si-chip-inherited/);
});

test("Use global default is disabled when there is no override to remove", () => {
  const state = mkState(viewOf({ "/ws/alpha": "x" }));
  const inherited = state.cards.map((c) =>
    c.key === "/ws/alpha" ? { ...c, override: false } : c
  );
  const html = renderToStaticMarkup(
    createElement(StandingInstructionsPanel, { state: { ...state, cards: inherited } }),
  );
  // The card is collapsed in a static render, so assert through the button's own tooltip
  // text, which the Tooltip renders into a visually-hidden node either way.
  assert.doesNotMatch(html, /Remove this repository's rule/);
});

test("the counter names the daemon's own ceiling rather than a number typed here", () => {
  const html = render(viewOf({}, "abc"));
  assert.match(html, /3 \/ 8,000/);
});

// ---- The reach block, row by row ----

// A card's disclosure is closed in a static render and opening it needs an event, so the
// rows are asserted against the DERIVATION the card renders from. That is the stronger
// assertion anyway: it pins the five pairs and their exact mechanisms, where a markup match
// would only pin that some rows drew.
test("the reach block states all five harness and runtime pairs with their mechanisms", async () => {
  const { reachPairs } = await import("../src/web/lib/standing-instructions-view.ts");
  const rows = reachPairs();
  const labels = rows.map((r) => r.label);

  // Derived from the harness registry rather than typed out, so this asserts the DERIVATION
  // produces exactly the five pairs the plan promises - and would fail loudly on the day a
  // harness ships without the reach block being reconsidered.
  assert.deepEqual(labels.sort(), [
    "claude · sdk",
    "claude · terminal",
    "codex · sdk",
    "codex · terminal",
    "pi · terminal",
  ]);

  const by = (label: string) => rows.find((r) => r.label === label)!;
  assert.equal(by("claude · terminal").prose.detail, "--append-system-prompt");
  assert.equal(by("claude · terminal").prose.channel, "system prompt");
  assert.equal(by("claude · sdk").prose.detail, "systemPrompt.append");
  assert.equal(by("codex · sdk").prose.detail, "developerInstructions");
  assert.equal(by("codex · sdk").prose.channel, "developer instructions");
  // Codex terminal is reached by turn one; Pi terminal has its own channel.
  assert.equal(by("codex · terminal").prose.channel, "prompt text");
  assert.equal(by("codex · terminal").prose.detail, "composed above turn one");
  assert.equal(by("pi · terminal").prose.channel, "system prompt");
});

test("the mechanism prose says which channels never enter the transcript", async () => {
  const { MECHANISM_PROSE } = await import("../src/web/lib/standing-instructions-view.ts");
  // The reason a marker names the mechanism at all: on Claude the block rides the system
  // prompt, so a marker that only said "sent" would send an operator searching a
  // conversation for something that was never in it.
  assert.equal(MECHANISM_PROSE["claude-append-system-prompt"].inTranscript, false);
  assert.equal(MECHANISM_PROSE["claude-sdk-system-prompt-append"].inTranscript, false);
  assert.equal(MECHANISM_PROSE["codex-developer-instructions"].inTranscript, false);
  assert.equal(MECHANISM_PROSE["prompt-prefix"].inTranscript, true);
});

test("the reach block states both deliberate exclusions and the running-session line", async () => {
  const { REACH_EXCLUSIONS } = await import("../src/web/lib/standing-instructions-view.ts");
  const subjects = REACH_EXCLUSIONS.map((r) => r.subject);

  // Externally started sessions. Dropping this row leaves an operator expecting a rule to
  // govern a session Mission Control never launched.
  assert.ok(subjects.includes("sessions started outside Mission Control"));
  // Mission Control's OWN review prompts. The easier of the two to drop and the more
  // damaging to omit: without it the panel reads as though a rule written here also governs
  // the Inspector's review of the resulting pull request, so an operator who writes "never
  // run E2E tests locally" would expect the Inspector not to flag their absence - and would
  // be wrong.
  assert.ok(subjects.includes("Foreman / Inspector / Persona review prompts"));
  // WHEN, not where, which is why it is a row and not a footnote on the first.
  const running = REACH_EXCLUSIONS.find((r) => r.subject === "sessions already running");
  assert.ok(running, "an operator editing a rule with five sessions open must be told");
  assert.equal(running.glyph, "⏱");
  assert.match(running.note, /keep what they launched with/);
  assert.match(running.note, /reaches the next session/);
});

// ---- The one read-only component both markers use ----

function delivery(over: Partial<StandingInstructionsDelivery> = {}): StandingInstructionsDelivery {
  return {
    text: "## Standing instructions for this repository\n\nNever run E2E tests locally.",
    mechanism: "claude-append-system-prompt",
    sources: [{ repoPath: "/ws/alpha", matchedKey: "/ws/alpha" }],
    ...over,
  };
}

function renderDelivery(d: StandingInstructionsDelivery, heading = "This dispatch will send") {
  return renderToStaticMarkup(
    createElement(StandingInstructionsDeliveryView, { delivery: d, heading }),
  );
}

test("a single-repository delivery renders its size, mechanism and one labelled source", () => {
  const html = renderDelivery(delivery());
  assert.match(html, /74 characters · as system prompt/);
  assert.match(html, /--append-system-prompt/);
  assert.match(html, /from the rule for \/ws\/alpha/);
  assert.match(html, /never appears in the conversation/);
});

test("a two-repository delivery names every contributing checkout and its stored key", () => {
  // `sources` is deliberately NOT grouped the way the composed text is, so a marker can
  // still say which checkout inherited which key even when both resolved to the same words.
  const html = renderDelivery(delivery({
    sources: [
      { repoPath: "/ws/alpha", matchedKey: "/ws/alpha" },
      { repoPath: "/ws/beta", matchedKey: null },
    ],
  }));
  assert.match(html, /from the rule for \/ws\/alpha/);
  assert.match(html, /from the machine-wide default/);
});

test("a prompt-prefix delivery does not claim to be invisible in the conversation", () => {
  const html = renderDelivery(delivery({ mechanism: "prompt-prefix" }));
  assert.match(html, /as prompt text/);
  assert.doesNotMatch(html, /never appears in the conversation/);
});

test("an empty delivery renders nothing at all", () => {
  // The regression guard in one assertion: a checkout with no standing instructions has to
  // look byte-identical to what it did before this feature existed.
  assert.equal(renderDelivery(delivery({ text: "", mechanism: "none", sources: [] })), "");
});
