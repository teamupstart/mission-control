import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FOREMAN_INSTRUCTIONS_MAX_LENGTH } from "../src/shared/protocol.ts";
import type { ForemanInstructionsView } from "../src/shared/protocol.ts";
import {
  ForemanProfileEditor,
  foremanProfileLineSeparator,
  foremanProfileOverflowActions,
  foremanProfileResetRequest,
  foremanProfileSaveDisabled,
  isForemanProfileSaveShortcut,
  keepEditingForemanProfile,
  reconcileForemanProfileMutation,
  reconcileForemanProfileRefresh,
  reloadForemanProfile,
} from "../src/web/workflows/ForemanProfileEditor.tsx";
import { foremanMarkdownBlob } from "../src/web/workflows/foremanProfileApi.ts";
import {
  FOREMAN_PROFILE_ID,
  foremanInstructionsSourceLabel,
} from "../src/web/lib/foreman-profile.ts";
import { PersonaLibrary } from "../src/web/workflows/PersonaLibrary.tsx";
import type { PersonaView } from "../src/shared/workflow.ts";

const view = (
  etag: string,
  text: string,
  source: ForemanInstructionsView["source"] = "custom",
): ForemanInstructionsView => ({
  etag,
  text,
  defaultText: "# Built-in\n",
  source,
});

const persona: PersonaView = {
  id: "p1",
  name: "Reviewer",
  normalizedName: "reviewer",
  description: "Reviews changes",
  guidanceMarkdown: "# Review\n",
  runner: null,
  model: null,
  revision: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  provenance: null,
  builtin: true,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "claude-sonnet-5", source: "default" },
  },
};

const summary = { runner: null, models: null } as const;

function editorMarkup(): string {
  return renderToStaticMarkup(createElement(ForemanProfileEditor, {
    summary,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
    onOpenModels: () => {},
    onOpenPosture: () => {},
    onOpenTrust: () => {},
    onOpenForemanControl: () => {},
  }));
}

test("the fixed profile identity exposes only standing-guidance actions", () => {
  const html = editorMarkup();
  assert.match(html, /<h2>Foreman<\/h2>/);
  assert.match(html, />System profile</);
  assert.match(html, />Not available to workflows or ensembles</);
  assert.match(html, /Application-owned identity · operator-owned guidance/);
  assert.match(html, />Save<\/button>/);
  assert.match(html, /aria-label="More Foreman profile actions"/);
  for (const forbidden of ["Rename", "Duplicate", "Archive", "Delete", "Re-import"]) {
    assert.doesNotMatch(html, new RegExp(`>${forbidden}`));
  }
  assert.doesNotMatch(html, /aria-label="Name"|aria-label="Description"/);
});

test("Foreman is a fixed System rail group before the untouched Persona catalog", () => {
  const input = [persona];
  const html = renderToStaticMarkup(createElement(PersonaLibrary, {
    personas: input,
    providers: [],
    defaults: null,
    initialPersonaId: FOREMAN_PROFILE_ID,
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
  }));
  assert.equal(input.length, 1, "local System composition must not mutate PersonaView[]");
  const system = html.indexOf('<span>System</span>');
  const builtin = html.indexOf('<span>Built-in</span>');
  assert.ok(system > 0 && builtin > system, "System must precede the workflow Persona groups");
  assert.match(html, /1 active/);
  assert.match(html, /aria-current="true"[^]*?Foreman/);
  assert.match(html, /<h2>Foreman<\/h2>/);
});

test("source labels are the three contract states and nothing else", () => {
  assert.equal(foremanInstructionsSourceLabel("builtin"), "Built-in default");
  assert.equal(foremanInstructionsSourceLabel("custom"), "Customized");
  assert.equal(foremanInstructionsSourceLabel("none"), "No standing guidance");
});

