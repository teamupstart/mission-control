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
import { WorkflowLibrary } from "../src/web/workflows/WorkflowLibrary.tsx";
import { ExecutionPage } from "../src/web/workflows/ExecutionPage.tsx";
import { WorkflowRuns } from "../src/web/workflows/WorkflowRuns.tsx";
import {
  PersonaLibrary,
  driftTag,
  importMayReplaceEditor,
  readPersonaImport,
} from "../src/web/workflows/PersonaLibrary.tsx";
import {
  PersonaEditor,
  PersonaEditorStatus,
  isPersonaSaveShortcut,
  personaLineSeparator,
  personaSourceLine,
  projectPersonaDraftExecution,
  personaUpdatePatch,
  reconcilePersonaSave,
} from "../src/web/workflows/PersonaEditor.tsx";
import { applyExactEditorChanges } from "../src/web/components/FileEditor.tsx";
import {
  deriveImportedPersonaName,
  personaMarkdownBlob,
} from "../src/web/workflows/personaApi.ts";
import { personaDriftSurface } from "../src/web/workflows/usePersonaDrift.ts";

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
  provenance: null,
  builtin: false,
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

test("the rail's first row is the way out, above its own heading", () => {
  // The reported dead end: opening a Persona left no way back. Escape did nothing, and the
  // only control that navigated to `#/library` was the topbar chip already painted
  // `aria-current` - the page you are on, not the way out of it.
  //
  // Asserted as ORDER rather than presence. The row has to be first in reading order and
  // outside the scrolling list, or it is a control you have to already know about to find.
  const html = renderToStaticMarkup(createElement(PersonaLibrary, {
    personas: [],
    providers: PROVIDERS,
    defaults: DEFAULTS,
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
  }));
  const row = html.indexOf('aria-label="Back to Library"');
  assert.ok(row > 0, "no back row in the rail");
  assert.ok(row < html.indexOf("persona-sidebar-head"), "the back row must precede the rail heading");
  // The keystroke on the face, so Escape is taught rather than assumed.
  assert.match(html, /<kbd class="kb-hint">esc<\/kbd>/);
});

