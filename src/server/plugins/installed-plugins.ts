import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { readFileWithinCap } from "../session-files.ts";

// What Claude Code has installed on THIS machine, read from Claude Code's own record.
//
// Nothing here knows the name of any plugin, marketplace or vendor. This module answers one
// question - "which plugins are installed, at which version, in which directory" - and the
// callers that care about a particular plugin bring that name with them. See
// `persona-source-registry.ts` for the one file in the daemon that spells a plugin name out.
//
// Read on demand and never cached, for the reason `environmentCheckViews` gives about the
// checks beside it: an operator who installs a plugin expects the product to notice without
// restarting a daemon, and a snapshot taken at boot is a claim about a machine that has since
// changed. The callers that run this once at boot do so because their own work is once-at-boot,
// not because the answer is durable.

/** Where Claude Code keeps its plugin state, honoring the override it documents. */
const PLUGINS_DIR = "plugins";
/** Claude Code's own record of what is installed, inside the plugins directory. */
const INSTALL_RECORD = "installed_plugins.json";

/**
 * How much of the install record is read.
 *
 * The record grows roughly 400 bytes per installed plugin, and unlike the environment check's
 * 64 KB text probe this one is PARSED: a truncated read is not a weaker signal here, it is
 * invalid JSON that would discard every entry. So the ceiling is generous enough that no real
 * machine reaches it - 1 MB is some 2,500 installed plugins - and a file past it is refused as
 * a whole rather than half-parsed.
 */
const INSTALL_RECORD_MAX_BYTES = 1024 * 1024;

/** One installed plugin, as this daemon needs to address it. */
export interface InstalledPlugin {
  /** The plugin's own name, the part before `@` in the record's key. */
  plugin: string;
  /** The marketplace it came from, the part after `@`. */
  marketplace: string;
  /** The version string the record carries, when it carries one. */
  version: string | null;
  /** The absolute directory the plugin's files live in. */
  installPath: string;
}

/**
 * The root Claude Code keeps plugin state under.
 *
 * `CLAUDE_CONFIG_DIR` is honored because Claude Code honors it, and because the scripts inside
 * the plugins this daemon reads honor it too - a machine that relocated its config and a daemon
 * that assumed `~/.claude` would disagree about whether anything is installed at all.
 */
export function claudePluginsDir(home = homedir()): string {
  // `process.env` DIRECTLY, and deliberately not this codebase's `envVar` helper: that helper
  // resolves Mission Control's own namespaced variables (`MISSION_*` / `FLEET_* `/ `HARNESS_*`),
  // and this is somebody else's variable read under the name they publish. Reached for `envVar`
  // first and it read nothing at all, which is the quiet direction for this to be wrong in - a
  // relocated config would silently look like a machine with no plugins installed.
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const root = configured !== undefined && configured.trim().length > 0
    ? configured.trim()
    : path.join(home, ".claude");
  return path.join(root, PLUGINS_DIR);
}

/**
 * Read a bounded JSON document, or null for every way that can fail.
 *
 * Null rather than a thrown error because every caller here treats "no usable record" the same
 * way: fall back to knowing nothing, which costs a feature rather than a boot.
 */
async function readBoundedJson(file: string, cap: number): Promise<unknown> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const { bytes, exceeded } = await readFileWithinCap(handle, cap);
    if (exceeded) return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Pull the installed plugins out of whatever shape the record is in.
 *
 * Hand-walked rather than validated against a Zod schema, and that is deliberate: the shape is
 * not ours, it has already been revised once (the file carries `"version": 2`), and the next
 * revision must cost this reader the entries it cannot understand rather than all of them. So
 * every level is checked for exactly what is used and anything unrecognised is skipped.
 *
 * A key is `"<plugin>@<marketplace>"` and the value is an ARRAY, because the same plugin can be
 * installed at more than one scope - user, project, managed. Each entry carries its own
 * `installPath`, so each becomes its own `InstalledPlugin` and the caller decides what a
 * duplicate means. Dropping all but the first here would hide a project-scoped install that is
 * the only one an operator actually has.
 */
export function parseInstalledPlugins(record: unknown): InstalledPlugin[] {
  if (record === null || typeof record !== "object") return [];
  const plugins = (record as { plugins?: unknown }).plugins;
  if (plugins === null || typeof plugins !== "object") return [];
  const out: InstalledPlugin[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    // Split on the LAST `@`, so a marketplace name is never mistaken for part of a scoped
    // plugin name. A key with no `@` at all names no marketplace and is skipped: this daemon
    // addresses a plugin as plugin-and-marketplace, and half of that is not an address.
    const at = key.lastIndexOf("@");
    if (at <= 0 || at === key.length - 1) continue;
    const plugin = key.slice(0, at);
    const marketplace = key.slice(at + 1);
    for (const entry of Array.isArray(value) ? value : []) {
      if (entry === null || typeof entry !== "object") continue;
      const installPath = (entry as { installPath?: unknown }).installPath;
      // An install path that is not absolute is not one this daemon will resolve against its
      // own cwd - that would read a directory the record never named.
      if (typeof installPath !== "string" || !path.isAbsolute(installPath)) continue;
      const version = (entry as { version?: unknown }).version;
      out.push({
        plugin,
        marketplace,
        version: typeof version === "string" && version.trim().length > 0
          ? version.trim().slice(0, 200)
          : null,
        installPath,
      });
    }
  }
  return out;
}

/**
 * Every plugin Claude Code records as installed on this machine.
 *
 * An empty array is the honest answer for a machine with no plugins, no record, or a record
 * this build cannot read, and no caller may treat it as an error: "nothing installed" is by far
 * the most common truth here and the product has to stay silent about it.
 */
export async function installedPlugins(
  pluginsDir: string = claudePluginsDir(),
): Promise<InstalledPlugin[]> {
  const record = await readBoundedJson(
    path.join(pluginsDir, INSTALL_RECORD),
    INSTALL_RECORD_MAX_BYTES,
  );
  return parseInstalledPlugins(record);
}
