import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessesPanel } from "../src/web/components/HarnessesPanel.tsx";
import type { HarnessesState } from "../src/web/useHarnesses.ts";
import {
  DEFAULT_HARNESSES_SESSION_RUNTIMES,
  DEFAULT_HARNESSES_TERMINAL_BACKENDS,
  emptyTaskKindDefaults,
  type HarnessesConfig,
} from "../src/shared/protocol.ts";
import {
  AGENT_TYPES,
  type AgentType,
  type SessionRuntime,
  type ThinkingLevel,
} from "../src/shared/types.ts";
import type { TerminalBackendId } from "../src/shared/terminal.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";
import {
  HARNESS_CAPABILITIES,
  autoModeAgents,
  autoModeUnsupportedWhy,
  sdkRuntimeUnsupportedWhy,
} from "../src/shared/harness-capabilities.ts";
import { hasTooltip } from "./helpers/markup.ts";

/** Who the switch reaches, from the same declaration the panel reads. */
const AUTO = autoModeAgents();
const EXCLUDED = AGENT_TYPES.filter((a) => !AUTO.includes(a));

// The Harnesses settings panel, rendered. Static markup rather than a driven browser:
// the dashboard's SSE stream hangs headless automation, and these are questions about
// words and structure (the same convention as skills-panel / settings-sidebar-render).
//
// Two things are at stake. The panel never over-promises the toggle's SCOPE: auto mode
// on dispatch touches only the sessions the app launches, and does nothing to a session
// it never launched - a row that says only "auto mode" is claiming more than it delivers.
// And the per-harness defaults render as ONE CARD PER HARNESS, derived from `AGENT_TYPES`,
// with the harness's accent inline - so a third harness lights up here with no new layout
// and no stylesheet edit (the flip side of `agent-accent.test.ts`, which fails if any
// harness id reaches `styles.css`).

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
function reEscape(s: string): string {
  return s.replace(RE_ESCAPE, "\\$&");
}

/** Every-agent record, so a fixture stays total as `AGENT_TYPES` grows. */
function fullRecord<T>(value: T): Record<AgentType, T> {
  return Object.fromEntries(AGENT_TYPES.map((a) => [a, value])) as Record<AgentType, T>;
}

function mkState(config: HarnessesConfig | null, over: Partial<HarnessesState> = {}): HarnessesState {
  return { config, update: async () => {}, error: null, ...over };
}

/**
 * A full config from the one or two keys a test actually cares about. The per-agent maps
 * default to "no override" for every harness and are patched by agent, so a test naming
 * only Claude's model does not have to spell out the others - and adding a harness does
 * not break a fixture that never mentioned it.
 */
function mkConfig(
  over: {
    autoModeOnDispatch?: boolean;
    defaultModel?: Partial<Record<AgentType, string | null>>;
    defaultEffort?: Partial<Record<AgentType, ThinkingLevel | null>>;
    sessionRuntime?: Partial<Record<AgentType, SessionRuntime>>;
    terminalBackend?: Partial<Record<AgentType, TerminalBackendId | null>>;
  } = {},
): HarnessesConfig {
  return {
    autoModeOnDispatch: over.autoModeOnDispatch ?? false,
    defaultModel: { ...fullRecord<string | null>(null), ...over.defaultModel },
    defaultEffort: { ...fullRecord<ThinkingLevel | null>(null), ...over.defaultEffort },
    sessionRuntime: { ...DEFAULT_HARNESSES_SESSION_RUNTIMES, ...over.sessionRuntime },
    terminalBackend: { ...DEFAULT_HARNESSES_TERMINAL_BACKENDS, ...over.terminalBackend },
    kindDefaults: emptyTaskKindDefaults(),
  };
}

function render(
  config: Parameters<typeof mkConfig>[0] | null,
  over: Partial<HarnessesState> = {},
): string {
  const state = mkState(config ? mkConfig(config) : null, over);
  return renderToStaticMarkup(createElement(HarnessesPanel, { state }));
}

