import assert from "node:assert/strict";
import test from "node:test";
import type { z } from "zod";
import { ENSEMBLE_LIMITS } from "../src/shared/ensemble.ts";
import { LLM_JOB_IDS } from "../src/shared/llm-jobs.ts";
import {
  BacklogPlanSchema,
  CONDUCTOR_EVENT_MAX_KEYS,
  ConductorIngestEnvelopeSchema,
  CreateReviewSchema,
  EnsembleActionSchema,
  ForemanConfigPatchSchema,
  HOOK_PR_URLS_MAX,
  HookIngestSchema,
  LlmConfigPatchSchema,
  OTLP_METRICS_LIMITS,
  OtlpMetricsSchema,
  PLAN_DECISION_LIMITS,
  PlanDecisionAnswerSchema,
  PlanDecisionSchema,
  QUEUE_REORDER_MAX,
  REPO_ALLOWLIST_MAX,
  RecordEpisodeSchema,
  ReorderQueueSchema,
  ResolveReviewSchema,
  SKILLS_CONFIG_MAX_ENTRIES,
  SkillsConfigPatchSchema,
  StandingInstructionsUpdateSchema,
  UI_CONFIG_LIST_MAX,
  UiConfigPatchSchema,
  WORKTREES_CONFIG_LIMITS,
  WorktreesConfigPatchSchema,
} from "../src/shared/protocol.ts";
import { MAX_INDEXED_DIRECTORIES, RepoIndexConfigPatchSchema } from "../src/shared/repo-index.ts";
import { STANDING_INSTRUCTIONS_MAX_REPOSITORIES } from "../src/shared/standing-instructions.ts";
import { GithubIssuesConfigSchema } from "../src/shared/task-source.ts";
import { TELEMETRY_INGRESS_LIMITS, TelemetryIngressRequestSchema } from "../src/shared/telemetry-ingress.ts";

/**
 * The request collection limits, each at its own edge.
 *
 * `request-collection-bounds.test.ts` proves a bound EXISTS on every collection a request
 * reaches; it would still pass if one were set to 1 or to a billion. These pin the number:
 * exactly the limit parses, one more is refused, and one more made of elements that would each
 * fail is refused by its SIZE alone - one `too_big` at the collection, before any element is
 * looked at (GHSA-mrhx-c7xc-m3w5).
 */

const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.success ? [] : result.error.issues.map((issue) => [issue.code, issue.path.join(".")]);

interface Limit {
  name: string;
  schema: z.ZodType;
  max: number;
  /** The collection's path, as an issue reports it. */
  path: string;
  /** A request whose collection holds `n` elements, every one valid or every one not. */
  build(n: number, valid: boolean): unknown;
}

const option = (i: number, valid: boolean) => (valid ? { id: `o${i}`, label: `Option ${i}` } : { garbage: i });
const decision = (i: number, valid: boolean) =>
  valid ? { id: `d${i}`, question: `Question ${i}?`, options: [option(0, true)] } : { garbage: i };
const answer = (i: number, valid: boolean) => (valid ? { decisionId: `d${i}`, selected: [] } : { garbage: i });

/** An OTLP export with one of everything, and `n` elements at the named level. */
function otlp(level: keyof typeof OTLP_METRICS_LIMITS, n: number, valid: boolean): unknown {
  const at = <T>(here: keyof typeof OTLP_METRICS_LIMITS, one: () => T) =>
    level === here ? times(n, () => (valid ? one() : 5)) : [one()];
  const attribute = () => ({ key: "model", value: { stringValue: "claude" } });
  const dataPoint = () => ({ asDouble: 1, timeUnixNano: "1", attributes: at("attributes", attribute) });
  const metric = () => ({ name: "claude_code.cost.usage", sum: { aggregationTemporality: 1, dataPoints: at("dataPoints", dataPoint) } });
  const scope = () => ({ metrics: at("metrics", metric) });
  return { resourceMetrics: at("resourceMetrics", () => ({ scopeMetrics: at("scopeMetrics", scope) })) };
}

/** `n` keys, each holding `value(i)`. */
const keyed = (n: number, value: (i: number) => unknown) => Object.fromEntries(times(n, (i) => [`k${i}`, value(i)]));

