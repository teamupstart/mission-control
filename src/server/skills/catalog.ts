import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillCatalogEntry } from "@shared/types.ts";
import { SKILL_ENFORCEMENTS, type SkillEnforcement } from "@shared/skills.ts";
import { skillsDir } from "../config.ts";

// The catalog: `skills/<id>/SKILL.md`, baked into the repo so it is versioned and
// reviewable with the app rather than being loose state on someone's disk.
//
// These are ORDINARY Claude Code skills - standard frontmatter, standard body - so
// enabling one is native loading, not a reimplementation of it. The only addition
// is a `metadata.fleet` block the catalog display reads and Claude ignores.

/** The path a catalog id's skill directory sits at - the symlink's target. */
export function skillSourceDir(id: string): string {
  return join(skillsDir(), id);
}

/**
 * The frontmatter this catalog understands, as a nested bag of strings.
 *
 * Deliberately NOT a YAML parser. A skill's frontmatter is authored in this repo and
 * reviewed with it, so the shape is known: `key: scalar` lines plus one level of
 * nesting for `metadata.fleet`. A general parser would be a dependency and a much
 * larger promise than "read four fields out of a file we wrote ourselves".
 *
 * The narrowness is the safety: anything this can't read is REPORTED, never guessed
 * at. See `parseSkill`.
 */
type Frontmatter = Map<string, string | Frontmatter>;

/** Lift the `---`-fenced frontmatter block out of a SKILL.md, or null if absent. */
export function frontmatterBlock(text: string): string | null {
  // The opening fence must be the file's first line - a `---` further down is a
  // horizontal rule in the body, not a frontmatter fence.
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  return m ? (m[1] ?? "") : null;
}

/**
 * Parse indented `key: value` lines into a nested map. A key with no value opens a
 * block; its children are the lines indented further than it.
 *
 * Handles what the catalog's frontmatter actually is and nothing more: single-line
 * scalars (optionally quoted), one nesting level in practice, comments, blanks. A
 * multi-line scalar (`>-`, `|`) is not supported and would surface as a missing
 * field rather than as a half-read one - which `parseSkill` then reports.
 */
export function parseFrontmatter(block: string): Frontmatter {
  const root: Frontmatter = new Map();
  // The open blocks, outermost first, each with the indent its children must exceed.
  const stack: Array<{ indent: number; map: Frontmatter }> = [{ indent: -1, map: root }];

  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue; // list items and anything else this parser doesn't promise
    const [, key = "", rest = ""] = m;

    while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) stack.pop();
    const parent = stack.at(-1)?.map ?? root;

    if (rest === "") {
      const child: Frontmatter = new Map();
      parent.set(key, child);
      stack.push({ indent, map: child });
    } else {
      parent.set(key, unquote(rest));
    }
  }
  return root;
}

/** Strip one layer of matching quotes and trailing whitespace from a scalar. */
function unquote(raw: string): string {
  const v = raw.trim();
  const quoted = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return quoted ? (quoted[1] ?? "") : v;
}

