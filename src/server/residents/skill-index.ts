import { opendirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  ResidentSkillSourcesSchema,
  RESIDENT_SKILL_SOURCE_IDS,
  type ResidentSkillSourceId,
  type IndexedResidentSkill,
  type ResidentSkillIndex,
  type ResidentSkillSource,
  type ResidentSkillSources,
} from "@shared/resident-skills.ts";
import { skillsDir } from "../config.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { canonicalize, RepoIndexConfigError, resolvesAtOrAboveHome, validateIndexedDirectories } from "../repo-index-config.ts";
import { frontmatterBlock } from "../skills/catalog.ts";

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_ENTRIES_PER_SOURCE = 5000;
const MAX_GROUP_DEPTH = 6;
const MAX_PROBLEMS = 100;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

function configRevision(config: ResidentSkillSources): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export class ResidentSkillSourcesConflictError extends Error {}

/** Same path and canonical-duplicate checks as repository indexing, including deferred roots. */
export function validateSkillDirectories(config: ResidentSkillSources): void {
  validateIndexedDirectories(config.directories);
  const predefined = new Set(defaultSkillSources().flatMap((source) => source.path ? [canonicalize(source.path)] : []));
  for (const row of config.directories) {
    if (predefined.has(canonicalize(row.path))) throw new RepoIndexConfigError("This directory is already a predefined skill source.");
  }
}

export function defaultSkillSources(
  home = homedir(),
  codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  mission = skillsDir(),
): ResidentSkillSource[] {
  const roots: Record<ResidentSkillSourceId, { label: string; path: string | null }> = {
    mission: { label: "Mission Control", path: mission },
    "claude-global": { label: "Claude global", path: join(home, ".claude", "skills") },
    "agents-global": { label: "Agents global", path: join(home, ".agents", "skills") },
    "codex-global": { label: "Codex global", path: join(codexHome, "skills") },
    "claude-builtin": { label: "Claude built-ins", path: null },
    "codex-builtin": { label: "Codex built-ins", path: null },
  };
  return RESIDENT_SKILL_SOURCE_IDS.map((id) => ({ id, ...roots[id], custom: false, problems: roots[id].path ? [] : [
    "Built-in selection is unavailable: no verified frozen-isolation mechanism.",
  ] }));
}

/** External skills may use the full YAML scalar syntax; never execute frontmatter or skill content. */
export function parseResidentSkill(text: string): { name: string; description: string } {
  const block = frontmatterBlock(text.replace(/^\uFEFF/, ""));
  if (block === null) throw new Error("SKILL.md has no frontmatter block.");
  const document = parseDocument(block, { uniqueKeys: true });
  if (document.errors.length) throw new Error("SKILL.md has invalid YAML frontmatter.");
  const data: unknown = document.toJS({ maxAliasCount: 0 });
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Frontmatter must be a mapping.");
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || name.length > 128 || (/[\r\n]/.test(name) || name.includes(String.fromCharCode(0)))) {
    throw new Error("SKILL.md needs a name of at most 128 characters on one line.");
  }
  if (typeof description !== "string" || !description.trim() || description.length > 16000) {
    throw new Error("SKILL.md needs a description of at most 16000 characters.");
  }
  return { name: name.trim(), description: description.trim() };
}

