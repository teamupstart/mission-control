import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { HARNESS_CAPABILITIES } from "@shared/harness-capabilities.ts";
import { MODEL_CATALOG, modelLabel } from "@shared/model.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import type {
  HarnessModelCatalog,
  HarnessModelCatalogChoice,
  HarnessModelCatalogProblem,
  HarnessModelCatalogs,
} from "@shared/protocol.ts";
import { Tooltip } from "./components/Tooltip.tsx";
import { fetchHarnessModelCatalogs } from "./lib/api.ts";

export type BrowserModelCatalogPhase = "local" | "loading" | "ready" | "failed";

export interface BrowserModelCatalogSnapshot {
  /** One atomic aggregate. Individual harnesses never update independently in the browser. */
  catalogs: HarnessModelCatalogs;
  phase: BrowserModelCatalogPhase;
  /** True only while the initial request or an operator-requested retry is in flight. */
  pending: boolean;
}

export type BrowserModelCatalogLoader = (
  refresh: boolean,
  signal: AbortSignal,
) => Promise<HarnessModelCatalogs | null>;

/** The synchronous first paint and the no-provider render-test boundary. */
export function shippedModelCatalogs(): HarnessModelCatalogs {
  return Object.fromEntries(
    AGENT_TYPES.map((agent) => [
      agent,
      {
        choices: [...MODEL_CATALOG[agent]],
        source: "shipped",
        refreshedAt: null,
        problem: null,
      },
    ]),
  ) as HarnessModelCatalogs;
}

const LOCAL_SNAPSHOT: BrowserModelCatalogSnapshot = {
  catalogs: shippedModelCatalogs(),
  phase: "local",
  pending: false,
};

/**
 * Request sequencing kept outside React so it can be tested without jsdom.
 *
 * A retry supersedes the initial read even when the old transport ignores AbortSignal. A
 * failed request changes only catalog quality; it never replaces the last usable choices.
 */
export class BrowserModelCatalogStore {
  private snapshot: BrowserModelCatalogSnapshot;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  private started = false;

  constructor(
    private readonly load: BrowserModelCatalogLoader = (refresh, signal) =>
      fetchHarnessModelCatalogs(refresh, signal),
    initial: BrowserModelCatalogSnapshot = {
      catalogs: shippedModelCatalogs(),
      phase: "loading",
      pending: true,
    },
  ) {
    this.snapshot = initial;
  }

  readonly getSnapshot = (): BrowserModelCatalogSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.request(false);
  }

  async retry(): Promise<void> {
    await this.request(true);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  private publish(snapshot: BrowserModelCatalogSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private async request(refresh: boolean): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({
      ...this.snapshot,
      phase: this.snapshot.phase === "local" ? "loading" : this.snapshot.phase,
      pending: true,
    });

    let catalogs: HarnessModelCatalogs | null = null;
    try {
      catalogs = await this.load(refresh, controller.signal);
    } catch {
      // A loader may be injected in tests or replaced later. Transport failure has the same
      // non-blocking meaning whether it returns null or throws.
    }
    if (controller.signal.aborted || generation !== this.generation) return;
    this.controller = null;
    this.publish(
      catalogs
        ? { catalogs, phase: "ready", pending: false }
        : { ...this.snapshot, phase: "failed", pending: false },
    );
  }
}

export interface ModelCatalogGroup {
  provider: string;
  choices: readonly HarnessModelCatalogChoice[];
}

export interface ResolvedHarnessModelCatalog {
  /** Server order, deduplicated by full provider-qualified id, then the retained value. */
  choices: readonly HarnessModelCatalogChoice[];
  /** First-seen provider order, with each provider's Pi order intact. */
  groups: readonly ModelCatalogGroup[];
  /** Rows without reported provider metadata, including a retained current value. */
  ungrouped: readonly HarnessModelCatalogChoice[];
  retained: HarnessModelCatalogChoice | null;
}

export type ResolveHarnessModelCatalog = (
  agent: AgentType,
  current?: string | null,
) => ResolvedHarnessModelCatalog;