const LIMITS: Limit[] = [
  {
    name: "plan decision options",
    schema: PlanDecisionSchema,
    max: PLAN_DECISION_LIMITS.options,
    path: "options",
    build: (n, valid) => ({ id: "d", question: "Which?", options: times(n, (i) => option(i, valid)) }),
  },
  {
    name: "plan-decisions review decisions",
    schema: CreateReviewSchema,
    max: PLAN_DECISION_LIMITS.decisions,
    path: "decisions",
    build: (n, valid) => ({ env: {}, kind: "plan-decisions", title: "Plan", body: "", decisions: times(n, (i) => decision(i, valid)) }),
  },
  {
    name: "selected options in one answer",
    schema: PlanDecisionAnswerSchema,
    max: PLAN_DECISION_LIMITS.options,
    path: "selected",
    build: (n, valid) => ({ decisionId: "d", selected: times(n, (i) => (valid ? `o${i}` : i)) }),
  },
  {
    name: "answers in one resolution",
    schema: ResolveReviewSchema,
    max: PLAN_DECISION_LIMITS.decisions,
    path: "selections",
    build: (n, valid) => ({ action: "answer", selections: times(n, (i) => answer(i, valid)) }),
  },
  ...(Object.keys(OTLP_METRICS_LIMITS) as (keyof typeof OTLP_METRICS_LIMITS)[]).map((level): Limit => ({
    name: `OTLP ${level}`,
    schema: OtlpMetricsSchema,
    max: OTLP_METRICS_LIMITS[level],
    path: {
      resourceMetrics: "resourceMetrics",
      scopeMetrics: "resourceMetrics.0.scopeMetrics",
      metrics: "resourceMetrics.0.scopeMetrics.0.metrics",
      dataPoints: "resourceMetrics.0.scopeMetrics.0.metrics.0.sum.dataPoints",
      attributes: "resourceMetrics.0.scopeMetrics.0.metrics.0.sum.dataPoints.0.attributes",
    }[level],
    build: (n, valid) => otlp(level, n, valid),
  })),
  {
    name: "browser telemetry facts",
    schema: TelemetryIngressRequestSchema,
    max: TELEMETRY_INGRESS_LIMITS.maxFactsPerRecord,
    path: "records.0.facts",
    // A record's facts are `unknown` here - its event's own schema reads them later - so only
    // the count can make them invalid at this layer.
    build: (n) => ({ records: [{ event: "mission.feature.entry", facts: keyed(n, (i) => i) }] }),
  },
  {
    name: "pull requests on one hook event",
    schema: HookIngestSchema,
    max: HOOK_PR_URLS_MAX,
    path: "prUrls",
    build: (n, valid) => ({ event: "Stop", env: {}, prUrls: times(n, (i) => (valid ? `https://github.com/o/r/pull/${i}` : "not a url")) }),
  },
  {
    name: "queue reorder ids",
    schema: ReorderQueueSchema,
    max: QUEUE_REORDER_MAX,
    path: "ids",
    build: (n, valid) => ({ ids: times(n, (i) => (valid ? `item-${i}` : "")) }),
  },
  {
    name: "Foreman repository allowlist",
    schema: ForemanConfigPatchSchema,
    max: REPO_ALLOWLIST_MAX,
    path: "repoAllowlist",
    build: (n, valid) => ({ repoAllowlist: times(n, (i) => (valid ? `/repos/r${i}` : "")) }),
  },
  {
    name: "UI staged trust list",
    schema: UiConfigPatchSchema,
    max: UI_CONFIG_LIST_MAX,
    path: "trustStaged",
    build: (n, valid) => ({ trustStaged: times(n, (i) => (valid ? `/repos/r${i}` : "")) }),
  },
  {
    name: "UI keybindings",
    schema: UiConfigPatchSchema,
    max: UI_CONFIG_LIST_MAX,
    path: "keybindings",
    build: (n, valid) => ({ keybindings: keyed(n, () => (valid ? "mod+k" : 5)) }),
  },
  {
    name: "skill rows",
    schema: SkillsConfigPatchSchema,
    max: SKILLS_CONFIG_MAX_ENTRIES,
    path: "skills",
    build: (n, valid) => ({ skills: keyed(n, () => (valid ? true : "yes")) }),
  },
  {
    name: "per-job model overrides",
    schema: LlmConfigPatchSchema,
    max: LLM_JOB_IDS.length,
    path: "models",
    // Only the job ids are valid keys, so the over-limit request is necessarily one more key.
    build: (n, valid) => ({ models: Object.fromEntries(times(n, (i) => [LLM_JOB_IDS[i] ?? `extra-${i}`, valid ? "" : 5])) }),
  },
  {
    name: "worktree repository overrides",
    schema: WorktreesConfigPatchSchema,
    max: WORKTREES_CONFIG_LIMITS.maxRepositories,
    path: "repositories",
    build: (n, valid) => ({ repositories: keyed(n, () => (valid ? { enabled: true } : 5)) }),
  },
  {
    name: "standing-instruction repositories",
    schema: StandingInstructionsUpdateSchema,
    max: STANDING_INSTRUCTIONS_MAX_REPOSITORIES,
    path: "repositories",
    build: (n, valid) => ({ expectedEtag: "etag", repositories: keyed(n, () => (valid ? "Run the tests." : 5)) }),
  },
  {
    name: "backlog plan dependencies",
    schema: BacklogPlanSchema,
    max: 500,
    path: "entries.0.dependsOn",
    build: (n, valid) => ({ entries: [{ taskId: "t", dependsOn: times(n, (i) => (valid ? `t${i}` : "")) }] }),
  },
  {
    name: "terminal menu options on an episode",
    schema: RecordEpisodeSchema,
    max: 100,
    path: "menu.options",
    build: (n, valid) => ({
      marker: "m",
      situation: "s",
      surface: "terminal",
      question: "Proceed?",
      disposition: "pending",
      menu: { options: times(n, (i) => (valid ? { number: i + 1, label: `Choice ${i}` } : { garbage: i })), highlighted: 1 },
    }),
  },
  {
    name: "conductor event keys",
    schema: ConductorIngestEnvelopeSchema,
    max: CONDUCTOR_EVENT_MAX_KEYS,
    path: "event",
    // The event is recorded verbatim and unread, so only its size can be refused here.
    build: (n) => ({ repo: "/repos/r", seq: 0, event: keyed(n, (i) => i) }),
  },
  {
    name: "indexed directories",
    schema: RepoIndexConfigPatchSchema,
    max: MAX_INDEXED_DIRECTORIES * 16,
    path: "directories",
    build: (n, valid) => ({ directories: times(n, (i) => (valid ? { path: `/dirs/d${i}` } : { path: "" })) }),
  },
  {
    name: "GitHub label priorities",
    schema: GithubIssuesConfigSchema,
    max: 100,
    path: "priorityFrom",
    build: (n, valid) => ({ priorityFrom: keyed(n, () => (valid ? "high" : "urgent")) }),
  },
];

