# Phase 4: Automatic Persona import from installed plugin catalogs

## The gap this closed

Phase 3 shipped Persona import with provenance and drift, and stopped one step short of being
useful: import was one operator, naming one absolute path, one document at a time. Nothing
discovered anything. An operator with UpstartClaw installed saw an empty Persona library and no
indication that eleven ready-made review roles were sitting on their disk.

They were also hard to find at all, which is worth recording because it shaped the scope. Nothing
in `teamupstart/claude-code-extensions` is called a persona. The documents are **role** files
under `plugins/agent-team/references/roles/*.md`, loaded by that plugin's own skills rather than
registered as Claude Code subagents. A search for "persona", or for `agents/`, misses them
entirely.

## Decisions

- **Only `agent-team`'s eleven roles.** The eight `plugins/*/agents/*.md` subagents elsewhere in
  that marketplace are tool-scoped task workers - a cluster debugger, a skill builder - with no
  review remit. Importing them would fill a reviewer library with personas nobody would pick.
  `test/plugin-persona-sync.test.ts` asserts the registry holds exactly the one entry, so this
  decision has to be argued rather than drifted past.
- **Installed means installed.** Detection reads Claude Code's `installed_plugins.json`. The
  marketplace checkout is not evidence, matching `environment-checks.test.ts`'s existing
  assertion "the marketplace alone is not the plugin" - it contains all ~64 plugins, so treating
  it as an install would hand personas to operators who never asked.
- **Import at boot, silently, and let archiving be the "no".** Per the operator's decision: they
  appear in the library, wear an `UpstartClaw` tag, sort after the built-ins, and archiving one
  keeps it gone.
- **Never adopt upstream changes automatically.** A changed role document raises the existing
  drift badge. A boot that rewrote a reviewer's authority is precisely the surprise phase 3's
  provenance exists to prevent.
- **No catalog content in this repository**, unchanged from phase 3. The documents are read from
  the operator's installed plugin, which is what lets the drift badge mean anything.

## Shape, and the constraint that forced it

`persona-import.ts` already stated the rule: "No plugin name, no marketplace lookup, and nothing
specific to any one plugin - Mission Control is a generic product and an `if (upstart)` branch is
exactly what this may not become." `environment-checks.ts` states the same rule for its own
registry. So the vendor's name lives in exactly one new file and the machinery around it is
written against a shape:

| File | Role |
| --- | --- |
| `src/server/plugins/installed-plugins.ts` | Parses `installed_plugins.json`. Honors `CLAUDE_CONFIG_DIR`. Knows no plugin names. |
| `src/server/plugins/persona-source-registry.ts` | **The only file that says `agent-team` / `upstartclaw` / `UpstartClaw`.** |
| `src/server/plugins/persona-sources.ts` | Folds the registry over the install record and enumerates `.md` documents. |
| `PersonaManager.syncFromPluginCatalogs` | Reconciles what was found against the catalog. |

Adding a second catalog is one entry in the registry and no other change.

## Identity is `sourceKey`, not `sourcePath`

The one non-obvious piece. An installed plugin lives at
`…/cache/<marketplace>/<plugin>/<version>/…`, so **the path of a role document changes on every
plugin upgrade**. Keyed on `sourcePath`, the sync finds no match after an upgrade and imports all
eleven roles again under conflicting names.

So `PersonaProvenance` gained `sourceKey` - `<marketplace>/<plugin>/<path within the plugin>`,
version segment deliberately omitted - and `catalogLabel`, the string a UI credits. Both are
additive: provenance is a JSON blob (`personas.import_provenance_json`), so **no schema
migration**. Both default to `null` in `PersonaProvenanceSchema`, which is what keeps blobs
written by earlier builds parseable - without the default, the store's tolerant reader would
degrade every pre-existing provenance record to null and silently strip working badges.

## Reconciliation

`store.personaSourceKeys()` reports every catalog identity the database has *decided about*,
**archived rows included**. Three cases fall out of that one lookup:

| State | Action |
| --- | --- |
| Key unknown | Import, with catalog provenance |
| Key present, live | Skip. Upstream changes surface as drift, for a human |
| Key present, archived | Skip, permanently. The operator said no |

Failures are per-document and reported, never thrown: a name the operator already owns, a
document that stopped being readable, a directory that moved. Each costs one Persona rather than
the boot or the other ten. Name conflicts are an expected outcome, not an error - these roles
carry plain titles like `Reviewer` - and the operator's row always wins.

## Naming

Role documents lead with frontmatter (`slug`, `role-title`, `function`). Deriving from the
Markdown instead would name the reviewer `The Reviewer` from the `# The Reviewer` heading and
describe it as `**Speech pattern:** Terse, declarative, verdict first.` So
`personaNameFromDocument` / `personaDescriptionFromDocument` prefer `role-title` and `function`,
falling back to the heading rules for any document without frontmatter.

Applied to hand-import too, not only to the sync. Two derivations would meet at the unique index
and present as a name conflict nobody caused. The guidance Markdown still stores the **exact
bytes**, frontmatter included, because that is what the drift hash is taken over.

## Ordering

`sortPersonas` gained an origin tier ahead of the name comparison: shipped, then
catalog-supplied, then the operator's own. Applied in the store, where `listPersonas` and
`personaCatalog` both pass through, so no surface can disagree. Name and id still decide within a
tier, so ordering stays total and two Personas of one origin sort exactly as before.

## Two bugs the tests caught

Worth recording, because both failed in the quiet direction:

1. `CLAUDE_CONFIG_DIR` was read through this codebase's `envVar` helper, which resolves only
   `MISSION_*` / `FLEET_*` / `HARNESS_*` prefixes - so it read nothing, and a relocated Claude
   config would have looked like a machine with no plugins installed.
2. `provenance.pluginVersion` came only from the document's plugin manifest, recording `null`
   when the manifest could not be read even though the install record knew the version. The
   manifest stays authoritative; the record is now the fallback.

## Verification

`test/plugin-persona-sync.test.ts` - 21 tests: install-record parsing (scopes, malformed entries,
unrecognised shapes, `@` in plugin names, `CLAUDE_CONFIG_DIR`), enumeration (order, one level
deep, absent directory, not installed), frontmatter derivation, origin ordering, and the
reconciliation matrix - first import, second sync, plugin upgrade, archived, operator-edited, name
conflict, one unreadable document among good ones, and the no-catalog case every machine outside
Upstart is in.

## Known gap

No UI surface reports what the sync skipped; it goes to the daemon log. An operator whose own
`Reviewer` won a conflict sees a library that is short one role and nothing in the app saying
why. A library notice is the natural follow-up.