/** Merge one consumer's current value without teaching the daemon where that value lives. */
export function resolveHarnessModelCatalog(
  catalog: HarnessModelCatalog,
  current?: string | null,
): ResolvedHarnessModelCatalog {
  const choices: HarnessModelCatalogChoice[] = [];
  const seen = new Set<string>();
  for (const choice of catalog.choices) {
    if (seen.has(choice.id)) continue;
    seen.add(choice.id);
    choices.push(choice);
  }

  const retained = current && !seen.has(current)
    ? {
        id: current,
        label: modelLabel(current) ?? current,
        hint: "not currently reported",
        provider: null,
        contextWindow: null,
        reasoning: null,
        inputModes: [],
      } satisfies HarnessModelCatalogChoice
    : null;
  if (retained) choices.push(retained);

  const grouped = new Map<string, HarnessModelCatalogChoice[]>();
  const ungrouped: HarnessModelCatalogChoice[] = [];
  for (const choice of choices) {
    if (choice.provider === null) {
      ungrouped.push(choice);
      continue;
    }
    const providerChoices = grouped.get(choice.provider);
    if (providerChoices) providerChoices.push(choice);
    else grouped.set(choice.provider, [choice]);
  }

  return {
    choices,
    groups: [...grouped].map(([provider, providerChoices]) => ({
      provider,
      choices: providerChoices,
    })),
    ungrouped,
    retained,
  };
}

interface ModelCatalogContextValue {
  snapshot: BrowserModelCatalogSnapshot;
  resolve: ResolveHarnessModelCatalog;
  retry: () => Promise<void>;
}

const LOCAL_RESOLVE: ResolveHarnessModelCatalog = (agent, current) =>
  resolveHarnessModelCatalog(LOCAL_SNAPSHOT.catalogs[agent], current);

const ModelCatalogContext = createContext<ModelCatalogContextValue>({
  snapshot: LOCAL_SNAPSHOT,
  resolve: LOCAL_RESOLVE,
  retry: async () => {},
});

export function ModelCatalogProvider({
  children,
  store: suppliedStore,
}: {
  children: React.ReactNode;
  /** Injectable only at the root/test boundary; consumers still see one context. */
  store?: BrowserModelCatalogStore;
}): React.JSX.Element {
  const [store] = useState(() => suppliedStore ?? new BrowserModelCatalogStore());
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, [store]);

  const resolve = useCallback<ResolveHarnessModelCatalog>(
    (agent, current) => resolveHarnessModelCatalog(snapshot.catalogs[agent], current),
    [snapshot.catalogs],
  );
  const value = useMemo<ModelCatalogContextValue>(
    () => ({ snapshot, resolve, retry: () => store.retry() }),
    [resolve, snapshot, store],
  );
  return <ModelCatalogContext.Provider value={value}>{children}</ModelCatalogContext.Provider>;
}

export function useHarnessModelCatalogs(): ModelCatalogContextValue {
  return useContext(ModelCatalogContext);
}

function optionText(
  choice: HarnessModelCatalogChoice,
  includeHints: boolean,
  retainedId: string | null,
): string {
  const hint = includeHints || choice.id === retainedId ? choice.hint : null;
  return hint ? `${choice.label} - ${hint}` : choice.label;
}

/** Native option markup shared by every model picker. */
export function ModelCatalogOptions({
  catalog,
  includeHints = true,
}: {
  catalog: ResolvedHarnessModelCatalog;
  includeHints?: boolean;
}): React.JSX.Element {
  const retainedId = catalog.retained?.id ?? null;
  if (catalog.groups.length === 0) {
    return (
      <>
        {catalog.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {optionText(choice, includeHints, retainedId)}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {catalog.groups.map((group) => (
        <optgroup key={group.provider} label={group.provider}>
          {group.choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {optionText(choice, includeHints, retainedId)}
            </option>
          ))}
        </optgroup>
      ))}
      {catalog.ungrouped.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {optionText(choice, includeHints, retainedId)}
        </option>
      ))}
    </>
  );
}

const PROBLEM_COPY: Record<HarnessModelCatalogProblem, (label: string) => string> = {
  unsupported: (label) => `This ${label} installation does not support model discovery.`,
  // A discovering harness answers with the models its signed-in accounts offer, so an
  // empty list is a report about the ACCOUNT, not about the catalog. Saying only that
  // nothing was reported left the one person who could fix it with nothing to act on;
  // `modelProviderSignIn` carries the act itself.
  unavailable: (label) =>
    `${label} reported no available models, which usually means it is not signed in to a model provider.`,
  invalid_response: (label) =>
    `${label} returned a model list Mission Control could not read.`,
  rpc_failed: (label) => `${label} could not return its model list.`,
  process_failed: (label) => `${label} model discovery could not start or finish.`,
  timeout: (label) => `${label} model discovery timed out.`,
  output_limit: (label) =>
    `${label} returned more catalog data than Mission Control can safely read.`,
};