test("the panel scopes the toggle to dispatched sessions before you click anything", () => {
  // The contract the setting promises: it never touches a session you started yourself
  // and the app merely discovered. Said up front, not buried.
  const html = render({ autoModeOnDispatch: false });
  assert.match(html, /dispatches/i);
  assert.match(html, /never touch/i);
});

test("the auto-mode row names exactly the harnesses it reaches", () => {
  // A toggle that silently no-ops on half the fleet is the failure the badge exists to
  // prevent - and the scope is read off `permissionModes.onDispatch`, not written out,
  // so this asserts the PAIR: reached agents named, unreached agents never claimed.
  const html = render({ autoModeOnDispatch: false });
  assert.match(html, new RegExp(`${AUTO.join(" / ")} only`, "i"));
  for (const a of AUTO) {
    assert.match(
      html,
      new RegExp(`When enabled, every[^<]*${AGENT_IDENTITY[a].label}`, "i"),
    );
  }
  for (const a of EXCLUDED) {
    // Never named in the sentence describing what the switch does.
    assert.doesNotMatch(
      html,
      new RegExp(`When enabled, every[^<]*${AGENT_IDENTITY[a].label}`, "i"),
    );
  }
});

test("the auto-mode row makes no promise about harnesses it doesn't reach", () => {
  // It used to say "Codex support comes later" - a commitment this panel is in no
  // position to make on a vendor's behalf, and one nothing would ever come back to.
  assert.doesNotMatch(render({ autoModeOnDispatch: false }), /comes later|coming soon/i);
});

