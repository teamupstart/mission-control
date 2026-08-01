import { randomUUID } from "node:crypto";
import type { CreateSessionAction, UpdateSessionAction } from "@shared/protocol.ts";
import { normalizeSessionActionName } from "@shared/workflow.ts";
import type { SessionAction } from "@shared/workflow.ts";
import type { Registry } from "../registry.ts";
import { WorkflowStore } from "./store.ts";
import type { SessionActionStoreWrite } from "./store.ts";

export type SessionActionMutation =
  | { ok: true; action: SessionAction }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "name_conflict" | "archived" | "builtin";
      current: SessionAction | null;
    };

/**
 * Policy, identity, and Registry/SSE ownership for SessionActions.
 *
 * The exact shape of `PersonaManager` minus the execution projection, and the omission is
 * the point: a Persona's effective runner and model are resolved per read because they
 * depend on app-wide settings, while a SessionAction carries no such derived state. Its
 * required skill IS resolved late - immediately before a send - but that happens in the
 * Phase 2 delivery path against a published snapshot, never against this live row.
 */
export class SessionActionManager {
  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
  ) {
    registry.initializeSessionActions(this.store.sessionActionCatalog());
  }

  list(includeArchived = false): SessionAction[] {
    return this.store.listSessionActions(includeArchived);
  }

  get(id: string): SessionAction | null {
    return this.store.getSessionAction(id);
  }

  create(input: CreateSessionAction, now = Date.now()): SessionActionMutation {
    return this.publish(
      this.store.insertSessionAction({
        ...input,
        id: randomUUID(),
        normalizedName: normalizeSessionActionName(input.name),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  update(id: string, input: UpdateSessionAction, now = Date.now()): SessionActionMutation {
    const { expectedRevision, ...patch } = input;
    return this.publish(this.store.updateSessionActionCas(
      id,
      expectedRevision,
      input.name === undefined
        ? patch
        : { ...patch, name: input.name, normalizedName: normalizeSessionActionName(input.name) },
      now,
    ));
  }

  archive(id: string, expectedRevision: number, now = Date.now()): SessionActionMutation {
    return this.publish(this.store.archiveSessionActionCas(id, expectedRevision, now));
  }

  private publish(result: SessionActionStoreWrite): SessionActionMutation {
    if (!result.ok) return result;
    // Archive is an upsert: the row remains addressable and its archived state is live data.
    this.registry.upsertSessionAction(result.action);
    // A write can change which built-ins are SHADOWED - creating an action under a shipped
    // name is refused, but archiving one un-shadows it - and the browser's catalog has to
    // reflect that without a reconnect. Re-publishing the built-ins is how Personas do it.
    for (const action of this.store.sessionActionCatalog()) {
      if (action.builtin) this.registry.upsertSessionAction(action);
    }
    return { ok: true, action: result.action };
  }
}
