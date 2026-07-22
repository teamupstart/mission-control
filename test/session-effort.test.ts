import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionEffort, type PaneDeps } from "../src/server/actions.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { Key, TerminalResult } from "../src/server/terminal/types.ts";
import type { ThinkingLevel } from "../src/shared/types.ts";
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

interface CodexDriverOptions {
  start?: ThinkingLevel | "ultra";
  failWrites?: readonly number[];
}

function codexDriven(options: CodexDriverOptions = {}): { deps: PaneDeps; did: string[]; screen: () => string } {
  const levels: readonly (ThinkingLevel | "ultra")[] = ["low", "medium", "high", "xhigh", "ultra"];
  let level = options.start ?? "high";
  let screen = codexNormal(level);
  let keyWrites = 0;
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
        keyWrites += 1;
        if (options.failWrites?.includes(keyWrites)) {
          return { ok: false, error: "key delivery failed", outcomeUnknown: false };
        }
        const index = levels.indexOf(level);
        if (key === "shift-up" && index < levels.length - 1 && level !== "xhigh") {
          level = levels[index + 1]!;
        } else if (key === "shift-down" && index > 0) level = levels[index - 1]!;
        screen = codexNormal(level);
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

function codexSession(level: ThinkingLevel = "high") {
  return mkSession({
    agent: "codex",
    meta: meta({ model: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", thinkingLevel: level }),
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

test("Codex lowers visible ultra effort through normalized max metadata", async () => {
  const h = codexDriven({ start: "ultra" });
  const result = await setSessionEffort(codexSession("max"), "xhigh", h.deps);

  assert.deepEqual(result, { ok: true, effort: "xhigh" });
  assert.deepEqual(h.did, ["keys:shift-down"]);
  assert.equal(h.screen(), codexNormal("xhigh"));
});

test("Codex never opens the persistent picker when Max shortcut is unavailable", async () => {
  const h = codexDriven();
  const codex = mkSession({
    agent: "codex",
    meta: meta({ model: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", thinkingLevel: "high" }),
    terminals: [mkMuxHandle({ paneId: "%2" })],
  });
  const result = await setSessionEffort(codex, "max", h.deps);

  assert.equal(result.ok, false);
  assert.deepEqual(h.did, []);
  assert.equal(h.screen(), codexNormal("high"));
});

test("Codex refuses every multi-step effort change before sending a key", async () => {
  const h = codexDriven({ start: "low" });
  const result = await setSessionEffort(codexSession("low"), "high", h.deps);

  assert.equal(result.ok, false);
  assert.deepEqual(h.did, []);
  assert.equal(h.screen(), codexNormal("low"));
});

test("Codex applies one adjacent effort change with one native shortcut", async () => {
  const h = codexDriven({ start: "low" });
  const result = await setSessionEffort(codexSession("low"), "medium", h.deps);

  assert.deepEqual(result, { ok: true, effort: "medium" });
  assert.deepEqual(h.did, ["keys:shift-up"]);
  assert.equal(h.screen(), codexNormal("medium"));
});

test("Codex does not retry a refused atomic shortcut", async () => {
  const h = codexDriven({ start: "low", failWrites: [1] });
  const result = await setSessionEffort(codexSession("low"), "medium", h.deps);

  assert.equal(result.ok, false);
  assert.deepEqual(h.did, ["keys:shift-up"]);
  assert.equal(h.screen(), codexNormal("low"));
});
