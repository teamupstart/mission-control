import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { PasteResult, TerminalResult } from "../src/server/terminal/types.ts";
import { meta, mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";

// The launch default is persisted in SQLite, so isolate it before importing either
// config module. This proves a successful live write does not wander through that door.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-effort-scope-"));

const { openDb } = await import("../src/server/db.ts");
const { setHarnessesConfig, resolveDispatchEffort } = await import("../src/server/harnesses.ts");
const { setSessionEffort } = await import("../src/server/actions.ts");
openDb();

const ok = (): TerminalResult => ({ ok: true, outcomeUnknown: false });
/** A paste from a backend that holds the composer, which every fake here stands in for. */
const held = (): PasteResult => ({ ok: true, outcomeUnknown: false, submitted: false });

test("a successful live effort change leaves the future-session default untouched", async () => {
  setHarnessesConfig({ defaultEffort: { codex: "medium" } });
  let screen = "\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · /work/project\n";
  const pane: BoundPane = {
    kind: "multiplexer",
    backend: "tmux",
    label: "tmux",
    token: "tmux:%2",
    capture: async () => screen,
    mode: async () => null,
    write: {
      text: async () => ok(),
      keys: async () => {
        screen = "\n› Ask Codex to do anything\n\n  gpt-5.6-sol xhigh · /work/project\n";
        return ok();
      },
      paste: async () => held(),
    },
  };
  const session = mkSession({
    id: "live-one",
    agent: "codex",
    meta: meta({ model: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", thinkingLevel: "high" }),
    terminals: [mkMuxHandle({ paneId: "%2" })],
  });

  const result = await setSessionEffort(session, "xhigh", {
    pane: (candidate) => candidate.terminals.some((handle) => handle.paneId === "%2") ? pane : null,
    capture: async () => screen,
  });

  assert.deepEqual(result, { ok: true, effort: "xhigh" });
  assert.equal(resolveDispatchEffort("codex", null), "medium");
});
