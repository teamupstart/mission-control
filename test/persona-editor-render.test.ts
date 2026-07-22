import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import type { PersonaView } from "../src/shared/workflow.ts";
import type { LlmProviderView } from "../src/shared/types.ts";
import { WorkflowPage } from "../src/web/workflows/WorkflowPage.tsx";
import { PersonaLibrary } from "../src/web/workflows/PersonaLibrary.tsx";
import {
  PersonaEditor,
  PersonaEditorStatus,
  isPersonaSaveShortcut,
  personaLineSeparator,
  personaUpdatePatch,
} from "../src/web/workflows/PersonaEditor.tsx";
import { applyExactEditorChanges } from "../src/web/components/FileEditor.tsx";
import {
  deriveImportedPersonaName,
  personaMarkdownBlob,
} from "../src/web/workflows/personaApi.ts";

// What is at stake: Phase 1 ships an editor, not only routes. Its empty, conflict, and archive
// states must say what will happen before a click, while the selected state must expose every
// exact-Markdown escape hatch without waiting for browser-only automation.

const PERSONA: PersonaView = {
  id: "p1",
  name: "Code Quality",
  normalizedName: "code quality",
  description: "Review correctness",
  guidanceMarkdown: "# Exact guidance\n\nKeep this.",
  runner: null,
  model: null,
  revision: 3,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "claude-sonnet-5", source: "default" },
  },
};

const PROVIDERS: LlmProviderView[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const callbacks = {
  providers: PROVIDERS,
  isOverlayOpen: () => false,
  onDirtyChange: () => {},
  onSaved: () => {},
  onDuplicate: () => {},
  onArchive: () => {},
};

function text(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

test("an empty library offers New and import without pretending workflows already execute", () => {
  const html = text(renderToStaticMarkup(createElement(PersonaLibrary, {
    personas: [],
    providers: PROVIDERS,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
  })));
  assert.match(html, /No saved Personas yet/);
  assert.match(html, /Import \.md/);
  assert.match(html, /Choose a Persona/);
  const editor = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: null, ...callbacks })));
  assert.match(editor, /New Persona/);
});

test("an unsaved Persona does not invent the app's effective provider", () => {
  const html = renderToStaticMarkup(createElement(PersonaEditor, {
    persona: null,
    seed: {
      name: "Draft",
      description: "",
      guidanceMarkdown: "# Exact\n",
      runner: null,
      model: null,
    },
    providers: PROVIDERS,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
    onSaved: () => {},
    onDuplicate: () => {},
    onArchive: () => {},
  }));
  assert.match(text(html), /App default after save/);
});

test("a selected Persona renders metadata, effective values, editor, preview, and exact exports", () => {
  const html = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks })));
  assert.match(html, /Revision 3/);
  assert.match(html, /Review correctness/);
  assert.match(html, /Claude Code/);
  assert.match(html, /claude-sonnet-5/);
  assert.match(html, /Editor for code-quality\.md/);
  assert.match(html, /Exact guidance/);
  assert.match(html, /Copy Markdown/);
  assert.match(html, /Download \.md/);
  assert.match(html, /Duplicate/);
  assert.match(html, /Archive/);
});

test("Persona provider labels come from the LLM provider catalog", () => {
  const providers: LlmProviderView[] = [
    { id: "claude", label: "Batch Claude" },
    { id: "codex", label: "Batch Codex" },
  ];
  const html = text(renderToStaticMarkup(createElement(PersonaEditor, {
    persona: PERSONA,
    ...callbacks,
    providers,
  })));
  assert.match(html, /Batch Claude/);
  assert.match(html, /Batch Codex/);
  assert.doesNotMatch(html, /Claude Code/);
});

test("dirty, conflict, and archived states are explicit and actionable", () => {
  const dirty = renderToStaticMarkup(createElement(PersonaEditorStatus, {
    dirty: true,
    conflict: null,
    archived: false,
    onReload: () => {},
    onDuplicate: () => {},
  }));
  assert.match(dirty, /Unsaved changes/);

  const conflict = renderToStaticMarkup(createElement(PersonaEditorStatus, {
    dirty: true,
    conflict: PERSONA,
    archived: false,
    onReload: () => {},
    onDuplicate: () => {},
  }));
  assert.match(conflict, /local Markdown has not been changed/);
  assert.match(conflict, /Reload latest/);
  assert.match(conflict, /Save as duplicate/);

  const archived = { ...PERSONA, archivedAt: 100 };
  const html = renderToStaticMarkup(createElement(PersonaEditor, { persona: archived, ...callbacks }));
  assert.match(html, /Archived - this Persona is read-only/);
  assert.match(html, /readOnly=""/);
  assert.doesNotMatch(html, />Archive<\/button>/);
});