test("an empty library offers New and import without pretending workflows already execute", () => {
  const html = text(renderToStaticMarkup(createElement(PersonaLibrary, {
    personas: [],
    providers: PROVIDERS,
    defaults: DEFAULTS,
    isOverlayOpen: () => false,
    onLeave: () => {},
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

test("a selected Persona opens in the shared editor and offers preview as a separate mode", () => {
  const html = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks })));
  assert.match(html, /Revision 3/);
  assert.match(html, /Review correctness/);
  assert.match(html, /Claude Code/);
  assert.match(html, /claude-sonnet-5/);
  assert.match(html, /Editor for code-quality\.md/);
  assert.match(html, /aria-label="Persona guidance view"/);
  assert.match(html, /aria-pressed="false"[^>]*>Preview/);
  assert.match(html, /aria-pressed="true"[^>]*>Editor/);
  assert.doesNotMatch(html, /<article class="persona-markdown/, "preview is not rendered beside the editor");
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

// A built-in is read-only for a different reason than an archived Persona, and the editor has
// to say which: the operator archived one of them and did not archive the other, so an
// "Archived" sentence over a shipped Persona sends them looking for a control to undo.
test("a built-in Persona opens read-only, names why, and offers Duplicate instead of Archive", () => {
  const builtin = { ...PERSONA, builtin: true, revision: 1 };
  const html = renderToStaticMarkup(createElement(PersonaEditor, { persona: builtin, ...callbacks }));
  assert.match(html, /Built-in - this Persona ships with Mission Control/);
  assert.match(html, /Duplicate it to make a copy you own/);
  assert.match(html, /Built-in Persona</, "the eyebrow reports provenance, not a revision");
  assert.doesNotMatch(html, /Revision 1/);
  assert.match(html, /readOnly=""/);
  assert.match(html, />Duplicate<\/button>/);
  assert.doesNotMatch(html, />Archive<\/button>/);
  assert.match(html, /disabled=""/, "Save is disabled: there is nothing this editor could save");
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks })),
    /Built-in/,
    "an ordinary Persona says nothing about being built in",
  );
});

test("the library flags built-ins in the list so their read-only editor is not a surprise", () => {
  const html = renderToStaticMarkup(createElement(PersonaLibrary, {
    personas: [PERSONA, { ...PERSONA, id: "b1", name: "Code Risk Reviewer", normalizedName: "code risk reviewer", builtin: true }],
    providers: PROVIDERS,
    defaults: null,
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(html, /class="persona-list-tag">Built-in</);
  assert.equal(html.match(/persona-list-tag/g)?.length, 1, "only the built-in carries the tag");
});

const IMPORTED: PersonaView = {
  ...PERSONA,
  id: "imported",
  name: "Reviewer",
  normalizedName: "reviewer",
  provenance: {
    sourcePath: "/plugins/agent-team/references/roles/reviewer.md",
    sourceRepo: "/plugins",
    pluginVersion: "0.2.0",
    sourceKey: null,
    catalogLabel: null,
    contentSha256: "c".repeat(64),
    importedAt: Date.UTC(2026, 7, 5, 12, 0, 0),
  },
};

test("an imported Persona names its source file, its plugin version, and when it was read", () => {
  const line = personaSourceLine(IMPORTED.provenance!);
  assert.match(line, /Imported from \/plugins\/agent-team\/references\/roles\/reviewer\.md/);
  assert.match(line, /\(plugin 0\.2\.0\)/);
  const html = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: IMPORTED, ...callbacks })));
  // The full path, not a basename: two `reviewer.md` files under two plugins are the case this
  // has to tell apart, and it is what a re-import will read.
  assert.match(html, /Imported from \/plugins\/agent-team\/references\/roles\/reviewer\.md/);
  assert.match(html, />Re-import from source</);
  // A Persona with no source file offers neither.
  const authored = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks })));
  assert.doesNotMatch(authored, /Imported from/);
  assert.doesNotMatch(authored, /Re-import from source/);
  // Nor does a source-bearing Persona that is read-only: re-import is a write.
  for (const readOnly of [{ ...IMPORTED, archivedAt: 100 }, { ...IMPORTED, builtin: true }]) {
    assert.doesNotMatch(
      text(renderToStaticMarkup(createElement(PersonaEditor, { persona: readOnly, ...callbacks }))),
      /Re-import from source/,
    );
  }
});

// The status line is a precedence, not a set: exactly one sentence renders, and drift is last
// because it is the only one of the five that is not about what this editor can do right now -
// the stored guidance is intact and still what runs.
test("drift joins the status line after builtin, archived, conflict and dirty", () => {
  const base = { conflict: null, archived: false, onReload: () => {}, onDuplicate: () => {} };
  const changed = text(renderToStaticMarkup(createElement(PersonaEditorStatus, {
    ...base,
    dirty: false,
    upstream: "changed" as const,
    canReimport: true,
  })));
  assert.match(changed, /The source file has changed since this Persona was imported/);
  // States the invariant that makes adopting it safe, in the place an operator decides.
  assert.match(changed, /every published workflow version keeps what it was published with/);
  // It NAMES the header action rather than carrying a second copy of it: two identical buttons
  // on one screen make the more prominent one the one nobody can find again later.
  assert.match(changed, /Re-import from source adopts the file's current text/);
  assert.doesNotMatch(changed, /<button/);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(PersonaEditorStatus, {
      ...base,
      dirty: false,
      upstream: "changed" as const,
      canReimport: false,
    })),
    /Re-import from source/,
    "an archived or built-in row is not pointed at an action it cannot take",
  );

  // Unsaved text wins: it is about to be lost, and drift is not.
  assert.match(
    renderToStaticMarkup(createElement(PersonaEditorStatus, {
      ...base,
      dirty: true,
      upstream: "changed" as const,
      canReimport: true,
    })),
    /Unsaved changes/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(PersonaEditorStatus, {
      ...base,
      archived: true,
      dirty: false,
      upstream: "changed" as const,
    })),
    /source file has changed/,
  );

  // A missing source is worded for what it is and offers no re-import to click.
  const missing = renderToStaticMarkup(createElement(PersonaEditorStatus, {
    ...base,
    dirty: false,
    upstream: "missing" as const,
    canReimport: true,
  }));
  assert.match(missing, /cannot be read right now/);
  assert.doesNotMatch(missing, /<button/);

  // `current` says nothing at all: a badge on most of the library teaches the eye to skip it.
  assert.equal(
    renderToStaticMarkup(createElement(PersonaEditorStatus, {
      ...base,
      dirty: false,
      upstream: "current" as const,
    })),
    "",
  );
});

