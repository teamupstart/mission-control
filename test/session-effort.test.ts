import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionEffort, type PaneDeps } from "../src/server/actions.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { Key, TerminalResult } from "../src/server/terminal/types.ts";
import { meta, mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";

const NORMAL = `
❯
⏸ manual mode on
`;

const pending = (command: string): string => `
❯ ${command}
⏸ manual mode on
`;

const picker = (level: string): string => `
Select model

❯ 1. Opus 4.8  ${level}
  2. Sonnet 4.6  high

←/→ adjust · Enter set as default · s use this session only · Esc cancel
`;

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
        else if (keys[0] === "right" && screen.includes("  xhigh")) screen = picker("max");
        else if (keys[0] === "right" && screen.includes("  high")) screen = picker("xhigh");
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

test("Codex live effort is refused before any picker keystrokes", async () => {
  const h = driven();
  const codex = mkSession({
    agent: "codex",
    meta: meta({ model: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", thinkingLevel: "high" }),
    terminals: [mkMuxHandle({ paneId: "%1" })],
  });
  const result = await setSessionEffort(codex, "max", h.deps);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /session-only/);
  assert.deepEqual(h.did, []);
});
