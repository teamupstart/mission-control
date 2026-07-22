import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionEffort, type PaneDeps } from "../src/server/actions.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { Key, TerminalResult } from "../src/server/terminal/types.ts";
import { meta, mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";
import { MODEL_PICKER_XHIGH } from "./fixtures/claude-panes.ts";

const NORMAL = `
❯
⏸ manual mode on
`;

const pending = (command: string): string => `
❯ ${command}
⏸ manual mode on
`;

const picker = (level: string): string => MODEL_PICKER_XHIGH.replace("xHigh", level);

const ok = (): TerminalResult => ({ ok: true, outcomeUnknown: false });

function driven(start = NORMAL): { deps: PaneDeps; did: string[]; screen: () => string } {
  let screen = start;
  const did: string[] = [];
  const pane: BoundPane = {
    kind: "multiplexer",
    backend: "tmux",
    label: "tmux",
    token: "tmux:%1",
    capture: async () => screen,
    mode: async () => null,
    write: {
      text: async (text) => {
        did.push(`text:${text}`);
        if (text === "/model") screen = pending(text);
        if (text === "s") screen = NORMAL;
        return ok();
      },
      keys: async (keys: readonly Key[]) => {
        did.push(`keys:${keys.join(",")}`);
        if (keys[0] === "enter" && screen.includes("/model")) screen = picker("high");
        else if (keys[0] === "right" && screen.includes("◉ xhigh")) screen = picker("max");
        else if (keys[0] === "right" && screen.includes("◉ high")) screen = picker("xhigh");
        return ok();
      },
      paste: async () => ok(),
    },
  };
  return {
    deps: { pane: () => pane, capture: async () => screen },
    did,
    screen: () => screen,
  };
}

function session() {
  return mkSession({
    agent: "claude",
    meta: meta({ model: "Opus 4.8", modelId: "claude-opus-4-8", thinkingLevel: "high" }),
    terminals: [mkMuxHandle({ paneId: "%1" })],
  });
}

test("session effort verifies the composer, each move, and the session-only commit", async () => {
  const h = driven();
  const result = await setSessionEffort(session(), "max", h.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(h.did, ["text:/model", "keys:enter", "keys:right", "keys:right", "text:s"]);
  assert.equal(h.screen(), NORMAL);
});

test("session effort does not type into a pre-existing dialog", async () => {
  const h = driven(`
Do you want to proceed?
❯ 1. Yes
  2. No
`);
  const result = await setSessionEffort(session(), "max", h.deps);

  assert.equal(result.ok, false);
  assert.deepEqual(h.did, []);
});

const codexNormal = (level: string): string => `
› Ask Codex to do anything

  gpt-5.6-sol ${level} · /work/project
`;

const CODEX_MODEL_MENU = `
  Select Model and Effort
  Access legacy models by running codex -m <model_name> or in your config.toml

› 1. gpt-5.6-sol (default)  Latest frontier agentic coding model.
  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.

  Press enter to confirm or esc to go back
`;

const reasoning = (selected: "high" | "xhigh" | "more"): string => `
  Select Reasoning Level for gpt-5.6-sol

  1. Low               Fast responses with lighter reasoning
  2. Medium (default)  Balances speed and reasoning depth for everyday tasks
${selected === "high" ? "›" : " "} 3. High (current)    Greater reasoning depth for complex problems
${selected === "xhigh" ? "›" : " "} 4. Extra high        Extra high reasoning depth for complex problems
${selected === "more" ? "›" : " "} 5. More reasoning…   Max and Ultra consume usage limits faster

  Press enter to confirm or esc to go back
`;

const advanced = (selected: "max" | "ultra"): string => `
  Advanced Reasoning
  ⚠ Consumes usage limits faster

${selected === "max" ? "›" : " "} 1. Max    For difficult problems when quality matters more than speed
${selected === "ultra" ? "›" : " "} 2. Ultra  For demanding work using multiple agents

  Press enter to confirm or esc to go back
`;

function codexDriven(directMax = false): { deps: PaneDeps; did: string[]; screen: () => string } {
  let level = "high";
  let screen = codexNormal(level);
  const did: string[] = [];
  const pane: BoundPane = {
    kind: "multiplexer",
    backend: "tmux",
    label: "tmux",
    token: "tmux:%2",
    capture: async () => screen,
    mode: async () => null,
    write: {
      text: async (text) => {
        did.push(`text:${text}`);
        if (text === "/model") screen = `› /model\n\n  gpt-5.6-sol high · /work/project`;
        return ok();
      },
      keys: async (keys: readonly Key[]) => {
        const key = keys[0]!;
        did.push(`keys:${keys.join(",")}`);
        if (key === "shift-up" && level === "high" && screen === codexNormal("high")) {
          level = "xhigh";
          screen = codexNormal(level);
        } else if (key === "shift-up" && level === "xhigh" && directMax) {
          level = "max";
          screen = codexNormal(level);
        } else if (key === "enter" && screen.includes("› /model")) screen = CODEX_MODEL_MENU;
        else if (key === "enter" && screen === CODEX_MODEL_MENU) screen = reasoning(level === "xhigh" ? "xhigh" : "high");
        else if (key === "down" && screen === reasoning("high")) screen = reasoning("xhigh");
        else if (key === "down" && screen === reasoning("xhigh")) screen = reasoning("more");
        else if (key === "enter" && screen === reasoning("more")) screen = advanced("max");
        else if (key === "down" && screen === advanced("max")) screen = advanced("ultra");
        else if (key === "enter" && screen === advanced("ultra")) {
          level = "ultra";
          screen = codexNormal(level);
        } else if (key === "shift-down" && screen === codexNormal("ultra")) {
          level = "max";
          screen = codexNormal(level);
        }
        return ok();
      },
      paste: async () => ok(),
    },
  };
  return {
    deps: { pane: () => pane, capture: async () => screen },
    did,
    screen: () => screen,
  };
}

function codexSession() {
  return mkSession({
    agent: "codex",
    meta: meta({ model: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", thinkingLevel: "high" }),
    terminals: [mkMuxHandle({ paneId: "%2" })],
  });
}

test("Codex live effort uses its non-persisting reasoning shortcut", async () => {
  const h = codexDriven();
  const result = await setSessionEffort(codexSession(), "xhigh", h.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(h.did, ["keys:shift-up"]);
  assert.equal(h.screen(), codexNormal("xhigh"));
});

test("Codex reaches session-only Max through verified Ultra", async () => {
  const h = codexDriven();
  const codex = mkSession({
    agent: "codex",
    meta: meta({ model: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", thinkingLevel: "high" }),
    terminals: [mkMuxHandle({ paneId: "%2" })],
  });
  const result = await setSessionEffort(codex, "max", h.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(h.did, [
    "keys:shift-up",
    "keys:shift-up",
    "text:/model",
    "keys:enter",
    "keys:enter",
    "keys:down",
    "keys:enter",
    "keys:down",
    "keys:enter",
    "keys:shift-down",
  ]);
  assert.equal(h.screen(), codexNormal("max"));
});

test("Codex uses the direct session-only Max shortcut when available", async () => {
  const h = codexDriven(true);
  const result = await setSessionEffort(codexSession(), "max", h.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(h.did, ["keys:shift-up", "keys:shift-up"]);
  assert.equal(h.screen(), codexNormal("max"));
});