test("an unknown stored provider is reported and survives an unrelated edit", () => {
  const unknown = {
    ...PERSONA,
    runner: "future-provider" as never,
    execution: {
      ...PERSONA.execution,
      runner: { id: "claude" as const, source: "default" as const, unknown: "future-provider" },
    },
  };
  const html = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: unknown, ...callbacks })));
  assert.match(html, /Unavailable: future-provider/);
  assert.match(html, /Unknown stored provider “future-provider” fell back/);
  assert.deepEqual(
    personaUpdatePatch(unknown, {
      name: unknown.name,
      description: "Changed",
      guidanceMarkdown: unknown.guidanceMarkdown,
      runner: unknown.runner,
      model: unknown.model,
    }, unknown.revision),
    { expectedRevision: 3, description: "Changed" },
  );
});

test("Workflows and Runs tabs are honest Phase 1 shells", () => {
  const workflows = renderToStaticMarkup(createElement(WorkflowPage, {
    tab: "workflows",
    personas: [],
    connected: true,
    isOverlayOpen: () => false,
    onTab: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(workflows, /arrives in Phase 2/);
  assert.match(workflows, /not active yet/);

  const runs = renderToStaticMarkup(createElement(WorkflowPage, {
    tab: "runs",
    personas: [],
    connected: true,
    isOverlayOpen: () => false,
    onTab: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(runs, /No workflow runs yet/);
  assert.match(runs, /arrive in Phase 3/);
});

test("Markdown import derives a name without changing the body", () => {
  const markdown = "preface\r\n# Imported Quality\r\n\r\nExact body  \r\n";
  assert.equal(deriveImportedPersonaName("fallback.md", markdown), "Imported Quality");
  assert.equal(deriveImportedPersonaName("fallback.md", "No H1"), "fallback");
  assert.equal(markdown, "preface\r\n# Imported Quality\r\n\r\nExact body  \r\n");
});

test("Markdown export encodes the exact accepted text", async () => {
  const markdown = "# Exact\r\n\r\nTrailing space  \r\n\u0000";
  assert.deepEqual(
    new Uint8Array(await personaMarkdownBlob(markdown).arrayBuffer()),
    new TextEncoder().encode(markdown),
  );
});

test("the shared editor serializes CRLF Persona edits without newline normalization", () => {
  const markdown = "# Exact\r\n\r\nKeep CRLF\r\n";
  const lineSeparator = personaLineSeparator(markdown);
  const state = EditorState.create({
    doc: markdown,
    extensions: [EditorState.lineSeparator.of(lineSeparator)],
  });
  assert.equal(state.sliceDoc(), markdown);
});

test("the shared editor preserves mixed source line endings outside the changed range", () => {
  const markdown = "# Exact\r\n\r\nMixed\nending\r";
  const state = EditorState.create({ doc: markdown });
  const transaction = state.update({ changes: { from: 2, to: 7, insert: "Precise" } });
  assert.equal(
    applyExactEditorChanges(markdown, state, transaction.changes, "\r\n"),
    "# Precise\r\n\r\nMixed\nending\r",
  );
});

test("the shared editor maps multiple exact changes across mixed line endings", () => {
  const markdown = "one\r\ntwo\nthree\rfour";
  const state = EditorState.create({ doc: markdown });
  const transaction = state.update({
    changes: [
      { from: 0, to: 3, insert: "1" },
      { from: 8, to: 13, insert: "3" },
    ],
  });
  assert.equal(
    applyExactEditorChanges(markdown, state, transaction.changes),
    "1\r\ntwo\n3\rfour",
  );
});

test("Persona save owns Cmd/Ctrl+S without claiming plain S", () => {
  assert.equal(isPersonaSaveShortcut({ metaKey: true, ctrlKey: false, key: "s" }, false), true);
  assert.equal(isPersonaSaveShortcut({ metaKey: false, ctrlKey: true, key: "S" }, false), true);
  assert.equal(isPersonaSaveShortcut({ metaKey: false, ctrlKey: false, key: "s" }, false), false);
  assert.equal(isPersonaSaveShortcut({ metaKey: true, ctrlKey: false, key: "s" }, true), false);
});