test("the sidebar tags a drifted Persona beside the built-in tag, and only when it drifted", () => {
  assert.equal(driftTag(undefined), null);
  assert.equal(driftTag("current"), null);
  assert.equal(driftTag("changed"), "upstream changed");
  assert.equal(driftTag("missing"), "source missing");

  const html = renderToStaticMarkup(createElement(PersonaLibrary, {
    personas: [PERSONA, IMPORTED],
    providers: PROVIDERS,
    defaults: null,
    upstream: new Map([[IMPORTED.id, "changed" as const]]),
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(html, /class="persona-list-tag is-attention">upstream changed</);
  assert.equal(html.match(/persona-list-tag/g)?.length, 1, "only the drifted row carries a tag");
  // The import-by-path controls are present and distinct from the file picker beside them.
  assert.match(html, /placeholder="\/path\/to\/role\.md"/);
  assert.match(html, />Import from path</);
  assert.match(html, />Check upstream</);
  assert.match(html, />Import \.md</);
});

/**
 * Which surface counts as "a badge is on screen here", as a pure rule.
 *
 * The drift check is keyed on this rather than on the route, because the two surfaces that render
 * these badges share one route: `#/library` draws a card per Persona and `#/library/personas`
 * draws the sidebar rows and the editor. A boolean over "am I on the Library" cannot tell an
 * arrival at one from an arrival at the other, so clicking a card to open its Persona skipped the
 * check on the surface the operator had just opened to look at.
 */
test("the drift check is keyed to the surface that renders badges, not to the Library route", () => {
  // The Library's front page renders a card per Persona.
  assert.equal(personaDriftSurface("library", null), "library-shelf");
  // The Persona authoring surface is a DIFFERENT token, so shelf -> editor is a change, and a
  // change is what re-asks the disk.
  assert.equal(personaDriftSurface("library", "personas"), "personas");
  assert.notEqual(
    personaDriftSurface("library", null),
    personaDriftSurface("library", "personas"),
  );
  // Surfaces with no upstream badge on them cost no file reads at all - and leaving one for the
  // shelf is then a null -> token transition, which fetches.
  for (const shelf of ["workflows", "actions", "ensembles", "missions"]) {
    assert.equal(personaDriftSurface("library", shelf), null);
  }
  for (const page of ["fleet", "runs", "settings", "ensembles"]) {
    assert.equal(personaDriftSurface(page, null), null);
  }
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

test("the builder and the Runs surface are both active, one home apart", () => {
  const workflows = renderToStaticMarkup(createElement(WorkflowLibrary, {
    summaries: [],
    personas: [],
    hasSnapshot: true,
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(workflows, /Build a review workflow/);
  assert.match(workflows, /New workflow/);

  const runs = renderToStaticMarkup(createElement(ExecutionPage, {
    title: "Workflow runs",
    blurb: "Every review a workflow has run.",
    children: createElement(WorkflowRuns, {
      runs: [],
      selectedRunId: null,
      onSelectRun: () => {},
    }),
  }));
  assert.match(runs, /Loading workflow runs/);
  // The eyebrow is what tells an operator arriving on a bookmark which half of the product
  // they landed in, now that no tab strip above the page says it.
  assert.match(runs, /workflow-eyebrow">Execution</);
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
