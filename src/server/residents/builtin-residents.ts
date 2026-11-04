import { personaDescriptionFromMarkdown, personaNameFromMarkdown } from "@shared/workflow.ts";
import {
  BUILTIN_RESIDENT_PROFILE_ID_PREFIX,
  RESIDENT_LIMITS,
  ResidentProfileRevisionSchema,
  type ResidentProfileRevision,
  type ResidentProfileRevisionInput,
} from "@shared/residents.ts";
import { BUILTIN_RESIDENT_SOURCES } from "./builtin-residents.generated.ts";

/**
 * The resident profiles that ship with the application.
 *
 * Unlike a built-in Persona, a built-in resident IS a row. A run reads its settings by joining
 * `resident_profile_revisions` on the revision it pinned, and a pinned revision must keep
 * reading exactly what it launched with after an upgrade replaces the shipped copy. So
 * `reconcileBuiltinResidentProfiles` (in `store.ts`) writes each entry here at daemon start,
 * and appends a new revision whenever this build's settings differ from the current one. The
 * old revision stays in the table for every run that pinned it, and **Restart on new profile**
 * is how a running built-in adopts the upgrade.
 *
 * What the row never becomes is operator data: the store refuses every edit and archive of a
 * `builtin:` id, settings snapshots leave it out, and restore never archives it. Customizing one
 * is **Duplicate to edit**, which makes an ordinary profile.
 *
 * The instructions are the exact bytes of `residents/<slug>.md`; its first heading is the name
 * and the paragraph under it the description. Every other setting is stated here, beside the
 * slug it belongs to. A slug with no entry here, or an entry with no document, fails at load.
 */
export interface BuiltinResident {
  id: string;
  settings: ResidentProfileRevision;
}

/** Everything a built-in states besides the document. Sections omitted take schema defaults. */
type BuiltinResidentSettings = Omit<ResidentProfileRevisionInput, "identity" | "persona" | "instructions">;

const BUILTIN_RESIDENT_SETTINGS: Record<string, BuiltinResidentSettings> = {
  "agent-shepherd": {
    execution: { agent: "claude", model: "claude-sonnet-5-5", effort: "xhigh" },
    board: { colorId: "amber", label: null, pin: true },
    // Its role is controlling other sessions. The grant is still only ever given by an
    // operator's desktop Launch click; see docs/residents.md#session-control.
    authority: { controlOtherSessions: true },
  },
};

/** The durable profile id of a shipped document. Append-only, like every built-in id. */
export function builtinResidentProfileId(slug: string): string {
  return `${BUILTIN_RESIDENT_PROFILE_ID_PREFIX}${slug}`;
}

export function builtinResidentsFrom(
  sources: readonly { slug: string; instructionsMarkdown: string }[],
  settings: Readonly<Record<string, BuiltinResidentSettings>>,
): BuiltinResident[] {
  const slugs = new Set(sources.map((source) => source.slug));
  for (const slug of Object.keys(settings)) {
    if (!slugs.has(slug)) throw new Error(`built-in resident settings name ${slug}, which has no residents/${slug}.md`);
  }
  return sources.map((source) => {
    const rest = settings[source.slug];
    if (!rest) throw new Error(`residents/${source.slug}.md has no settings in builtin-residents.ts`);
    return {
      id: builtinResidentProfileId(source.slug),
      settings: ResidentProfileRevisionSchema.parse({
        ...rest,
        identity: {
          name: personaNameFromMarkdown(source.instructionsMarkdown, source.slug),
          description: personaDescriptionFromMarkdown(source.instructionsMarkdown, RESIDENT_LIMITS.descriptionLength),
        },
        persona: { personaId: "" },
        instructions: { markdown: source.instructionsMarkdown },
      }),
    };
  });
}

export const BUILTIN_RESIDENTS: readonly BuiltinResident[] = builtinResidentsFrom(
  BUILTIN_RESIDENT_SOURCES,
  BUILTIN_RESIDENT_SETTINGS,
);