function str(fm: Frontmatter | undefined, key: string): string | null {
  const v = fm?.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function block(fm: Frontmatter | undefined, key: string): Frontmatter | undefined {
  const v = fm?.get(key);
  return v instanceof Map ? v : undefined;
}

function isEnforcement(v: string): v is SkillEnforcement {
  return (SKILL_ENFORCEMENTS as readonly string[]).includes(v);
}

/**
 * True when a value is YAML's "the real text is on the following lines" marker
 * (`>`, `>-`, `|`, `|+`, `|2-` …) rather than a value.
 *
 * Worth naming, because this parser reads the marker AS the value and would otherwise
 * hand the panel a skill whose description is the literal string ">-". That renders as a
 * row, so nothing looks broken - while the description is the field Claude preloads to
 * decide whether to ever reach for the skill, so the skill would be quietly inert.
 */
function isBlockScalar(v: string | Frontmatter | undefined): boolean {
  return typeof v === "string" && /^[>|][-+]?\d*[-+]?$/.test(v.trim());
}

/**
 * Any block scalar anywhere in the frontmatter, at any depth.
 *
 * Scanned WHOLE rather than field by field, because the marker is only half the damage.
 * Nothing here opens a block for it (a block opens only on an empty value), so the
 * scalar's indented body lines are parsed as ordinary `key: value` pairs and land on
 * whatever map is open - the ROOT. A `argument-hint: |` whose body happens to contain a
 * `name:` line therefore overwrites the skill's real name, and the row would present as
 * a skill nobody wrote. Refusing the file outright is the only honest answer a parser
 * this narrow can give.
 */
function findBlockScalar(fm: Frontmatter, path: string[] = []): string | null {
  for (const [key, value] of fm) {
    if (isBlockScalar(value)) return [...path, key].join(".");
    if (value instanceof Map) {
      const found = findBlockScalar(value, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}

/** A catalog entry, or why this directory isn't one. */
export type ParsedSkill =
  | { ok: true; skill: SkillCatalogEntry }
  | { ok: false; id: string; problem: string };

/**
 * Read one `skills/<id>/SKILL.md` into a catalog entry.
 *
 * Every field is required, and a missing one is an ERROR rather than a default.
 * Defaulting would be the worse failure by far: `enforcement` is the field that
 * tells the operator a skill is only a suggestion, so quietly inventing a rung for a
 * skill whose frontmatter we failed to read is the panel stating a guarantee nobody
 * made. `name` and `description` are Claude's own contract - the description is what
 * decides whether the model ever reaches for the skill - so a blank one is a broken
 * skill, not a nameless one.
 *
 * `name` defaults to the DIRECTORY name in Claude when omitted, which is exactly
 * what the `fleet-` prefix would poison, so the catalog insists on it explicitly.
 */
export function parseSkill(id: string, text: string): ParsedSkill {
  const fail = (problem: string): ParsedSkill => ({ ok: false, id, problem });
  const raw = frontmatterBlock(text);
  if (raw === null) return fail(`skills/${id}/SKILL.md has no --- frontmatter block`);

  const fm = parseFrontmatter(raw);
  // Say which limit was hit, not just "missing". A folded/literal scalar is valid YAML
  // that Claude itself reads fine - it's this reader that can't, and the operator can
  // only act on that if we say so.
  const blockScalarAt = findBlockScalar(fm);
  if (blockScalarAt !== null) {
    return fail(
      `skills/${id}/SKILL.md writes '${blockScalarAt}' as a multi-line YAML scalar (> or |), which this catalog reader doesn't support - put it on one line`,
    );
  }
  const name = str(fm, "name");
  const description = str(fm, "description");
  if (!name) return fail(`skills/${id}/SKILL.md has no 'name'`);
  if (!description) return fail(`skills/${id}/SKILL.md has no 'description'`);

  const fleet = block(block(fm, "metadata"), "fleet");
  const category = str(fleet, "category");
  const enforcement = str(fleet, "enforcement");
  if (!category) return fail(`skills/${id}/SKILL.md has no 'metadata.fleet.category'`);
  if (!enforcement) return fail(`skills/${id}/SKILL.md has no 'metadata.fleet.enforcement'`);
  if (!isEnforcement(enforcement)) {
    return fail(`skills/${id}/SKILL.md has an unknown enforcement '${enforcement}'`);
  }

  // `disable-model-invocation: true` takes a skill out of the "N available" count and
  // out of the model's reach entirely - which is almost never what a fleet skill
  // wants, since the whole point of enabling one is that the model can use it. Say so
  // rather than shipping a row whose toggle does nothing an operator can observe.
  if (str(fm, "disable-model-invocation") === "true") {
    return fail(`skills/${id}/SKILL.md sets disable-model-invocation - it would load but never fire`);
  }

  return { ok: true, skill: { id, name, description, category, enforcement } };
}

/** The catalog, plus anything in `skills/` that isn't a readable skill. */
export interface Catalog {
  /**
   * Whether `skills/` itself could be read. **NOT the same as "there are no skills"**,
   * and the reconciler must never treat it as such - see `present`.
   */
  readable: boolean;
  /** The rows the panel draws: directories whose SKILL.md this build could parse. */
  skills: SkillCatalogEntry[];
  /**
   * Every directory under `skills/`, parsed or not. Empty when `readable` is false.
   *
   * This exists because "is this skill's directory there?" and "could we parse its
   * frontmatter?" are DIFFERENT QUESTIONS, and the reconciler asks the first one.
   * Conflating them let a parse failure read as a deletion: a SKILL.md reformatted
   * into a YAML folded scalar - still perfectly valid, still loaded by Claude itself -
   * would drop out of `skills`, the reconciler would see an id nobody wants, and it
   * would unlink a working skill from every session on the machine and broadcast a
   * reload to make sure they all dropped it. Our parser's reach is not evidence about
   * what Claude can load.
   */
  present: Set<string>;
  /** Directories we refused, in the operator's words. Surfaced, never swallowed. */
  problems: string[];
}

/**
 * Scan `skills/` into the catalog.
 *
 * A directory that fails to parse is dropped from `skills` and reported, rather than
 * throwing: one malformed SKILL.md must not take the whole panel - and with it every
 * working toggle - down with it. It stays in `present`, because it is still a skill
 * directory on disk.
 */
export function readCatalog(): Catalog {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    // The catalog is UNREADABLE, which is a fact about us, not about the operator's
    // skills. Saying `readable: false` out loud is what stops the reconciler reading
    // this as "every skill was deleted" and uninstalling the lot.
    return {
      readable: false,
      skills: [],
      present: new Set(),
      problems: [`couldn't read the skills catalog at ${skillsDir()}: ${msg(err)}`],
    };
  }

  const skills: SkillCatalogEntry[] = [];
  const problems: string[] = [];
  for (const id of entries) {
    let text: string;
    try {
      text = readFileSync(join(skillSourceDir(id), "SKILL.md"), "utf8");
    } catch {
      problems.push(`skills/${id} has no SKILL.md`);
      continue;
    }
    const parsed = parseSkill(id, text);
    if (parsed.ok) skills.push(parsed.skill);
    else problems.push(parsed.problem);
  }
  return { readable: true, skills, present: new Set(entries), problems };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
