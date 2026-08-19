import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import {
  HARNESS_MODEL_CATALOG_LIMITS,
  HarnessModelChoiceSchema,
  type HarnessModelCatalog,
  type HarnessModelCatalogChoice,
  type HarnessModelCatalogs,
} from "@shared/protocol.ts";
import { HARNESSES } from "./index.ts";
import type { ModelCatalogDiscover, ModelCatalogSpec } from "./types.ts";

/** Ordinary reads remain fresh for five minutes; forced reads bypass only this check. */
export const HARNESS_MODEL_CATALOG_FRESH_FOR_MS = 5 * 60 * 1_000;

export interface HarnessModelCatalogServiceDeps {
  specs?: Record<AgentType, ModelCatalogSpec>;
  now?: () => number;
  freshForMs?: number;
}

export type ModelCatalogSpecs = Record<AgentType, ModelCatalogSpec>;

type CacheEntry = {
  choices: HarnessModelCatalogChoice[];
  refreshedAtMs: number;
};

function defaultSpecs(): Record<AgentType, ModelCatalogSpec> {
  return Object.fromEntries(
    AGENT_TYPES.map((agent) => [agent, HARNESSES[agent].models]),
  ) as Record<AgentType, ModelCatalogSpec>;
}

export class HarnessModelCatalogService {
  private readonly specs: Record<AgentType, ModelCatalogSpec>;
  private readonly now: () => number;
  private readonly freshForMs: number;
  private readonly cache = new Map<AgentType, CacheEntry>();
  private readonly inFlight = new Map<AgentType, Promise<HarnessModelCatalog>>();
  private readonly controllers = new Map<AgentType, AbortController>();
  private stopped = false;

  constructor(deps: HarnessModelCatalogServiceDeps = {}) {
    const specs = deps.specs ?? defaultSpecs();
    this.specs = Object.fromEntries(
      AGENT_TYPES.map((agent) => [agent, specs[agent]]),
    ) as Record<AgentType, ModelCatalogSpec>;
    this.now = deps.now ?? Date.now;
    this.freshForMs = deps.freshForMs ?? HARNESS_MODEL_CATALOG_FRESH_FOR_MS;
  }

  async getCatalogs(options: { refresh?: boolean } = {}): Promise<HarnessModelCatalogs> {
    const refresh = options.refresh === true;
    const entries = await Promise.all(
      AGENT_TYPES.map(async (agent) => [agent, await this.readOne(agent, refresh)] as const),
    );
    return Object.fromEntries(entries) as HarnessModelCatalogs;
  }

  /** Abort and drain every daemon-owned discovery child before process shutdown. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.inFlight.values());
  }

  private async readOne(agent: AgentType, refresh: boolean): Promise<HarnessModelCatalog> {
    const spec = this.specs[agent];
    if (!spec.discover) {
      return {
        choices: [...spec.shipped],
        source: "shipped",
        refreshedAt: null,
        problem: null,
      };
    }

    if (this.stopped) return this.degraded(agent, spec, "process_failed");

    const running = this.inFlight.get(agent);
    if (running) return await running;

    const cached = this.cache.get(agent);
    const now = this.now();
    if (
      !refresh &&
      cached &&
      now >= cached.refreshedAtMs &&
      now - cached.refreshedAtMs < this.freshForMs
    ) {
      return {
        choices: [...cached.choices],
        source: "cached",
        refreshedAt: new Date(cached.refreshedAtMs).toISOString(),
        problem: null,
      };
    }

    const probe = this.refresh(agent, spec);
    this.inFlight.set(agent, probe);
    try {
      return await probe;
    } finally {
      if (this.inFlight.get(agent) === probe) this.inFlight.delete(agent);
    }
  }

  private async refresh(agent: AgentType, spec: ModelCatalogSpec): Promise<HarnessModelCatalog> {
    const discover = spec.discover;
    if (!discover) {
      return { choices: [...spec.shipped], source: "shipped", refreshedAt: null, problem: null };
    }

    const controller = new AbortController();
    this.controllers.set(agent, controller);
    let result: Awaited<ReturnType<ModelCatalogDiscover>>;
    try {
      result = await discover(controller.signal);
    } catch {
      result = { ok: false, problem: "process_failed" };
    } finally {
      if (this.controllers.get(agent) === controller) this.controllers.delete(agent);
    }

    if (result.ok) {
      const parsed = HarnessModelChoiceSchema.array()
        .min(1)
        .max(HARNESS_MODEL_CATALOG_LIMITS.choices)
        .safeParse(result.choices);
      if (parsed.success) {
        const refreshedAtMs = this.now();
        const choices = parsed.data;
        this.cache.set(agent, { choices, refreshedAtMs });
        return {
          choices: [...choices],
          source: "live",
          refreshedAt: new Date(refreshedAtMs).toISOString(),
          problem: null,
        };
      }
      result = { ok: false, problem: "invalid_response" };
    }

    return this.degraded(agent, spec, result.problem);
  }

  private degraded(
    agent: AgentType,
    spec: ModelCatalogSpec,
    problem: HarnessModelCatalog["problem"],
  ): HarnessModelCatalog {
    const cached = this.cache.get(agent);
    if (cached) {
      return {
        choices: [...cached.choices],
        source: "cached",
        refreshedAt: new Date(cached.refreshedAtMs).toISOString(),
        problem,
      };
    }
    return {
      choices: [...spec.shipped],
      source: "fallback",
      refreshedAt: null,
      problem,
    };
  }
}
