import { test } from "node:test";
import assert from "node:assert/strict";
import { setPermissionMode, type PaneDeps } from "../src/server/actions.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { Key, TerminalResult } from "../src/server/terminal/types.ts";
import { mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";
import { CODEX_COMMAND_APPROVAL, CODEX_PERMISSIONS_PICKER } from "./fixtures/codex-panes.ts";

const EMPTY_COMPOSER = `
› Ask Codex to do anything

  gpt-5.6-sol high · /work/project
`;

const ok = (): TerminalResult => ({ ok: true, outcomeUnknown: false });

function driven(start: string): { deps: PaneDeps; did: string[] } {
  let screen = start;
  const did: string[] = [];
  const pane: BoundPane = {
    kind: "multiplexer",
    backend: "tmux",
    label: "tmux",
    token: "tmux:%permission-menu",
    capture: async () => screen,
    mode: async () => null,
    write: {
      text: async (text) => {
        did.push(`text:${text}`);
        if (screen === EMPTY_COMPOSER) screen = `› ${text}\n\n  gpt-5.6-sol high · /work/project`;
        return ok();
      },
      keys: async (keys: readonly Key[]) => {
        did.push(`keys:${keys.join(",")}`);
        if (keys[0] === "enter" && screen.includes("/permissions")) screen = CODEX_PERMISSIONS_PICKER;
        else if (keys[0] === "enter" && screen === CODEX_PERMISSIONS_PICKER) screen = EMPTY_COMPOSER;
        return ok();
      },
      paste: async () => ok(),
    },
  };
  return {
    deps: { pane: () => pane, capture: async () => screen },
    did,
  };
}

function session() {
  return mkSession({
    agent: "codex",
    terminals: [mkMuxHandle({ paneId: "%permission-menu" })],
  });
}

test("Codex permission selection refuses a pre-existing dialog without typing", async () => {
  const h = driven(CODEX_COMMAND_APPROVAL);

  const result = await setPermissionMode(session(), "askForApproval", h.deps);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /empty composer is not ready/);
  assert.deepEqual(h.did, []);
});

test("Codex permission selection refuses a non-empty composer without typing", async () => {
  const h = driven(`${EMPTY_COMPOSER.replace("› Ask Codex to do anything", "› unsent operator text")}`);

  const result = await setPermissionMode(session(), "askForApproval", h.deps);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /empty composer is not ready/);
  assert.deepEqual(h.did, []);
});

test("Codex permission selection verifies the command before opening its native menu", async () => {
  const h = driven(EMPTY_COMPOSER);

  const result = await setPermissionMode(session(), "askForApproval", h.deps);

  assert.deepEqual(result, { ok: true, mode: "askForApproval" });
  assert.deepEqual(h.did, ["text:/permissions", "keys:enter", "keys:enter"]);
});
