import { readdir } from "node:fs/promises";
import path from "node:path";

import { installedPlugins } from "./installed-plugins.ts";
import type { InstalledPlugin } from "./installed-plugins.ts";
import { PLUGIN_PERSONA_SOURCES } from "./persona-source-registry.ts";
import type { PluginPersonaSource } from "./persona-source-registry.ts";

// Turning "these plugins are installed" into "these documents could become Personas".
//
// Enumeration only. Nothing here reads a document's bytes, decides whether it is usable, or
// writes anything: that is the importer's job, and keeping the split means a directory of
// forty files costs forty `readdir` entries here rather than forty bounded reads.

/**
 * How many documents one source directory may contribute.
 *
 * A bound on somebody else's directory, in the spirit of the `MAX_DIRS` ceiling the environment
 * probe beside this uses. The real directory holds eleven; a plugin that ships four hundred is
 * either not what this feature is for or is having a bad day, and either way the catalog sync
 * must cost a bounded number of reads. Exceeding it truncates rather than refuses, and the
 * caller reports the truncation - see `PluginPersonaEnumeration.truncated`.
 */
const MAX_DOCUMENTS_PER_SOURCE = 100;

/** A document that a plugin catalog offers as a Persona. */
export interface PluginPersonaDocument {
  /**
   * The version-independent identity stored as `provenance.sourceKey`.
   *
   * `<marketplace>/<plugin>/<directory>/<file>` - deliberately WITHOUT the version segment that
   * appears in the path, because that is the whole point of it. Two boots either side of a
   * plugin upgrade produce the same key for the same role document and different `sourcePath`s.
   */
  sourceKey: string;
  /** The absolute path to read, inside the installed plugin. */
  sourcePath: string;
  /** The catalog to credit, carried through from the registry entry. */
  catalogLabel: string;
  /** The plugin that supplied it, for logs an operator has to make sense of. */
  plugin: string;
  /** The installed version of that plugin, when its record named one. */
  pluginVersion: string | null;
}

/** What one enumeration pass found, and what it had to leave out. */
export interface PluginPersonaEnumeration {
  documents: PluginPersonaDocument[];
  /** Source directories that hit `MAX_DOCUMENTS_PER_SOURCE`, by `<plugin>/<directory>`. */
  truncated: string[];
}

/**
 * The `.md` documents one installed plugin offers, one level deep and in filename order.
 *
 * Sorted with the same `localeCompare("en-US")` the built-in catalog's build-time scan uses, so
 * "filename order" means one thing across this codebase and a directory listing's arbitrary
 * order never leaks into what gets imported first.
 */
async function documentsIn(
  source: PluginPersonaSource,
  installed: InstalledPlugin,
): Promise<{ documents: PluginPersonaDocument[]; truncated: boolean }> {
  const dir = path.join(installed.installPath, source.directory);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A plugin installed without the directory this entry names is not an error. A version that
    // moved its role documents, a partial install, a plugin whose layout changed: all of them
    // mean "nothing to offer here", and none of them is worth a warning an operator cannot act
    // on. The registry entry is a place to LOOK, not a promise about what is there.
    return { documents: [], truncated: false };
  }
  const names = entries
    .filter((entry) => {
      // `isFile()` excludes the subdirectories a `references/` tree tends to grow. A symlink to
      // a document is deliberately NOT followed here to decide inclusion - it reports as neither
      // file nor directory - because the reader downstream resolves and re-validates links on
      // its own terms, and duplicating that judgment in an enumerator would put two different
      // answers in the codebase.
      if (!entry.isFile() && !entry.isSymbolicLink()) return false;
      return entry.name.toLowerCase().endsWith(".md");
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en-US"));
  const kept = names.slice(0, MAX_DOCUMENTS_PER_SOURCE);
  return {
    truncated: names.length > kept.length,
    documents: kept.map((name) => ({
      // POSIX separators in the key regardless of platform: this string is durable identity
      // stored in a row, and a key that spelled itself differently on Windows would re-import
      // every document the first time a database moved between machines.
      sourceKey: [source.marketplace, source.plugin, source.directory, name].join("/"),
      sourcePath: path.join(dir, name),
      catalogLabel: source.catalogLabel,
      plugin: source.plugin,
      pluginVersion: installed.version,
    })),
  };
}

/**
 * Every Persona document the installed plugin catalogs offer on this machine.
 *
 * Folds the registry over the install record: a registry entry whose plugin is not installed
 * contributes nothing, which is how a machine that has never heard of these plugins comes back
 * empty without anything having to ask whether it is that kind of machine.
 *
 * When the same plugin is installed at more than one scope the FIRST matching install wins, by
 * the record's own order. A second copy of the same role documents under a different scope is
 * the same document by identity - one `sourceKey` - so importing both would be a name conflict
 * with itself rather than two reviewers.
 */
export async function enumeratePluginPersonaDocuments(
  installed?: readonly InstalledPlugin[],
  sources: readonly PluginPersonaSource[] = PLUGIN_PERSONA_SOURCES,
): Promise<PluginPersonaEnumeration> {
  const present = installed ?? await installedPlugins();
  const documents: PluginPersonaDocument[] = [];
  const truncated: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const match = present.find(
      (entry) => entry.plugin === source.plugin && entry.marketplace === source.marketplace,
    );
    if (match === undefined) continue;
    const found = await documentsIn(source, match);
    if (found.truncated) truncated.push(`${source.plugin}/${source.directory}`);
    for (const document of found.documents) {
      if (seen.has(document.sourceKey)) continue;
      seen.add(document.sourceKey);
      documents.push(document);
    }
  }
  return { documents, truncated };
}
