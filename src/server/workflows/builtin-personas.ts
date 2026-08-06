import {
  normalizePersonaName,
  personaDescriptionFromMarkdown,
  personaNameFromMarkdown,
} from "@shared/workflow.ts";
import type { Persona } from "@shared/workflow.ts";
import { BUILTIN_PERSONA_SOURCES } from "./builtin-personas.generated.ts";

/**
 * The review roles that ship with the application.
 *
 * These are app data, not operator data. They are never rows: the catalog merges them into
 * every Persona read (`WorkflowStore`), which is what makes them visible to the library, to
 * draft validation and to Publish's snapshot without a seeding step that could half-run, and
 * what makes "always the Markdown this build was made from" true rather than aspirational.
 *
 * The consequences of not being a row are the point:
 * - Nothing to migrate, so an install that never opened the Personas tab still has them.
 * - No revision history to keep, because there is only ever one revision of a build's copy.
 * - Edits and archives are refused in the store rather than in each caller, so a customized
 *   copy is one gesture with an honest name: Duplicate.
 *
 * `builtinPersonaId` is append-only for a role that remains shipped. The id reaches durable
 * storage as a published version's `sourcePersonaId` and as a draft graph's `personaId`, so
 * renaming a file slug silently repoints an id an operator's draft already uses. Removing a
 * document removes its id from the catalog. Published versions remain intact because they
 * carry their own guidance copy, but a draft naming that id stops validating until its node
 * is replaced.
 */
export const BUILTIN_PERSONA_ID_PREFIX = "builtin:";

/** Durable, human-readable, and derived from the filename so nothing states it twice. */
export function builtinPersonaId(slug: string): string {
  return `${BUILTIN_PERSONA_ID_PREFIX}${slug}`;
}

function builtinPersona(source: { slug: string; guidanceMarkdown: string }): Persona {
  const name = personaNameFromMarkdown(source.guidanceMarkdown, source.slug);
  return {
    id: builtinPersonaId(source.slug),
    name,
    normalizedName: normalizePersonaName(name),
    description: personaDescriptionFromMarkdown(source.guidanceMarkdown),
    guidanceMarkdown: source.guidanceMarkdown,
    // No provider or model override: a built-in resolves through the app-wide ladder, which
    // is the same answer a freshly imported copy of the same document would get.
    runner: null,
    model: null,
    // One revision, because a build has exactly one copy of each document. Editors read this
    // to decide what a save would be based on, and a built-in has no save.
    revision: 1,
    archivedAt: null,
    // A built-in was not created on this machine and has no edit history, so there is no
    // instant to report. Surfaces print "Built-in" where they print a row's dates.
    createdAt: 0,
    updatedAt: 0,
    // Not "imported from nowhere": a built-in's upstream is this build, which upgrades rather
    // than drifts. Provenance answers "which file on this machine did this come from", and the
    // honest answer for a compiled-in document is none - so no drift check ever reads it.
    provenance: null,
    builtin: true,
  };
}

export const BUILTIN_PERSONAS: readonly Persona[] = BUILTIN_PERSONA_SOURCES.map(builtinPersona);