for (const limit of LIMITS) {
  test(`${limit.name}: exactly ${limit.max} parse, and one more is refused by its size alone`, () => {
    assert.deepEqual(issuesOf(limit.schema.safeParse(limit.build(limit.max, true))), [], "the limit itself is accepted");
    assert.deepEqual(issuesOf(limit.schema.safeParse(limit.build(limit.max + 1, true))), [["too_big", limit.path]]);
    // One more of elements that would each fail: still the one size issue, so none was parsed.
    assert.deepEqual(issuesOf(limit.schema.safeParse(limit.build(limit.max + 1, false))), [["too_big", limit.path]]);
  });
}

// ---------------------------------------------------------------------------
// The ensemble decision selection: a recursive JSON value, bounded at every depth.
// ---------------------------------------------------------------------------

const SELECTION_MAX = ENSEMBLE_LIMITS.decisionSelectionEntries;

/** A `decide` action carrying `selection`, as `POST /api/ensembles/:id/actions` reads it. */
const decide = (selection: unknown) =>
  EnsembleActionSchema.safeParse({ kind: "decide", requestId: "req-1", expectedStatus: "waiting", selection, confirmDestructive: true });

/**
 * Every leaf issue under `issues`, each with its ABSOLUTE path. A JSON value is a union, so a
 * refusal is an `invalid_union` whose branches each say why they did not match, with paths
 * relative to the union that raised them.
 */
function leaves(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): { code: string; path: string; maximum?: number }[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) return issue.errors.flatMap((branch) => leaves(branch, path));
    return [{ code: issue.code, path: path.map(String).join("."), maximum: (issue as { maximum?: number }).maximum }];
  });
}

/** The selection was refused by the size of the container at `path`, and none of its entries was parsed. */
function assertRefusedForSize(result: ReturnType<typeof decide>, path: string) {
  assert.equal(result.success, false);
  assert.equal(result.error!.issues.length, 1, "one refusal for the whole selection");
  const found = leaves(result.error!.issues);
  assert.deepEqual(found.filter((leaf) => leaf.code === "too_big"), [{ code: "too_big", path, maximum: SELECTION_MAX }]);
  assert.deepEqual(found.filter((leaf) => leaf.path.startsWith(`${path}.`)), [], "no entry of the oversized container was parsed");
}

const list = (n: number, entry: unknown = 1) => Array.from({ length: n }, () => entry);
const map = (n: number, entry: unknown = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, entry]));
/**
 * An entry no JSON value accepts: the number branch is `.finite()`. Not `undefined`, which a
 * defaulted helper parameter would quietly replace with a valid entry.
 */
const INVALID = Number.POSITIVE_INFINITY;

for (const [shape, container] of [["array", list], ["object", map]] as const) {
  test(`an ensemble selection ${shape} takes ${SELECTION_MAX} entries, and one more is refused by its size alone`, () => {
    assert.equal(decide(container(SELECTION_MAX)).success, true, "the limit itself is accepted");
    assertRefusedForSize(decide(container(SELECTION_MAX + 1)), "selection");
    // The control: within the limit the same entries ARE parsed, and each is refused below the
    // container - so their absence above the limit means none was looked at.
    const parsed = leaves(decide(container(SELECTION_MAX, INVALID)).error!.issues);
    assert.ok(parsed.filter((leaf) => leaf.path.startsWith("selection.")).length >= SELECTION_MAX, "every invalid entry was refused");
    assertRefusedForSize(decide(container(SELECTION_MAX + 1, INVALID)), "selection");
  });

  test(`a nested ensemble selection ${shape} is bounded too`, () => {
    assert.equal(decide({ outer: [container(SELECTION_MAX)] }).success, true);
    const parsed = leaves(decide({ outer: [container(SELECTION_MAX, INVALID)] }).error!.issues);
    assert.ok(parsed.filter((leaf) => leaf.path.startsWith("selection.outer.0.")).length >= SELECTION_MAX, "every invalid entry was refused");
    assertRefusedForSize(decide({ outer: [container(SELECTION_MAX + 1, INVALID)] }), "selection.outer.0");
  });
}