/**
 * Problems a missing provider sign-in explains, and the only ones that earn the remedy.
 *
 * Deliberately just this one. `unavailable` is the harness answering successfully with an
 * empty list, which for an account-aware catalog IS the signed-out state - it is detection,
 * not a guess. A timeout or a crashed probe says nothing about credentials, and telling
 * someone to sign in when their Pi binary is missing sends them down the wrong path.
 */
const SIGN_IN_PROBLEMS: ReadonlySet<HarnessModelCatalogProblem> = new Set(["unavailable"]);

export interface ModelCatalogNoticeContent {
  message: string;
  /** The harness's sign-in sentence, when the reported problem is one sign-in explains. */
  remedy: string | null;
  retry: boolean;
  tone: "checking" | "degraded";
}

/** Pure copy decision, shared by all placements and pinned without a DOM. */
export function modelCatalogNoticeContent(
  snapshot: BrowserModelCatalogSnapshot,
  agent: AgentType,
): ModelCatalogNoticeContent | null {
  const catalog = snapshot.catalogs[agent];
  // The harness's own declaration, not a guess from the rows it happened to return. A
  // harness with no discovery has nothing to report and nothing to retry, so it stays
  // silent; see `ModelDiscoverySpec` for what asking the rows instead used to hide.
  //
  // Bound once rather than re-indexed, so this check NARROWS the union: past it,
  // `modelProviderSignIn` is a `string`, and there is no null left to decide about.
  const capabilities = HARNESS_CAPABILITIES[agent];
  if (!capabilities.discoversModels) return null;
  const label = AGENT_IDENTITY[agent].label;
  // Read from the harness's OWN reported problem, so a harness that answered normally
  // never carries another one's remedy, and a harness that reports nothing carries none.
  const remedy =
    catalog.problem && SIGN_IN_PROBLEMS.has(catalog.problem)
      ? capabilities.modelProviderSignIn
      : null;
  if (snapshot.phase === "local") return null;
  if (snapshot.phase === "loading") {
    return {
      message: `Checking ${label} for available models. Built-in choices remain available.`,
      remedy: null,
      retry: false,
      tone: "checking",
    };
  }

  if (snapshot.phase === "failed") {
    const lastKnown = catalog.source === "live" || catalog.source === "cached";
    return {
      message: lastKnown
        ? `Showing the last known ${label} model list because the catalog service could not be reached.`
        : `Showing built-in ${label} models because the catalog service could not be reached.`,
      // The browser never reached the daemon, so no harness reported anything about its
      // account. A transport failure is not evidence about credentials.
      remedy: null,
      retry: true,
      tone: "degraded",
    };
  }

  if (catalog.source === "cached" && catalog.problem) {
    return {
      message: `Showing the last known ${label} model list because refresh failed. ${PROBLEM_COPY[catalog.problem](label)}`,
      remedy,
      retry: true,
      tone: "degraded",
    };
  }
  if (catalog.source === "fallback") {
    return {
      message: `Showing built-in ${label} models because the local catalog could not be read.${catalog.problem ? ` ${PROBLEM_COPY[catalog.problem](label)}` : ""}`,
      remedy,
      retry: true,
      tone: "degraded",
    };
  }
  return null;
}

/** Compact catalog quality and retry control, reused beside every provider-backed picker. */
export function ModelCatalogNotice({ agent }: { agent: AgentType }): React.JSX.Element | null {
  const { snapshot, retry } = useHarnessModelCatalogs();
  const content = modelCatalogNoticeContent(snapshot, agent);
  if (!content) return null;
  const label = AGENT_IDENTITY[agent].label;
  return (
    <div
      className={`model-catalog-notice is-${content.tone}`}
      role="status"
      aria-live="polite"
    >
      <span>{content.message}</span>
      {content.remedy && <span className="model-catalog-remedy">{content.remedy}</span>}
      {content.retry && (
        <Tooltip label={`Ask ${label} for a fresh model list`}>
          <button
            type="button"
            className="model-catalog-retry"
            disabled={snapshot.pending}
            onClick={() => void retry()}
          >
            {snapshot.pending ? "Retrying…" : `Retry ${label} models`}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