test("focus refresh adopts clean changes and preserves dirty bytes behind a conflict", () => {
  const original = view("one", "local\r\n");
  const current = view("two", "remote\n");
  assert.deepEqual(reconcileForemanProfileRefresh({
    loaded: original,
    draft: original.text,
    dirty: false,
    conflict: null,
  }, current), {
    loaded: current,
    draft: current.text,
    dirty: false,
    conflict: null,
  });

  const dirty = reconcileForemanProfileRefresh({
    loaded: original,
    draft: " local bytes \r\n",
    dirty: true,
    conflict: null,
  }, current);
  assert.equal(dirty.draft, " local bytes \r\n");
  assert.equal(dirty.loaded, original);
  assert.equal(dirty.conflict, current);

  const sameRevision = reconcileForemanProfileRefresh({
    loaded: original,
    draft: "still local",
    dirty: true,
    conflict: null,
  }, { ...original });
  assert.equal(sameRevision.draft, "still local");
  assert.equal(sameRevision.conflict, null);
});

test("conflict choices either reload or explicitly rebase every local byte", () => {
  const original = view("one", "original");
  const current = view("two", "remote");
  const conflict = {
    loaded: original,
    draft: " local \r\n",
    dirty: true,
    conflict: current,
  };
  assert.deepEqual(reloadForemanProfile(conflict), {
    loaded: current,
    draft: "remote",
    dirty: false,
    conflict: null,
  });
  assert.deepEqual(keepEditingForemanProfile(conflict), {
    loaded: current,
    draft: " local \r\n",
    dirty: true,
    conflict: null,
  });
});

test("a save reply acknowledges its base without dropping edits made in flight", () => {
  const saved = view("two", "submitted");
  assert.deepEqual(reconcileForemanProfileMutation(saved, "submitted", 4, 4), {
    loaded: saved,
    draft: "submitted",
    dirty: false,
    conflict: null,
  });
  assert.deepEqual(reconcileForemanProfileMutation(saved, "later edit\r\n", 4, 5), {
    loaded: saved,
    draft: "later edit\r\n",
    dirty: true,
    conflict: null,
  });
});

test("save ceiling, shortcut, and line endings follow the exact document contract", () => {
  assert.equal(foremanProfileSaveDisabled({
    loaded: true,
    saving: false,
    dirty: true,
    conflicted: false,
    draftLength: FOREMAN_INSTRUCTIONS_MAX_LENGTH,
  }), false);
  assert.equal(foremanProfileSaveDisabled({
    loaded: true,
    saving: false,
    dirty: true,
    conflicted: false,
    draftLength: FOREMAN_INSTRUCTIONS_MAX_LENGTH + 1,
  }), true);
  assert.equal(isForemanProfileSaveShortcut({ metaKey: true, ctrlKey: false, key: "s" }, false), true);
  assert.equal(isForemanProfileSaveShortcut({ metaKey: false, ctrlKey: true, key: "S" }, false), true);
  assert.equal(isForemanProfileSaveShortcut({ metaKey: true, ctrlKey: false, key: "s" }, true), false);
  assert.equal(foremanProfileLineSeparator("one\r\ntwo\n"), "\r\n");
  assert.equal(foremanProfileLineSeparator("one\rtwo"), "\r");
});

test("copy/download uses exact draft text and reset is distinct from clearing", async () => {
  const exact = " \r\n# Operator\r\n\r\nCafé 😀\t \n";
  assert.equal(await foremanMarkdownBlob(exact).text(), exact);
  assert.equal(foremanMarkdownBlob(exact).type, "text/markdown;charset=utf-8");

  const builtInClean = foremanProfileOverflowActions({
    loaded: view("one", "# Built-in\n", "builtin"),
    dirty: false,
    conflicted: false,
    copyLabel: "Copy Markdown",
    onCopy: () => {},
    onDownload: () => {},
    onReset: () => {},
  });
  assert.equal(builtInClean.find((action) => action.id === "reset")?.disabled, true);
  assert.equal(builtInClean.find((action) => action.id === "copy")?.disabled, false);
  assert.equal(builtInClean.find((action) => action.id === "download")?.disabled, false);

  const request = foremanProfileResetRequest(() => {});
  assert.equal(request.danger, true);
  assert.equal(request.confirmLabel, "Reset to built-in default");
  assert.match(request.body, /Clearing and saving is different/);
});
