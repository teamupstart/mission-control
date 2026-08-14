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
import { WorkflowLibrary } from "../src/web/workflows/WorkflowLibrary.tsx";
import { ExecutionPage } from "../src/web/workflows/ExecutionPage.tsx";
import { WorkflowRuns } from "../src/web/workflows/WorkflowRuns.tsx";
import {
  PersonaLibrary,
  driftTag,
  groupPersonas,
  importMayReplaceEditor,
  readPersonaImport,
} from "../src/web/workflows/PersonaLibrary.tsx";
import {
  PersonaEditor,
  PersonaEditorStatus,
  PersonaProviderControl,
  isPersonaSaveShortcut,
  personaLineSeparator,
  personaOverflowActions,
  personaRoutingSource,
  personaSourceLine,
  projectPersonaDraftExecution,
  personaUpdatePatch,
  reconcilePersonaSave,
} from "../src/web/workflows/PersonaEditor.tsx";
import { personaRoutingLabel } from "../src/web/library/library-model.ts";
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

/**
 * The classes on the property chip carrying `key`.
 *
 * The chip's STATE is the assertion worth making about it - quiet when the value is
 * inherited, solid when this Persona overrides it - and it lives in the class rather than
 * in any text, because the whole point is that you read it without opening anything.
 */
function chipClass(html: string, key: string): string {
  const at = html.indexOf(`<span class="lib-chip-k">${key}</span>`);
  assert.ok(at > 0, `no ${key} chip on this editor`);
  const start = html.lastIndexOf('class="lib-chip', at) + 'class="'.length;
  return html.slice(start, html.indexOf('"', start));
}

const OVERFLOW = {
  copyLabel: "Copy Markdown",
  sourcePath: "/plugins/agent-team/references/roles/reviewer.md",
  onCopy: () => {},
  onDownload: () => {},
  onDuplicate: () => {},
  onReimport: () => {},
  onArchive: () => {},
};

function overflowLabels(over: Record<string, unknown> = {}): string[] {
  return personaOverflowActions({
    persona: true,
    builtin: false,
    archived: false,
    canReimport: false,
    ...OVERFLOW,
    ...over,
  }).map((action) => action.label);
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
  // ONE promoted verb. The other four are behind the menu, which is shut - asserted as
  // absent BUTTONS rather than absent text, because the trigger's tooltip names them all
  // and matching that would pass whether they were reachable or not.
  assert.match(html, />Save<\/button>/);
  assert.match(html, /aria-label="More Persona actions"/);
  for (const hidden of [/>Copy Markdown<\/button>/, />Download \.md<\/button>/, />Duplicate<\/button>/, />Archive<\/button>/]) {
    assert.doesNotMatch(html, hidden, "a menu action is on the header rather than in the menu");
  }
  assert.deepEqual(overflowLabels(), ["Copy Markdown", "Download .md", "Duplicate", "Archive"]);
});

test("the menu holds exactly the verbs this Persona can take, under their own names", () => {
  // Their placement changed and nothing else did, so this is asserted about the actions
  // rather than the row: which verbs a built-in, an archived row and an unsaved draft each
  // offer is behaviour, and it is the part a rearrangement can silently drop.
  assert.deepEqual(
    overflowLabels({ canReimport: true }),
    ["Copy Markdown", "Download .md", "Duplicate", "Re-import from source", "Archive"],
  );
  // A read-only Persona promotes Duplicate, so the menu does not offer it a second time,
  // and it has nothing to archive or re-import.
  assert.deepEqual(overflowLabels({ builtin: true }), ["Copy Markdown", "Download .md"]);
  assert.deepEqual(overflowLabels({ archived: true }), ["Copy Markdown", "Download .md"]);
  // A draft that was never saved can be copied and downloaded, and is nothing else yet.
  assert.deepEqual(overflowLabels({ persona: false }), ["Copy Markdown", "Download .md"]);
  // Copy keeps the menu open: the confirmation IS the row's label, so closing on the click
  // would take the only sign the control did anything.
  const copy = personaOverflowActions({
    persona: true,
    builtin: false,
    archived: false,
    canReimport: false,
    ...OVERFLOW,
  }).find((action) => action.id === "copy");
  assert.equal(copy?.keepOpen, true);
  assert.equal(
    personaOverflowActions({
      persona: true,
      builtin: false,
      archived: false,
      canReimport: false,
      ...OVERFLOW,
      copyLabel: "Copied",
    })[0]?.label,
    "Copied",
  );
});

