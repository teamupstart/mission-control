import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { envVar } from "@shared/harness-runtime.mjs";
import type { CreatePersona, UpdatePersona } from "@shared/protocol.ts";
import { LLM_RUNNER_IDS, resolveLlmRunner } from "@shared/llm.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "@shared/llm.ts";
import { resolveModelChoice } from "@shared/model-choice.ts";
import type { ResolvedModel } from "@shared/model-choice.ts";
import { providerModelDefault } from "@shared/model.ts";
import {
  WORKFLOW_PERSONA_MODEL_ENV,
  WORKFLOW_PERSONA_MODEL_SPEC,
  normalizePersonaName,
  personaDescriptionFromMarkdown,
  personaNameFromMarkdown,
  personaUpstreamState,
} from "@shared/workflow.ts";
import type {
  Persona,
  PersonaDefaultsView,
  PersonaDriftView,
  PersonaExecutionView,
  PersonaView,
} from "@shared/workflow.ts";
import type { Registry } from "../registry.ts";
import { llmRunnerChoice } from "../llm/config.ts";
import { WorkflowStore } from "./store.ts";
import type { PersonaStoreWrite } from "./store.ts";
import { readImportedSource, readPersonaSourceHash } from "./persona-import.ts";

export type PersonaMutation =
  | { ok: true; persona: PersonaView }
  | {
      ok: false;
      /**
       * `not_imported` is the one refusal here that the store never produces: it is a policy
       * fact about a row that is otherwise perfectly writable - it was authored in the editor,
       * so there is no source file to re-read. Like `builtin`, no retry clears it, and the
       * route says what would (import creates a Persona that has one).
       */
      reason:
        | "not_found"
        | "revision_conflict"
        | "name_conflict"
        | "archived"
        | "builtin"
        | "not_imported";
      current: PersonaView | null;
    };

function resolvePersonaModel(
  runner: LlmRunnerId,
  model: string | null | undefined,
  envModel: string | null | undefined,
): ResolvedModel {
  return resolveModelChoice(
    {
      ...WORKFLOW_PERSONA_MODEL_SPEC,
      fallback: providerModelDefault(runner, "balanced"),
    },
    model,
    envModel,
  );
}

/**
 * Resolve the exact provider/model a fresh Persona call would use.
 *
 * Parameters are injectable so contract tests can exercise the ladder without reading app config
 * or process environment. Production callers omit them and get the live values per call.
 */
export function resolvePersonaExecution(
  persona: Pick<Persona, "runner" | "model">,
  appRunner: ResolvedLlmRunner = llmRunnerChoice(),
  envModel: string | null | undefined = envVar(WORKFLOW_PERSONA_MODEL_ENV),
): PersonaExecutionView {
  const runner =
    persona.runner === null
      ? appRunner
      : resolveLlmRunner(persona.runner as string, undefined);
  const model = resolvePersonaModel(runner.id, persona.model, envModel);
  return { runner, model };
}

export function resolvePersonaDefaults(
  appRunner: ResolvedLlmRunner = llmRunnerChoice(),
  envModel: string | null | undefined = envVar(WORKFLOW_PERSONA_MODEL_ENV),
): PersonaDefaultsView {
  return {
    runner: appRunner,
    models: Object.fromEntries(LLM_RUNNER_IDS.map((runner) => [
      runner,
      resolvePersonaModel(runner, null, envModel),
    ])) as Record<LlmRunnerId, PersonaDefaultsView["models"][LlmRunnerId]>,
  };
}

export function personaView(
  persona: Persona,
  appRunner?: ResolvedLlmRunner,
  envModel?: string | null,
): PersonaView {
  return {
    ...persona,
    execution: resolvePersonaExecution(persona, appRunner, envModel),
  };
}

