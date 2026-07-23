import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type { PersonaView } from "../src/shared/workflow.ts";
import type { LlmProviderView } from "../src/shared/types.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import { WorkflowPage } from "../src/web/workflows/WorkflowPage.tsx";
import {
  PersonaLibrary,
  importMayReplaceEditor,
  readPersonaImport,
} from "../src/web/workflows/PersonaLibrary.tsx";
import {
  PersonaEditor,
  PersonaEditorStatus,
  isPersonaSaveShortcut,
  personaLineSeparator,
  projectPersonaDraftExecution,
  personaUpdatePatch,
  reconcilePersonaSave,
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

const CLAUDE_RUNNER = { id: "claude", source: "default", unknown: null } as const;
const CODEX_RUNNER = { id: "codex", source: "config", unknown: null } as const;
const DEFAULTS = {
  runner: CLAUDE_RUNNER,
  models: {
    claude: { id: "persona-env-model", source: "env" },
    codex: { id: "persona-env-model", source: "env" },
  },
} as const;
const LLM_STATE: LlmState = {
  config: null,
  status: null,
  personaDefaults: DEFAULTS,
  update: async () => {},
  error: null,
};

const callbacks = {
  providers: PROVIDERS,
  defaults: DEFAULTS,
  isOverlayOpen: () => false,
  onDirtyChange: () => {},
  onDraftEdit: () => {},
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
    defaults: DEFAULTS,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
  })));
  assert.match(html, /No saved Personas yet/);
  assert.match(html, /Import \.md/);
  assert.match(html, /Choose a Persona/);
  const editor = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: null, ...callbacks })));
  assert.match(editor, /New Persona/);
});

test("an unsaved Persona uses the resolved app runner and its model defaults", () => {
  const defaults = {
    runner: CODEX_RUNNER,
    models: {
      claude: { id: "claude-from-env", source: "env" as const },
      codex: { id: "codex-from-env", source: "env" as const },
    },
  };
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
    defaults,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
    onDraftEdit: () => {},
    onSaved: () => {},
    onDuplicate: () => {},
    onArchive: () => {},
  }));
  assert.match(text(html), /Codex/);
  assert.match(text(html), /codex-from-env/);
  assert.doesNotMatch(text(html), /claude-sonnet-5/);
  assert.doesNotMatch(text(html), /App default after save/);
});

test("an explicit unsaved model overrides the server-resolved Persona default", () => {
  const projection = projectPersonaDraftExecution(null, {
    name: "Draft",
    description: "",
    guidanceMarkdown: "# Exact\r\n",
    runner: "codex",
    model: "gpt-explicit",
  }, DEFAULTS);
  assert.deepEqual(projection, {
    runner: "codex",
    model: { id: "gpt-explicit", source: "config" },
  });
});

test("editing an unknown-runner Persona retains its server-resolved provider", () => {
  const unknown = {
    ...PERSONA,
    runner: "future-provider" as never,
    model: "old-model",
    execution: {
      runner: { id: "claude" as const, source: "default" as const, unknown: "future-provider" },
      model: { id: "old-model", source: "config" as const },
    },
  };
  const projection = projectPersonaDraftExecution(unknown, {
    name: unknown.name,
    description: unknown.description,
    guidanceMarkdown: unknown.guidanceMarkdown,
    runner: unknown.runner,
    model: null,
  }, {
    runner: CODEX_RUNNER,
    models: {
      claude: { id: "claude-resolved", source: "env" },
      codex: { id: "codex-resolved", source: "env" },
    },
  });
  assert.deepEqual(projection, {
    runner: "claude",
    model: { id: "claude-resolved", source: "env" },
  });
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

test("save reconciliation preserves edits made while the request is in flight", () => {
  const submitted = {
    name: PERSONA.name,
    description: PERSONA.description,
    guidanceMarkdown: PERSONA.guidanceMarkdown,
    runner: PERSONA.runner,
    model: PERSONA.model,
  };
  const current = { ...submitted, guidanceMarkdown: "# Newer\r\n\r\nExact  \r\n" };
  const saved = { ...PERSONA, name: "Code Quality copy", revision: 4 };
  assert.deepEqual(reconcilePersonaSave(saved, submitted, current, 7, 8), {
    draft: {
      ...submitted,
      name: "Code Quality copy",
      guidanceMarkdown: current.guidanceMarkdown,
    },
    dirty: true,
  });
  assert.deepEqual(reconcilePersonaSave(saved, submitted, submitted, 7, 7), {
    draft: {
      ...submitted,
      name: "Code Quality copy",
    },
    dirty: false,
  });

  const library = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/PersonaLibrary.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(library, /key=\{editorKey\}/);
});

test("import replaces editor identity only when no concurrent workspace edit occurred", () => {
  assert.equal(importMayReplaceEditor(4, 4), true);
  assert.equal(importMayReplaceEditor(4, 5), false);

  const library = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/PersonaLibrary.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(library, /importMayReplaceEditor\(startedAtGeneration, editorGeneration\.current\)/);
  assert.match(library, /setEditorKey\(\(key\) => key \+ 1\)/);
});

test("Workflows is active in Phase 2 while Runs remains an honest Phase 3 shell", () => {
  const workflows = renderToStaticMarkup(createElement(WorkflowPage, {
    tab: "workflows",
    personas: [],
    llm: LLM_STATE,
    isOverlayOpen: () => false,
    onTab: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(workflows, /Build a review workflow/);
  assert.match(workflows, /New workflow/);

  const runs = renderToStaticMarkup(createElement(WorkflowPage, {
    tab: "runs",
    personas: [],
    llm: LLM_STATE,
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

test("Persona import rejects oversized files before reading and rechecks decoded bytes", async () => {
  let read = false;
  await assert.rejects(
    readPersonaImport({
      size: WORKFLOW_LIMITS.personaGuidanceBytes + 1,
      text: async () => {
        read = true;
        return "too late";
      },
    }),
    /exceeds 100000 UTF-8 bytes/,
  );
  assert.equal(read, false);

  await assert.rejects(
    readPersonaImport({
      size: WORKFLOW_LIMITS.personaGuidanceBytes,
      text: async () => "é".repeat(WORKFLOW_LIMITS.personaGuidanceBytes / 2 + 1),
    }),
    /exceeds 100000 UTF-8 bytes/,
  );

  const exact = "# Exact\r\n\r\nTrailing space  \r\n";
  assert.equal(await readPersonaImport({ size: exact.length, text: async () => exact }), exact);
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