/** Bounded traversal also covers grouped skill folders and globally installed symlinked skills. */
export function scanSkillSources(sources: readonly ResidentSkillSource[], config: ResidentSkillSources): ResidentSkillIndex {
  const result: ResidentSkillIndex = {
    sources: sources.map((source) => ({ ...source, problems: [...source.problems] })),
    skills: [], config, configRevision: configRevision(config), truncated: false, scannedAt: Date.now(),
  };
  // Count actual UTF-8 JSON bytes, including escaping, source metadata and configuration.
  // Account before retaining each entry so neither the cache nor the response grows first.
  let bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > MAX_CATALOG_BYTES) throw new Error("Skill source metadata exceeds the 4 MiB catalog limit.");
  const retain = <T>(list: T[], value: T): void => {
    const added = Buffer.byteLength(JSON.stringify(value)) + (list.length ? 1 : 0);
    if (bytes + added > MAX_CATALOG_BYTES) { result.truncated = true; return; }
    bytes += added;
    list.push(value);
  };
  const missionSkills = new Set<string>();
  const claudeSkillTargets = new Map<string, string>();
  for (const source of result.sources) {
    if (result.truncated) break;
    if (!source.path || source.problems.length) continue;
    const problem = (message: string): void => {
      if (!result.truncated && source.problems.length < MAX_PROBLEMS) retain(source.problems, message);
    };
    const ancestors = new Set<string>();
    // Count the source root and every enumerated entry, including files and hidden entries.
    // Read one extra entry to detect truncation, then close without draining the directory.
    let entries = 1;
    const childrenOf = (directory: string): Dirent[] => {
      const children: Dirent[] = [];
      const handle = opendirSync(directory);
      try {
        let child: Dirent | null;
        while ((child = handle.readSync()) !== null) {
          if (++entries > MAX_ENTRIES_PER_SOURCE) {
            problem("Source exceeds the 5000-entry scan limit.");
            break;
          }
          children.push(child);
        }
      } finally { handle.closeSync(); }
      return children.sort((a, b) => a.name.localeCompare(b.name));
    };
    const walk = (directory: string, folder: string, depth: number): void => {
      if (result.truncated) return;
      try {
        const real = realpathSync(directory);
        // Recheck every resolved directory: a child link can be just as broad as a root.
        if (resolvesAtOrAboveHome(real)) {
          problem(`${folder ? `${folder}: ` : ""}This directory resolves at or above your home. Choose a narrower folder.`);
          return;
        }
        if (ancestors.has(real)) { problem(`${folder}: directory link cycle.`); return; }
        if (!statSync(real).isDirectory()) { if (!folder) problem("Source is not a directory."); return; }
        const document = join(directory, "SKILL.md");
        let documentExists = false;
        try { statSync(document); documentExists = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (folder && documentExists) {
          try {
            const stat = statSync(document);
            if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error("SKILL.md must be a file no larger than 128 KiB.");
            const parsed = parseResidentSkill(readFileSync(document, "utf8"));
            const skill: IndexedResidentSkill = { id: `${source.id}:${folder}`, sourceId: source.id, folder, path: directory, ...parsed };
            retain(result.skills, skill);
            if (result.truncated) return;
            if (source.id === "mission") missionSkills.add(real);
            if (source.id === "claude-global") claudeSkillTargets.set(skill.id, real);
          } catch (error) { problem(`${folder}: ${error instanceof Error ? error.message : String(error)}`); }
          return;
        }
        if (depth >= MAX_GROUP_DEPTH) { problem(`${folder}: grouped folders exceed the depth limit of ${MAX_GROUP_DEPTH}.`); return; }
        if (entries > MAX_ENTRIES_PER_SOURCE) return;
        ancestors.add(real);
        try {
          const children = childrenOf(directory);
          let subfolders = 0;
          for (const child of children) {
            if (result.truncated) break;
            if (child.name.startsWith(".")) continue;
            if (!child.isDirectory() && !child.isSymbolicLink()) continue;
            subfolders++;
            walk(join(directory, child.name), folder ? `${folder}/${child.name}` : child.name, depth + 1);
          }
          if (folder && !subfolders && entries <= MAX_ENTRIES_PER_SOURCE) problem(`${folder}: no SKILL.md.`);
        } finally { ancestors.delete(real); }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        problem(`${folder || source.path}: ${code === "ENOENT" ? "directory is missing" : code === "ENOTDIR" ? "not a directory" : code === "EACCES" || code === "EPERM" ? "directory is unreadable" : "could not read directory"}.`);
      }
    };
    walk(source.path, "", 0);
  }
  // Only a resolved target actually indexed by Mission Control proves a duplicate.
  // Filter after all sources so their order cannot hide an independent Claude skill.
  result.skills = result.skills.filter((skill) => {
    const target = claudeSkillTargets.get(skill.id);
    return target === undefined || !missionSkills.has(target);
  });
  return result;
}

let cached: { key: string; index: ResidentSkillIndex } | null = null;

export function residentSkillIndex(rescan = false): ResidentSkillIndex {
  const config = ResidentSkillSourcesSchema.parse(getAppConfig(APP_CONFIG_ENTRIES.residentSkillSources) ?? {});
  const seen = new Set<string>();
  const sources = [...defaultSkillSources(), ...config.directories.map((row) => {
    const path = canonicalize(row.path);
    const problems: string[] = [];
    // A restored setting or a retargeted symlink has to pass the same checks as a new row.
    try {
      validateSkillDirectories({ directories: [row] });
      if (seen.has(path)) throw new Error("This directory is already indexed by another source.");
    } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
    seen.add(path);
    return { ...row, label: row.path, path, custom: true, problems };
  })];
  const key = JSON.stringify(sources);
  if (!rescan && cached?.key === key) return cached.index;
  const index = scanSkillSources(sources, config);
  cached = { key, index };
  return index;
}

export function saveResidentSkillSources(config: ResidentSkillSources, expectedRevision?: string): ResidentSkillIndex {
  const current = ResidentSkillSourcesSchema.parse(getAppConfig(APP_CONFIG_ENTRIES.residentSkillSources) ?? {});
  // The daemon is the sole writer; comparison and persistence are synchronous, with no await.
  if (expectedRevision !== undefined && expectedRevision !== configRevision(current)) {
    throw new ResidentSkillSourcesConflictError("Skill sources changed in another window. Review the refreshed list and try again.");
  }
  validateSkillDirectories(config);
  setAppConfig(APP_CONFIG_ENTRIES.residentSkillSources, config);
  return residentSkillIndex(true);
}
