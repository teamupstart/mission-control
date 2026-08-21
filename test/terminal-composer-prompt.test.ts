import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The prompt reads the daemon-backed UI store, so stand up its two browser seams before
// importing the component. The PUT response is intentionally uneventful: updateUiConfig
// applies the patch optimistically, which is the same value the next render observes.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
});

const { TranscriptPanel } = await import("../src/web/components/TranscriptPanel.tsx");
const { resetAll, resetBinding, setBinding } = await import("../src/web/lib/keybindings.ts");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

function renderPrompt(view: "chat" | "terminal"): string {
  void updateUiConfig({ conversationView: view });
  return renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
}

beforeEach(() => {
  resetAll();
});

test("both conversation composers name the default send binding", () => {
  for (const view of ["chat", "terminal"] as const) {
    assert.match(
      renderPrompt(view),
      /<span class="pty-prompt" aria-hidden="true">mission \(s\) &gt;<\/span>/,
      view,
    );
  }
});

test("both conversation composers follow a rebound or unset send action", () => {
  setBinding("send", "shift+j");
  for (const view of ["chat", "terminal"] as const) {
    const rebound = renderPrompt(view);
    assert.match(rebound, />mission \(⇧J\) &gt;<\/span>/, view);
    assert.ok(!rebound.includes("mission (s)"), `${view}: the stale default must not remain`);
  }

  // Move Send away, let another action claim its default, then reset Send. This is the
  // real UI path to an unset action: reset cannot reclaim a default another custom
  // binding owns, so the resolved Send chord is empty.
  setBinding("queue", "s");
  resetBinding("send");
  for (const view of ["chat", "terminal"] as const) {
    const unset = renderPrompt(view);
    assert.match(unset, />mission &gt;<\/span>/, view);
    assert.ok(!unset.includes("mission ()"), `${view}: an unset action must not leave empty punctuation`);
  }
});
