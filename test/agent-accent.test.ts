/**
 * What is at stake: a harness added to `AGENT_TYPES` must RENDER, without anyone
 * editing the stylesheet or a component.
 *
 * The dot beside every session title used to be drawn by an `agent-${agent}` class with
 * one hand-written rule per harness in a 7,800-line file. Nothing failed when that rule
 * was missing - typecheck passed, tests passed, the dashboard came up - and the new
 * harness simply wore no colour, in four surfaces at once. That is the exact shape of
 * defect this migration exists to remove: silent degradation instead of a compile error.
 *
 * So the colour is declared ON the harness, as a literal value, and reaches CSS through
 * one `--agent-accent` custom property. This file pins both halves: the declaration is
 * total and usable, and the stylesheet has no idea any particular agent exists.
 *
 * It also pins the collision this replaced. `--claude` doubled as Foreman's accent in
 * five rules, so retuning Claude Code's terracotta would have silently restyled a
 * component that is not an agent at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_TYPES } from "../src/shared/types.ts";
import { AGENT_IDENTITY, agentList } from "../src/shared/agent.ts";
import { AgentDot, agentAccentStyle } from "../src/web/components/session-bits.tsx";

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
/** Prose mentions the retired tokens by name to say why they are gone; rules must not. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

test("every harness declares a literal accent colour", () => {
  for (const agent of AGENT_TYPES) {
    const accent = AGENT_IDENTITY[agent].accent;
    // A `var(--something)` here would pass typecheck and put us straight back where we
    // started: the harness would render correctly only for as long as someone remembers
    // to add the token it names.
    assert.doesNotMatch(accent, /var\(/, `${agent}'s accent must be a value, not a token name`);
    assert.match(accent, /^#[0-9a-f]{3,8}$|^(rgb|hsl|oklch|oklab)\(/i, `${agent} needs a colour`);
  }
});

test("the stylesheet names no agent", () => {
  // Every id, anywhere outside a comment - which covers the class, the token, and the
  // `[data-agent="…"]` a future edit might reach for instead. NOT the accent's literal
  // value: a hex can legitimately recur (`--syntax-type` is the same terracotta by
  // history), and it was never the shared VALUE that coupled these - it was a rule or a
  // token that had to be added by hand, per harness, for anything to render.
  for (const agent of AGENT_TYPES) {
    assert.doesNotMatch(bare, new RegExp(`\\b${agent}\\b`), `styles.css names ${agent}`);
  }
});

test("the dot is drawn by one rule, off the custom property", () => {
  assert.match(bare, /\.agent-dot\s*\{[^}]*var\(--agent-accent, var\(--neutral\)\)/);
});

test("Foreman has its own token, and no rule borrows an agent's", () => {
  assert.match(bare, /--foreman:/);
  // Every Foreman-coloured rule reaches for it. Named individually rather than by a
  // `-foreman` pattern because `.fe-ask` - the escalation's terminal capture - carries
  // the accent without carrying the word.
  for (const sel of [
    ".nm-byline-foreman",
    ".nm-who-foreman",
    ".nm-foreman-tag",
    ".nm-reply-foreman",
    ".turn-foreman .turn-role",
    ".fe-ask",
  ]) {
    const rule = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
    const body = rule.exec(bare)?.[1];
    assert.ok(body, `${sel} has no rule`);
    assert.match(body!, /var\(--foreman\)/, `${sel} does not use --foreman`);
  }
});

test("AgentDot carries the accent inline and no per-agent class", () => {
  for (const agent of AGENT_TYPES) {
    const html = renderToStaticMarkup(createElement(AgentDot, { agent }));
    assert.match(html, /class="agent-dot"/, `${agent}'s dot grew a second class`);
    assert.match(html, /--agent-accent/, `${agent}'s dot sets no accent`);
    assert.ok(html.includes(AGENT_IDENTITY[agent].accent), `${agent}'s dot is not its colour`);
  }
});

test("agentAccentStyle answers for every agent", () => {
  for (const agent of AGENT_TYPES) {
    const style = agentAccentStyle(agent) as Record<string, string>;
    assert.equal(style["--agent-accent"], AGENT_IDENTITY[agent].accent);
  }
});

test("agentList says every harness out loud", () => {
  const said = agentList(AGENT_TYPES);
  for (const agent of AGENT_TYPES) assert.ok(said.includes(AGENT_IDENTITY[agent].label), agent);
  // A one-agent build must not say "Claude Code or" with nothing after it.
  assert.equal(agentList([AGENT_TYPES[0]!]), AGENT_IDENTITY[AGENT_TYPES[0]!].label);
  assert.equal(agentList([]), "");
});