test("a property chip is quiet when it inherits and solid when this Persona overrides", () => {
  const inherited = renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks }));
  assert.equal(chipClass(inherited, "provider"), "lib-chip is-inherited");
  assert.equal(chipClass(inherited, "model"), "lib-chip is-inherited");
  // The read-only pair are readouts, not settings, and never claim to be either state.
  assert.equal(chipClass(inherited, "source"), "lib-chip is-readonly");
  assert.equal(chipClass(inherited, "utf-8 bytes"), "lib-chip is-readonly is-trailing");
  assert.match(inherited, /<span class="lib-chip-v">app defaults<\/span>/);

  const overridden = renderToStaticMarkup(createElement(PersonaEditor, {
    persona: {
      ...PERSONA,
      runner: "codex" as const,
      model: "gpt-explicit",
      execution: {
        runner: { id: "codex" as const, source: "config" as const, unknown: null },
        model: { id: "gpt-explicit", source: "config" as const },
      },
    },
    ...callbacks,
  }));
  assert.equal(chipClass(overridden, "provider"), "lib-chip is-overridden");
  assert.equal(chipClass(overridden, "model"), "lib-chip is-overridden");
  assert.match(overridden, /<span class="lib-chip-v">this Persona<\/span>/);

  // Which is what the `source` chip is for: provider and model read as a resolved value
  // either way, so without it the row cannot tell "Codex because this says so" from
  // "Codex because that is what the app is set to".
  const nothingOverridden = { runner: null, model: null };
  assert.equal(personaRoutingSource(nothingOverridden, { id: "m", source: "default" }), "app defaults");
  assert.equal(personaRoutingSource(nothingOverridden, { id: "m", source: "config" }), "app settings");
  assert.equal(
    personaRoutingSource(nothingOverridden, { id: "m", source: "env" }),
    "the daemon's environment",
  );
  assert.equal(personaRoutingSource(nothingOverridden, undefined), "resolves after save");
  assert.equal(personaRoutingSource({ runner: "codex", model: null }, undefined), "this Persona");
});

test("the byte count is a chip, and it still says when it is over the limit", () => {
  const under = renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks }));
  assert.match(under, /<span class="lib-chip-v mono">28 \/ 100,000<\/span>/);
  assert.equal(chipClass(under, "utf-8 bytes"), "lib-chip is-readonly is-trailing");
  // It left the file toolbar rather than being drawn in both places.
  assert.doesNotMatch(under, /class="file-size/);

  const over = renderToStaticMarkup(createElement(PersonaEditor, {
    persona: { ...PERSONA, guidanceMarkdown: "a".repeat(WORKFLOW_LIMITS.personaGuidanceBytes + 1) },
    ...callbacks,
  }));
  assert.equal(chipClass(over, "utf-8 bytes"), "lib-chip is-readonly is-danger is-trailing");
  assert.match(over, /100,001 \/ 100,000/);
  // And Save cannot be pressed while it is, exactly as before.
  assert.match(over, /<button class="btn" disabled=""[^>]*>Save<\/button>/);
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
  // The chip's face carries the RESOLVED provider, under the catalog's label for it.
  assert.match(html, /<span class="lib-chip-v">Batch Claude<\/span>/);
  assert.doesNotMatch(html, /Claude Code/);
  // Every other provider is one click away, in the control the chip opens. Rendered
  // directly because a shut popover renders nothing and `renderToStaticMarkup` runs no
  // effect, so there is no way to open the real one here.
  const control = text(renderToStaticMarkup(createElement(PersonaProviderControl, {
    providers,
    value: null,
    disabled: false,
    onChange: () => {},
  })));
  assert.match(control, /Batch Claude/);
  assert.match(control, /Batch Codex/);
  assert.match(control, />App default</, "inheriting stays a choice you can go back to");
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
  assert.match(html, /class="lib-tag lib-tag-builtin">built-in</, "the title says so beside the name");
  // The promoted verb is the one that does something. Save is not disabled here, it is not
  // offered: it sat first in the row permanently greyed out on all four built-ins, which
  // reads as "the thing you want, unavailable" when the thing you want is Duplicate.
  assert.match(html, />Duplicate to edit<\/button>/);
  assert.doesNotMatch(html, />Save<\/button>/);
  assert.doesNotMatch(html, />Archive<\/button>/);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks })),
    /Built-in/,
    "an ordinary Persona says nothing about being built in",
  );
});

const SHIPPED: PersonaView = {
  ...PERSONA,
  id: "b1",
  name: "Code Risk Reviewer",
  normalizedName: "code risk reviewer",
  builtin: true,
};

function rail(personas: PersonaView[], over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PersonaLibrary, {
    personas,
    providers: PROVIDERS,
    defaults: null,
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
    ...over,
  }));
}

function groupHead(label: string, count: number): RegExp {
  return new RegExp(
    `<h4 class="lib-rail-group"><span>${label}</span><span class="lib-rail-group-count">${count}</span></h4>`,
  );
}

