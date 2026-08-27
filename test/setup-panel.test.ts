import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SetupPanel } from "../src/web/components/SetupPanel.tsx";

test("the panel renders stable families, namespaced rows, and inert remedies", () => {
  const html = renderToStaticMarkup(createElement(SetupPanel, {
    state: {
      loading: false,
      error: null,
      refresh: async () => {},
      view: { rows: [
        {
          rowId: { source: "dependency", id: "claude-cli" },
          label: "Claude Code",
          family: "agents",
          requirement: "recommended",
          enables: "Cannot launch Claude.",
          remedy: { kind: "command", argv: ["npm", "install", "claude"], note: "Copy command" },
          status: { state: "satisfied", evidence: "/fake/claude" },
        },
        {
          rowId: { source: "dependency", id: "ai-conductor" },
          label: "ai-conductor",
          family: "pipelines",
          requirement: "optional",
          enables: "Cannot run pipelines.",
          remedy: { kind: "provider-installer", provider: "ai-conductor" },
          status: { state: "missing" },
        },
      ] },
    },
  }));
  for (const id of ["agents", "terminals", "github", "extensions", "pipelines"]) assert.match(html, new RegExp(`id="setup-family-${id}"`));
  assert.match(html, /data-anchor="setup\/dependency-claude-cli"/);
  assert.match(html, /\/fake\/claude/);
  assert.match(html, /href="#\/settings\/conductor"/);
  assert.match(html, />Re-check</);
  assert.doesNotMatch(html, />Install</);
});
