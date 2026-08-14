// The ONE file in the daemon that names a plugin, a marketplace, or a vendor.
//
// It exists for the same reason `src/server/environment/` exists, and follows the same rule:
// Mission Control is a generic product, and an organisation-specific fact belongs in exactly
// one place that the generic machinery folds over. `persona-import.ts` says it outright - "no
// plugin name, no marketplace lookup, and nothing specific to any one plugin … an `if (upstart)`
// branch is exactly what this may not become" - so the discovery, reading, naming and
// reconciliation around this list are all written against the SHAPE below and never against its
// contents.
//
// What that buys, concretely: an operator on a machine with none of these plugins installed gets
// silence, because the enumeration finds nothing rather than because anything special-cased
// them. Adding a second catalog is an entry here and no other change.
//
// The entry below was verified against `agent-team` 0.1.1-beta in
// `teamupstart/claude-code-extensions`, whose eleven role documents live in
// `references/roles/*.md` and carry `slug` / `role-title` / `function` frontmatter. They are
// reference documents loaded by that plugin's own skills rather than Claude Code subagents, which
// is why they are addressed by directory here and not through the `agents/` convention: the
// `agents/*.md` files elsewhere in that marketplace are tool-scoped task workers with no review
// remit, and importing them would fill a reviewer library with personas nobody would pick.

/** One directory inside one installed plugin that holds Persona documents. */
export interface PluginPersonaSource {
  /** The marketplace the plugin was installed from, as its install record spells it. */
  marketplace: string;
  /** The plugin's own name, as its install record spells it. */
  plugin: string;
  /**
   * The directory of `.md` documents, relative to the plugin's install path.
   *
   * A directory rather than a glob, and read one level deep. Both halves matter: the documents
   * sit together in one place, and a recursive walk would sweep in the sibling `references/`
   * prose that has no frontmatter and no business being a reviewer.
   */
  directory: string;
  /** What the UI credits these Personas to. Rendered verbatim; never parsed. */
  catalogLabel: string;
}

export const PLUGIN_PERSONA_SOURCES: readonly PluginPersonaSource[] = [
  {
    marketplace: "upstartclaw",
    plugin: "agent-team",
    directory: "references/roles",
    catalogLabel: "UpstartClaw",
  },
];