/** Policy, identity, effective-model projection, and Registry/SSE ownership for Personas. */
export class PersonaManager {
  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
  ) {
    registry.initializePersonas(this.store.personaCatalog().map((persona) => personaView(persona)));
  }

  list(includeArchived = false): PersonaView[] {
    return this.store.listPersonas(includeArchived).map((persona) => personaView(persona));
  }

  get(id: string): PersonaView | null {
    const persona = this.store.getPersona(id);
    return persona ? personaView(persona) : null;
  }

  defaults(): PersonaDefaultsView {
    return resolvePersonaDefaults();
  }

  create(input: CreatePersona, now = Date.now()): PersonaMutation {
    return this.publish(
      this.store.insertPersona({
        ...input,
        id: randomUUID(),
        normalizedName: normalizePersonaName(input.name),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  update(id: string, input: UpdatePersona, now = Date.now()): PersonaMutation {
    const { expectedRevision, ...patch } = input;
    const result = this.store.updatePersonaCas(
      id,
      expectedRevision,
      input.name === undefined
        ? patch
        : { ...patch, name: input.name, normalizedName: normalizePersonaName(input.name) },
      now,
    );
    return this.publish(result);
  }

  archive(id: string, expectedRevision: number, now = Date.now()): PersonaMutation {
    return this.publish(this.store.archivePersonaCas(id, expectedRevision, now));
  }

  /**
   * Import a Markdown document from a path on THIS machine as a new Persona.
   *
   * The name and description are derived through the same two functions the built-in catalog
   * and the browser's **Import .md** use, so one document arrives under one name however it
   * got here. The guidance is the exact decoded bytes; `create` then applies every ordinary
   * rule - name reservation, the guidance ceiling, revision 1 - because an imported Persona is
   * an ordinary Persona that happens to remember where it came from.
   *
   * Throws `PersonaImportError` for anything wrong with the PATH, which is not a mutation
   * refusal and must not be flattened into one: "no file there" and "a Persona already owns
   * this name" send an operator to two different places.
   */
  async importFromFile(sourcePath: string, now = Date.now()): Promise<PersonaMutation> {
    const { source, provenance } = await readImportedSource(sourcePath, now);
    const name = personaNameFromMarkdown(
      source.guidanceMarkdown,
      // The filename without its extension, exactly as the browser import falls back, so a
      // document with no heading is named after the file an operator can see.
      basename(source.sourcePath).replace(/\.(?:md|markdown|mdown)$/i, "").trim()
        || "Imported Persona",
    );
    return this.publish(
      this.store.insertPersona({
        id: randomUUID(),
        name,
        normalizedName: normalizePersonaName(name),
        description: personaDescriptionFromMarkdown(source.guidanceMarkdown),
        guidanceMarkdown: source.guidanceMarkdown,
        runner: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        provenance,
      }),
    );
  }

  /**
   * Re-read an imported Persona's source and store it as a new revision.
   *
   * Guidance and provenance, and deliberately NOT the name or description. Both of those are
   * catalog identity the operator owns from the moment of import - they can edit either - and
   * overwriting them here would be the silent change this whole feature exists to avoid. It
   * would also be able to FAIL: a document whose heading now collides with another Persona
   * would refuse the write as a name conflict, leaving drift permanently un-adoptable. Renaming
   * stays an edit a human makes, next to the guidance they just adopted.
   *
   * CAS on `expectedRevision` like every other Persona write, so a re-import from a stale tab
   * loses to whatever landed first instead of overwriting it.
   */
  async reimport(id: string, expectedRevision: number, now = Date.now()): Promise<PersonaMutation> {
    const current = this.get(id);
    if (!current) return { ok: false, reason: "not_found", current: null };
    if (current.builtin) return { ok: false, reason: "builtin", current };
    if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
    if (current.provenance === null) return { ok: false, reason: "not_imported", current };
    // Read BEFORE the write, so a source that has gone missing refuses the whole re-import
    // rather than bumping a revision to the guidance it already had.
    const { source, provenance } = await readImportedSource(current.provenance.sourcePath, now);
    return this.publish(
      this.store.updatePersonaCas(
        id,
        expectedRevision,
        { guidanceMarkdown: source.guidanceMarkdown, provenance },
        now,
      ),
    );
  }

  /**
   * Ask the disk what every imported Persona's source says now.
   *
   * Read per request rather than remembered, for `skillDrift`'s reason: a badge computed once
   * at startup is a claim about a file that nobody has looked at since, and this one is about
   * whether a reviewer's authority still matches the document it was adapted from. Archived
   * rows are skipped - they are read-only and cannot be re-imported, so a badge on one would
   * name work that cannot be done - and so are built-ins, which have no source path at all.
   *
   * One bounded read per imported Persona, hashed and compared. The reply carries verdicts
   * only: no paths, no document text, nothing that grows with the file.
   */
  async drift(): Promise<PersonaDriftView[]> {
    const imported = this.store.listPersonas().flatMap((persona) =>
      !persona.builtin && persona.archivedAt === null && persona.provenance !== null
        ? [{ id: persona.id, provenance: persona.provenance }]
        : []);
    return await Promise.all(imported.map(async ({ id, provenance }) => {
      const contentSha256 = await readPersonaSourceHash(provenance.sourcePath);
      return {
        id,
        upstream: personaUpstreamState(
          provenance,
          contentSha256 === null ? null : { contentSha256 },
        ),
      };
    }));
  }

  /** Re-project effective values after the app-wide provider changes at runtime. */
  refreshExecution(): void {
    for (const persona of this.store.personaCatalog()) {
      this.registry.upsertPersona(personaView(persona));
    }
  }

  private publish(result: PersonaStoreWrite): PersonaMutation {
    if (!result.ok) {
      return {
        ...result,
        current: result.current ? personaView(result.current) : null,
      };
    }
    const view = personaView(result.persona);
    // Archive is an upsert: the row remains addressable and its archived state is live data.
    this.registry.upsertPersona(view);
    for (const persona of this.store.personaCatalog()) {
      if (persona.builtin) this.registry.upsertPersona(personaView(persona));
    }
    return { ok: true, persona: view };
  }
}