test("the rail separates what shipped with the build from what you wrote", () => {
  // The fault: four shipped Personas in a flat list read as things you had written and
  // forgotten. A tag on each row said otherwise in 9.5px; the head says it once, and also
  // answers the question the tag never could - have I written any of these yet?
  const html = rail([PERSONA, SHIPPED]);
  assert.match(html, groupHead("Built-in", 1));
  assert.match(html, groupHead("Yours", 1));
  assert.doesNotMatch(html, /class="lib-rail-tag">Built-in</, "the head says it, so the row does not");

  // Not merely present - the shipped row is UNDER the head that claims it, and Built-in
  // leads, so the four rows a person did not write stop being the first thing they scan.
  const order = ["Built-in", "Code Risk Reviewer", "Yours", "Code Quality"].map((needle) => {
    const at = html.indexOf(needle);
    assert.ok(at > 0, `${needle} is missing from the rail`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the rail's groups are out of order");
});

test("grouping is about where a row is drawn, never about which row wins", () => {
  // A built-in shadowed by a same-named Persona of yours resolves to yours, and that
  // decision belongs to `personasForDisplay` - which has already made it by the time these
  // rows are split. The group a row lands in must not be a second opinion about it.
  const shadowing: PersonaView = { ...PERSONA, id: "mine", name: "CODE RISK REVIEWER", normalizedName: "code risk reviewer" };
  const html = rail([SHIPPED, shadowing]);
  assert.equal(
    html.match(/class="persona-list-item lib-rail-row/g)?.length,
    1,
    "the shadowed built-in still drew a row",
  );
  assert.match(html, groupHead("Yours", 1));
  assert.doesNotMatch(html, groupHead("Built-in", 1));

  assert.deepEqual(groupPersonas([SHIPPED, PERSONA]), { builtin: [SHIPPED], yours: [PERSONA] });
  assert.deepEqual(groupPersonas([]), { builtin: [], yours: [] });
});

test("an empty Yours group says what to do about it, and only where that is true", () => {
  const nothingYet = rail([SHIPPED]);
  assert.match(nothingYet, groupHead("Yours", 0));
  assert.match(nothingYet, /Duplicate a built-in to start from its standards/);

  // Not under a search, where it would be a claim about the library rather than about the
  // filter, and not with the list empty, where the line below already says it in the right
  // words for the state.
  assert.doesNotMatch(rail([]), /Duplicate a built-in to start from its standards/);
  assert.match(rail([]), /No saved Personas yet/);
});

test("a rail row's sub-label is the runner and model, from the one helper that formats them", () => {
  // The description sat here, and on the shipped four it is the title again in a longer
  // sentence. What tells two reviewers apart is what they run as - and the palette row
  // says the same thing about the same Persona, so both read it from the same place.
  const html = rail([PERSONA]);
  assert.equal(personaRoutingLabel(PERSONA), "claude · claude-sonnet-5");
  assert.match(html, /<small class="lib-rail-row-detail mono">claude · claude-sonnet-5<\/small>/);
  assert.doesNotMatch(html, /<small[^>]*>Review correctness</, "the description is not the sub-label");
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
  // Still exactly one path, and still in a `p.persona-source` beside the revision rather
  // than folded into it: the import spec reads the two out separately.
  assert.match(html, /<p class="workflow-eyebrow">Revision 3<\/p>/);
  assert.equal(html.match(/class="persona-source/g)?.length, 1);

  // Re-import is now a menu row. It is offered to exactly the Personas it was offered to
  // before - not to one with no source file, and not to a read-only one, because it writes.
  assert.ok(overflowLabels({ canReimport: true }).includes("Re-import from source"));
  assert.ok(!overflowLabels({ canReimport: false }).includes("Re-import from source"));
  const authored = text(renderToStaticMarkup(createElement(PersonaEditor, { persona: PERSONA, ...callbacks })));
  assert.doesNotMatch(authored, /Imported from/);
  assert.doesNotMatch(authored, /Re-import from source/);
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

  const html = rail([PERSONA, IMPORTED], { upstream: new Map([[IMPORTED.id, "changed" as const]]) });
  assert.match(html, /class="lib-rail-tag is-attention">upstream changed</);
  assert.equal(html.match(/lib-rail-tag/g)?.length, 1, "only the drifted row carries a tag");
  // Import and the archived filter moved below the list, and every one of them still
  // works: the rail footer is a relocation, not a reduction.
  assert.match(html, /placeholder="\/path\/to\/role\.md"/);
  assert.match(html, />Import from path</);
  assert.match(html, />Check upstream</);
  assert.match(html, />Import \.md</);
  assert.match(html, /aria-pressed="false"[^>]*>Archived /);
  const list = html.indexOf('class="persona-list"');
  assert.ok(list > 0 && list < html.indexOf("persona-rail-foot"), "the footer must follow the list");
  assert.ok(
    html.indexOf('class="persona-search"') < list,
    "the search box is the last thing above the list",
  );
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
  // On the face, not inside the provider chip's popover: a shut chip reading "Claude Code"
  // would report the fallback as though it were the setting.
  assert.match(html, /Unknown stored provider “future-provider” fell back/);
  // And the id this build cannot resolve stays listed in the control, disabled, rather than
  // silently vanishing from the picker that is supposed to show what is stored.
  const control = text(renderToStaticMarkup(createElement(PersonaProviderControl, {
    providers: PROVIDERS,
    value: "future-provider",
    disabled: false,
    onChange: () => {},
  })));
  assert.match(control, /Unavailable: future-provider/);
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