test("the auto-mode row describes each supported transport rather than a live TUI walk", () => {
  const html = render({ autoModeOnDispatch: true });
  assert.match(html, /embedded dispatches apply that posture through the driver/i);
  assert.match(html, /terminal dispatches use the harness(?:&#x27;|')s own launch treatment/i);
  assert.doesNotMatch(html, /switched to.*once (?:it(?:&#x27;)?s )?ready/i);
});

test("an enabled setting renders the switch checked", () => {
  assert.match(render({ autoModeOnDispatch: true }), /checked/);
});

test("a disabled setting renders the switch unchecked", () => {
  assert.doesNotMatch(render({ autoModeOnDispatch: false }), /checked/);
});

test("the switch is disabled until the first config read lands", () => {
  // It mounts inside the settings page, so the first paint happens with config: null.
  // A togglable switch there would race the fetch and could write a value onto defaults
  // it never actually read.
  //
  // The panel draws its cards either way - the category's own title is the page's header
  // now, not this panel's, so what proves it rendered is the control itself.
  const html = render(null);
  assert.match(html, /Auto mode on dispatch/);
  assert.match(html, /<input[^>]*disabled/);
  // On is the shipped default, so the pre-poll switch reads checked.
  assert.match(html, /checked/);
});

test("the runtime card waits for the saved config instead of guessing a legacy default", () => {
  const html = render(null);
  assert.match(html, /Loading saved runtime default for Claude Code\./);
  assert.doesNotMatch(html, /Session runtime for dispatched Claude Code sessions/);
  assert.doesNotMatch(html, /<option value="sdk" selected/);
});

test("a rejected edit says so", () => {
  assert.match(
    render({ autoModeOnDispatch: false }, { error: "That didn't stick: no." }),
    /That didn&#x27;t stick: no\./,
  );
});

// ---- one card per harness ----

test("there is exactly one card per harness, one per AGENT_TYPES entry", () => {
  // Pinned off the array, not a count literal: a harness added to `AGENT_TYPES` must get
  // its own card here with no edit to this panel, and the compiler cannot see a missing
  // card. Each card is anchored `harnesses/<agent>`, the id Phase 5's search points at.
  const html = render({});
  const cards = html.match(/class="harness-card"/g) ?? [];
  assert.equal(cards.length, AGENT_TYPES.length);
  for (const a of AGENT_TYPES) {
    assert.match(html, new RegExp(`data-anchor="harnesses/${a}"`), `${a} has no card`);
    assert.match(html, new RegExp(`>${reEscape(AGENT_IDENTITY[a].label)}</b>`), `${a} card is unlabelled`);
  }
});

test("each card wears its harness's accent inline, never a per-agent class", () => {
  // The accent reaches CSS as one `--agent-accent` custom property, so a new harness is
  // coloured without a stylesheet rule. `agent-accent.test.ts` pins the other half - that
  // no harness id ever appears in `styles.css`.
  const html = render({});
  for (const a of AGENT_TYPES) {
    assert.ok(
      html.includes(`--agent-accent:${AGENT_IDENTITY[a].accent}`),
      `${a} card sets no accent`,
    );
  }
});

// ---- per-card badges ----

test("a harness the switch leaves alone carries the reason on its own card", () => {
  // The excluded harness's card says why auto mode does not reach it, in the exact words
  // `autoModeUnsupportedWhy` composes - never a hand-written literal that a fourth harness
  // would leave stale.
  const html = render({ autoModeOnDispatch: true });
  for (const a of EXCLUDED) {
    assert.equal(hasTooltip(html, autoModeUnsupportedWhy(a)!), true);
  }
  // The visible badge itself names no harness.
  if (EXCLUDED.length > 0) assert.match(html, />no auto mode</);
});

test("a reached harness wears its auto-mode badge only while the switch is on", () => {
  // The card says what a dispatch will do RIGHT NOW, not what it could: with the master
  // toggle off, a reached harness shows no "on" badge; with it on, it does.
  assert.doesNotMatch(render({ autoModeOnDispatch: false }), />auto mode on</);
  if (AUTO.length > 0) assert.match(render({ autoModeOnDispatch: true }), />auto mode on</);
});

// ---- default model on the card ----

test("every harness card carries its own model picker", () => {
  // One picker per harness, because a model id is not portable across them - a single
  // shared picker would offer Codex models to Claude.
  const html = render({});
  assert.match(html, /Per harness/);
  for (const a of AGENT_TYPES) {
    assert.match(
      html,
      new RegExp(`aria-label="Default model for dispatched ${reEscape(AGENT_IDENTITY[a].label)} sessions"`),
      `${a} has no model picker`,
    );
  }
});

test("no default reads as 'the harness decides', not as an empty setting", () => {
  // The shipped state is real and has to describe itself: nothing is passed to the CLI,
  // so the harness's own configured model wins. "Blank" would look like a broken read.
  const html = render({});
  assert.match(html, /Harness default/);
  assert.match(html, /no --model flag/);
});

test("a configured default names the flag the dispatcher will actually pass", () => {
  const html = render({ defaultModel: { claude: "claude-opus-4-8" } });
  assert.match(html, /--model claude-opus-4-8/);
  // Selected, so reopening Settings shows the setting rather than resetting it.
  assert.match(html, /<option value="claude-opus-4-8" selected/);
});

test("a default this build doesn't know is still shown as selected", () => {
  // Set by a newer build or straight at the route. Dropping it would render the select
  // on its empty option - claiming "no default" for a setting that has one, and writing
  // that lie back on the operator's next unrelated edit.
  const html = render({ defaultModel: { claude: "claude-opus-9-9" } });
  assert.match(html, /<option value="claude-opus-9-9" selected/);
  assert.match(html, /not currently reported/);
});

test("the model pickers are disabled until the first config read lands", () => {
  // Same race as the switch: a writable select on a config we haven't read yet would
  // patch a default over a value we never saw.
  const html = render(null);
  assert.match(html, /<select[^>]*disabled/);
});

// ---- default effort on the card ----

test("every harness card carries a configurable default effort", () => {
  const html = render({ defaultEffort: { claude: "high", codex: "xhigh" } });
  for (const a of AGENT_TYPES) {
    assert.match(
      html,
      new RegExp(`aria-label="Default effort for dispatched ${reEscape(AGENT_IDENTITY[a].label)} sessions"`),
      `${a} has no effort picker`,
    );
  }
  assert.match(html, /<option value="high" selected/);
  assert.match(html, /<option value="xhigh" selected/);
});

test("the card sentence restates both the model and the effort a dispatch will use", () => {
  // The card is the join the two-list layout made the eye do: its note has to say what a
  // dispatch of THIS harness does, model and effort together.
  const html = render({ defaultModel: { claude: "claude-opus-4-8" }, defaultEffort: { claude: "high" } });
  assert.match(html, /--model claude-opus-4-8[^.]*\.\s*They start with high reasoning effort\./);
});

// ---- session runtime on the card ----

test("the runtime control renders only for a harness that declares a driver", () => {
  const html = render({});
  // Claude declares `sdk`, so the operator gets the choice. A harness that does not is not
  // given a toggle that changes nothing - the absence is a sentence, not a greyed-out row.
  for (const a of AGENT_TYPES) {
    const label = `aria-label="Session runtime for dispatched ${reEscape(AGENT_IDENTITY[a].label)} sessions"`;
    const declares = HARNESS_CAPABILITIES[a].runtimes.includes("sdk");
    assert.equal(
      new RegExp(label).test(html),
      declares,
      `${a}: control rendered=${!declares} but runtimes says otherwise`,
    );
    if (!declares) {
      assert.match(html, new RegExp(reEscape(sdkRuntimeUnsupportedWhy(a)!)), `${a} states why not`);
    }
  }
});

test("a fresh card shows the shipped runtime defaults", () => {
  const html = render({});
  assert.equal((html.match(/<option value="sdk" selected/g) ?? []).length, 2);
  assert.match(html, /They run inside Mission Control on the Agent SDK/);
});

test("the runtime select recommends the Agent SDK by name, and only it", () => {
  const html = render({});

  assert.match(html, /<option value="sdk" selected="">Agent SDK \(recommended\)<\/option>/);
  assert.match(html, /<option value="terminal">Terminal pane<\/option>/);
});

test("a card describes a terminal choice when an operator selects it", () => {
  const html = render({ sessionRuntime: { claude: "terminal" } });
  assert.match(html, /<option value="terminal" selected/);
  assert.match(html, /selecting an available multiplexer or terminal app automatically/);
  assert.match(html, /Terminal preference for Claude Code: Automatic/);
});

test("a terminal-backed harness gets the detailed terminal chooser and keeps an exact choice", () => {
  const html = render({
    sessionRuntime: { claude: "terminal" },
    terminalBackend: { claude: "herdr" },
  });

  assert.match(html, /Terminal preference for Claude Code: herdr/);
  assert.match(html, /using the terminal selected above/);
  assert.doesNotMatch(html, /Choose a terminal for dispatched Claude Code sessions/);
});

test("an SDK-backed harness hides its terminal chooser without clearing the stored choice", () => {
  const html = render({
    sessionRuntime: { claude: "sdk" },
    terminalBackend: { claude: "herdr" },
  });

  assert.doesNotMatch(html, /Terminal preference for Claude Code/);
  assert.match(html, /Agent SDK/);
});

test("an unknown stored terminal backend is visible and falls back to Automatic", () => {
  const html = render({
    sessionRuntime: { claude: "terminal" },
    terminalBackend: { claude: "future-terminal" as TerminalBackendId },
  });

  assert.match(html, /Terminal preference for Claude Code: Automatic/);
  assert.match(html, /terminal backend this build doesn&#x27;t know \(future-terminal\) was ignored/);
  assert.match(html, /selecting an available multiplexer or terminal app automatically/);
});

test("an Agent SDK selection says what changes in the card's own sentence", () => {
  const html = render({ sessionRuntime: { claude: "sdk" } });
  assert.match(html, /<option value="sdk" selected/);
  assert.match(html, /no terminal pane/);
  assert.match(html, /Continue in terminal/);
});

test("a stored runtime this build cannot read is reported, not silently healed", () => {
  // The `ResolvedLlmRunner.unknown` precedent: swallowed, a value from a newer build is
  // indistinguishable from an unset one, and the panel would render the fallback as the
  // operator's own choice.
  const html = render({ sessionRuntime: { claude: "quantum" as SessionRuntime } });
  assert.match(html, /<option value="terminal" selected/);
  assert.match(html, /doesn&#x27;t know \(quantum\) was ignored/);
});
