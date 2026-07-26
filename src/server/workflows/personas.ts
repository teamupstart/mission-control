import { randomUUID } from "node:crypto";
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
} from "@shared/workflow.ts";
import type {
  Persona,
  PersonaDefaultsView,
  PersonaExecutionView,
  PersonaView,
} from "@shared/workflow.ts";
import type { Registry } from "../registry.ts";
import { llmRunnerChoice } from "../llm/config.ts";
import { WorkflowStore } from "./store.ts";
import type { PersonaStoreWrite } from "./store.ts";

export type PersonaMutation =
  | { ok: true; persona: PersonaView }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "name_conflict" | "archived" | "builtin";
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
    // Archived rows remain in the snapshot because published history may link to them, and
    // the store's catalog already carries the Personas this build ships - so the dashboard's
    // first snapshot has them without a seeding step that could have failed.
    registry.initializePersonas(this.store.listPersonas(true).map((persona) => personaView(persona)));
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

  /** Re-project effective values after the app-wide provider changes at runtime. */
  refreshExecution(): void {
    for (const persona of this.store.listPersonas(true)) {
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
    for (const persona of this.store.listPersonas(true)) {
      if (persona.builtin) this.registry.upsertPersona(personaView(persona));
    }
    return { ok: true, persona: view };
  }
}
