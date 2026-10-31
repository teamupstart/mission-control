import { HARNESS_CAPABILITIES } from "./harness-capabilities.ts";
// Resident profiles: named, revisioned bundles of persona, instructions, harness, model,
// effort and workspace that launch a long-running `resident` task in the Agent SDK.
//
// Browser-safe and free of `node:` imports. The daemon validates request bodies and stored
// revisions with these schemas; the dashboard renders the same section registry, so the
// editor, the store and the launch read one definition of a profile.
//
// Three registries live in this feature and later phases extend them by appending:
//
// - `RESIDENT_PROFILE_SECTIONS` (here): the named section schemas a revision is made of.
// - `RESIDENT_EDITOR_SECTIONS` (`src/web/residents/editor-sections.tsx`): how each section is
//   edited.
// - `RESIDENT_LAUNCH_CONTRIBUTORS` (`src/server/residents/launch.ts`): what each section adds
//   to an SDK launch.
//
// A section added later is optional with a default, so a revision saved before it existed
// parses unchanged. Revisions are immutable; a live run reads only the revision it pinned.

import { z } from "zod";
import { supportsEffort } from "./harness-capabilities.ts";
import { ModelIdSchema } from "./model-id.ts";
import { STANDING_INSTRUCTIONS_MAX_LENGTH } from "./standing-instructions.ts";
import { THINKING_LEVELS } from "./types.ts";
import type { AgentType } from "./types.ts";

export const RESIDENT_OPERATOR_PAUSE_REASON = "Paused by operator";

/**
 * The harnesses a resident may run on, in picker order.
 *
 * A product decision rather than a capability inference: Pi also has an SDK runtime, and the
 * first release deliberately ships Claude Code and Codex only. The daemon additionally
 * requires the harness to declare an SDK driver before it saves or launches a profile.
 */
export const RESIDENT_AGENTS = ["claude", "codex"] as const satisfies readonly AgentType[];
export type ResidentAgent = (typeof RESIDENT_AGENTS)[number];

export function isResidentAgent(agent: AgentType): agent is ResidentAgent {
  return (RESIDENT_AGENTS as readonly AgentType[]).includes(agent);
}

export const RESIDENT_LIMITS = {
  nameLength: 80,
  descriptionLength: 500,
  instructionsLength: STANDING_INSTRUCTIONS_MAX_LENGTH,
  runInstructionsLength: 4_000,
  pathLength: 4_096,
  requestIdLength: 200,
  /**
   * Live profiles one machine may hold, and therefore the bound on the `residentProfiles`
   * SSE collection. Creation past it is refused rather than truncated, so the snapshot never
   * silently drops a profile an operator can see on the page.
   */
  liveProfiles: 200,
  /**
   * Archived profiles a settings snapshot carries, most recently archived first. Archive never
   * deletes rows, so history is unbounded; this keeps the resident catalog to (200 + 200)
   * profiles. Large instruction and loop text is checked against the snapshot file limit
   * in the backup tests. See `docs/residents.md`.
   */
  archivedInSnapshot: 200,
} as const;

/** Who the profile is. The name is unique among live profiles. */
export const ResidentIdentitySectionSchema = z.object({
  name: z.string().trim().min(1, "a resident needs a name").max(RESIDENT_LIMITS.nameLength),
  description: z.string().max(RESIDENT_LIMITS.descriptionLength).default(""),
});

/**
 * The Library Persona whose guidance becomes the resident's standing role, or `""` for none: a
 * resident may run on its profile instructions alone. `residentRoleProblem` refuses a profile
 * with neither.
 */
export const ResidentPersonaSectionSchema = z.object({
  personaId: z.string().max(200).default(""),
});

/** Markdown added after the persona, if any, in the resident's standing instructions. */
export const ResidentInstructionsSectionSchema = z.object({
  markdown: z.string().max(RESIDENT_LIMITS.instructionsLength).default(""),
});

/**
 * Which harness runs the resident, and with what model and effort. `null` follows the
 * harness's own default at launch.
 */
export const ResidentExecutionSectionSchema = z
  .object({
    agent: z.enum(RESIDENT_AGENTS).default("claude"),
    model: ModelIdSchema.nullable().default(null),
    effort: z.enum(THINKING_LEVELS).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.effort !== null && !supportsEffort(value.agent, value.effort)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effort"],
        message: `reasoning effort ${value.effort} is not supported by ${value.agent}`,
      });
    }
  });

/** The repository Dispatch pre-fills; null launches in a Mission-owned workspace. */
export const ResidentWorkspaceSectionSchema = z.object({
  defaultRepoRoot: z.string().trim().min(1).max(RESIDENT_LIMITS.pathLength).nullable().default(null),
});

/**
 * The marker palette: the colors a resident's border glow may take, in swatch order.
 *
 * Persisted by id in `board.colorId`, so the list is APPEND-ONLY: never rename, reorder or
 * remove an id. Each id names a CSS token, `--resident-<id>` in `src/web/styles.css`, so a color
 * is always a themed token and never an arbitrary value a profile could carry. The first entry
 * is the default.
 */
export const RESIDENT_MARKER_COLORS = [
  { id: "cyan", label: "Cyan" },
  { id: "violet", label: "Violet" },
  { id: "amber", label: "Amber" },
  { id: "rose", label: "Rose" },
  { id: "lime", label: "Lime" },
  { id: "blue", label: "Blue" },
  { id: "orange", label: "Orange" },
  { id: "teal", label: "Teal" },
] as const;
export type ResidentMarkerColorId = (typeof RESIDENT_MARKER_COLORS)[number]["id"];
export const RESIDENT_MARKER_COLOR_IDS = RESIDENT_MARKER_COLORS.map((color) => color.id);
export const RESIDENT_MARKER_LABEL_MAX = 4;

/**
 * The color a stored id draws as. An id this build does not know - one a newer build appended -
 * draws as the first color rather than failing the whole revision, which is why the schema
 * below accepts any token-shaped id and only the editor restricts the choice.
 */
export function residentMarkerColor(id: string): ResidentMarkerColorId {
  return (RESIDENT_MARKER_COLOR_IDS as readonly string[]).includes(id)
    ? (id as ResidentMarkerColorId)
    : RESIDENT_MARKER_COLORS[0].id;
}

/**
 * How the resident is found on the board: its border-glow color, the label on its chip, and
 * whether its sessions sort first in their column. A live run reads these from its pinned
 * revision, so editing them reaches the next launch, never a running resident.
 */
export const ResidentBoardSectionSchema = z.object({
  colorId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/, "marker color must be a palette id")
    .default(RESIDENT_MARKER_COLORS[0].id),
  /** The chip's text. `null` derives it from the name (`residentMarkerLabel`). */
  label: z
    .string()
    .trim()
    .min(1, "a marker label needs at least one character")
    .max(RESIDENT_MARKER_LABEL_MAX, `a marker label is at most ${RESIDENT_MARKER_LABEL_MAX} characters`)
    .nullable()
    .default(null),
  pin: z.boolean().default(true),
});
export type ResidentBoardSection = z.infer<typeof ResidentBoardSectionSchema>;

/**
 * What the resident may do beyond its own session. Off by default.
 *
 * `controlOtherSessions` does not grant anything by itself: it says the run MAY receive the
 * existing session-control grant, and the only thing that gives it is the operator's Launch click
 * in the desktop app (`docs/security.md`, Delegated session control). A launch from anywhere else
 * starts without control. A live run reads this from its pinned revision.
 */
export const ResidentAuthoritySectionSchema = z.object({
  controlOtherSessions: z.boolean().default(false),
});
export type ResidentAuthoritySection = z.infer<typeof ResidentAuthoritySectionSchema>;

/** How many MCP servers one profile may select. */
export const RESIDENT_MCP_SELECTION_MAX = 32;

/**
 * One selected MCP server. A global server is named by the harness whose configuration holds
 * it, so a profile that changes harness cannot silently keep another harness's server. A custom
 * server is named by its Mission Control id, so renaming it does not break the selection.
 */
export const ResidentMcpServerRefSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("global"),
    agent: z.enum(RESIDENT_AGENTS),
    name: z.string().min(1).max(128),
  }),
  z.object({
    source: z.literal("custom"),
    id: z.string().uuid("a custom MCP server is named by its id"),
  }),
]);
export type ResidentMcpServerRef = z.infer<typeof ResidentMcpServerRefSchema>;

/** The stable identity of a selection, for de-duplication and comparison. */
export function residentMcpRefKey(ref: ResidentMcpServerRef): string {
  return ref.source === "global" ? `global:${ref.agent}:${ref.name}` : `custom:${ref.id}`;
}

/**
 * Which MCP servers a run starts with, besides Mission Control's own, which is always attached.
 *
 * `inheritDefaults` adds every global server the harness configures at launch; the selection is
 * added either way. A run snapshots the resulting set at launch and never reads the native
 * configuration again, so a later edit there reaches the next launch only.
 */
export const ResidentMcpSectionSchema = z
  .object({
    inheritDefaults: z.boolean().default(true),
    selected: z
      .array(ResidentMcpServerRefSchema)
      .max(RESIDENT_MCP_SELECTION_MAX, `a profile selects at most ${RESIDENT_MCP_SELECTION_MAX} MCP servers`)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const keys = value.selected.map(residentMcpRefKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selected"], message: "an MCP server is selected twice" });
    }
  });
export type ResidentMcpSection = z.infer<typeof ResidentMcpSectionSchema>;

/** A string's user-perceived characters, so an accented letter or an emoji counts once. */
function graphemes(text: string): string[] {
  return [...new Intl.Segmenter("en-US", { granularity: "grapheme" }).segment(text)]
    .map((part) => part.segment);
}

/**
 * The label a name gives when the profile sets none: the initials of a multi-word name
 * ("Triage Bot" is TB, "Docs Gardener Weekly" is DGW), or the first three letters of a single
 * word ("Triage" is TRI), upper-cased.
 *
 * Capped at `RESIDENT_MARKER_LABEL_MAX` characters AFTER upper-casing, counted by grapheme:
 * upper-casing can lengthen text (`ß` becomes `SS`), so four initials can become eight.
 */
export function defaultResidentMarkerLabel(name: string): string {
  // Combining marks (`\p{M}`) belong to the word they decorate: a decomposed `é` is one letter.
  const words = name.trim().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "RES";
  const label = words.length === 1
    ? graphemes(words[0]!).slice(0, 3).join("")
    : words.slice(0, RESIDENT_MARKER_LABEL_MAX).map((word) => graphemes(word)[0]).join("");
  return graphemes(label.toLocaleUpperCase("en-US")).slice(0, RESIDENT_MARKER_LABEL_MAX).join("");
}

/** What a revision draws on the board: the resolved color, chip label and pin. */
export interface ResidentMarker {
  colorId: ResidentMarkerColorId;
  label: string;
  pin: boolean;
}

export function residentMarker(settings: Pick<ResidentProfileRevision, "identity" | "board">): ResidentMarker {
  return {
    colorId: residentMarkerColor(settings.board.colorId),
    label: settings.board.label ?? defaultResidentMarkerLabel(settings.identity.name),
    pin: settings.board.pin,
  };
}

/**
 * The named sections a profile revision is composed of, in editor order.
 *
 * Append a section here, with `.default({})` when its own fields all have defaults, and the
 * revision schema below picks it up. Never rename a key: it is the JSON key every stored
 * revision carries.
 */
export const RESIDENT_LOOP_PROMPT = "Continue your standing task. Check what has changed since your last iteration, act on it, and end with a one-line status. Call `schedule_next_iteration` if you need to wake sooner or later than usual.";

export const ResidentLoopSectionSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000).default(RESIDENT_LOOP_PROMPT),
  delaySeconds: z.number().int().min(1).max(604_800).default(300),
  minDelaySeconds: z.number().int().min(1).max(604_800).default(60),
  maxDelaySeconds: z.number().int().min(1).max(604_800).default(3_600),
  iterationCap: z.number().int().positive().max(100_000).nullable().default(200),
  spendCapUsd: z.number().positive().max(100_000).nullable().default(20),
  contextThreshold: z.number().min(1).max(95).default(70),
  compactionFocus: z.string().max(2_000).default(""),
}).refine((value) => value.minDelaySeconds <= value.maxDelaySeconds, {
  message: "minimum delay must not exceed maximum delay", path: ["minDelaySeconds"],
});
export type ResidentLoopSettings = z.infer<typeof ResidentLoopSectionSchema>;

export const ScheduleNextIterationSchema = z.object({
  delaySeconds: z.number().finite().nonnegative().max(31_536_000),
  reason: z.string().trim().max(500).default(""),
  callId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
export type ResidentPacingRequest = z.infer<typeof ScheduleNextIterationSchema>;
export interface ResidentPacingReceipt {
  callId: string;
  delaySeconds: number;
  pending: boolean;
  nextWakeAt: number | null;
}

/** Append-only persisted loop states. */
export type ResidentLoopState = "working" | "waiting" | "compacting" | "paused" | "ended";
export interface ResidentLoopStatus {
  loopState: ResidentLoopState;
  iteration: number;
  lastSeq: number;
  nextWakeAt: number | null;
  consumedGeneration: number | null;
  pauseReason: string | null;
  wakeReason: string | null;
}

export const RESIDENT_PROFILE_SECTIONS = {
  identity: ResidentIdentitySectionSchema,
  persona: ResidentPersonaSectionSchema.default({}),
  instructions: ResidentInstructionsSectionSchema.default({}),
  execution: ResidentExecutionSectionSchema.default({}),
  workspace: ResidentWorkspaceSectionSchema.default({}),
  board: ResidentBoardSectionSchema.default({}),
  authority: ResidentAuthoritySectionSchema.default({}),
  loop: ResidentLoopSectionSchema.default({}),
  mcp: ResidentMcpSectionSchema.default({}),
} as const;

export type ResidentProfileSectionId = keyof typeof RESIDENT_PROFILE_SECTIONS;
export const RESIDENT_PROFILE_SECTION_IDS = Object.keys(
  RESIDENT_PROFILE_SECTIONS,
) as ResidentProfileSectionId[];

/**
 * One immutable profile revision, as stored and as read back.
 *
 * Not `.strict()`: a revision written by a newer build may carry a section this build does
 * not know, and reading it must still succeed. Request bodies use the strict variant.
 */
export const ResidentProfileRevisionSchema = z.object(RESIDENT_PROFILE_SECTIONS);
export type ResidentProfileRevision = z.infer<typeof ResidentProfileRevisionSchema>;
/** What an editor may submit before defaults apply. */
export type ResidentProfileRevisionInput = z.input<typeof ResidentProfileRevisionSchema>;

/** A stored revision as JSON, including any section or field a newer build wrote. */
export type StoredResidentSettings = Record<string, unknown>;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Carry forward what this build does not know.
 *
 * `known` is what this build parsed and validated - a request body, or a section it rewrote.
 * Every key `stored` holds that `known` lacks, at any depth, is copied over unchanged: a section
 * or a field a newer build added. Known keys always come from `known`, so validation of what
 * this build understands is never bypassed, and nothing it does not understand is dropped by
 * reading a revision and saving it again.
 */
export function preserveUnknownResidentSettings(
  stored: unknown,
  known: Record<string, unknown>,
): StoredResidentSettings {
  if (!plainObject(stored)) return { ...known };
  const out: Record<string, unknown> = { ...known };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in known)) out[key] = value;
    else if (plainObject(value) && plainObject(known[key])) {
      out[key] = preserveUnknownResidentSettings(value, known[key] as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Why a profile gives its resident no role: no Persona and no profile instructions. Checked on
 * save through the request schema and again at launch, never on read, so a stored revision is
 * always readable.
 */
export function residentRoleProblem(settings: Pick<ResidentProfileRevision, "persona" | "instructions">): string | null {
  return settings.persona.personaId === "" && settings.instructions.markdown.trim() === ""
    ? "choose a Persona or write profile instructions"
    : null;
}

/** The request-body form: unknown top-level sections are refused rather than dropped. */
export const ResidentProfileRevisionRequestSchema = ResidentProfileRevisionSchema.strict().superRefine((settings, ctx) => {
  const problem = residentRoleProblem(settings);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instructions", "markdown"], message: problem });
});

/** A profile as the catalog and the browser see it: the identity plus its current revision. */
export interface ResidentProfile {
  id: string;
  name: string;
  /** The current revision number; every save writes revision + 1. */
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** The current revision's body. New launches pin this revision. */
  settings: ResidentProfileRevision;
}

/**
 * The launch-state vocabulary of a resident run. Persisted in `resident_runs.launch_state`
 * and read back by exact value: append, never rename or reorder.
 */
export const RESIDENT_LAUNCH_STATES = ["pending", "launched", "failed"] as const;
export type ResidentLaunchState = (typeof RESIDENT_LAUNCH_STATES)[number];

/**
 * The persona text a run launched with, so a later Persona edit never reaches it. A run whose
 * profile names no Persona stores `null` in its place.
 */
export const ResidentPersonaSnapshotSchema = z.object({
  personaId: z.string(),
  name: z.string(),
  guidanceMarkdown: z.string(),
});
export type ResidentPersonaSnapshot = z.infer<typeof ResidentPersonaSnapshotSchema>;

/**
 * The session-control grant a run received from its desktop Launch click, as recorded in
 * `resident_runs`. Every field is null on a run that was never granted, including every run from
 * before this record existed.
 *
 * `authorizedAt` is written when the daemon consumed the click; the other three are the grant's
 * identity as it stood when the Registry applied it. After a daemon restart the grant is applied
 * again only when all four are set and the restored session's conversation, working directory,
 * work episode and task all still match. The process id, the one part of the Registry's identity a
 * restart necessarily changes, is the only part not recorded.
 */
export interface ResidentRunControl {
  authorizedAt: number | null;
  conversationId: string | null;
  cwd: string | null;
  episodeId: string | null;
}

/** A resident run: the durable identity of one launch. */
export interface ResidentRun extends ResidentLoopStatus {
  /** Mission-owned cwd awaiting cleanup; null for repository runs or after removal. */
  workspaceDir: string | null;
  id: string;
  profileId: string;
  /** The revision this run pinned. A live run reads its settings only from here. */
  profileRevision: number;
  /** Reserved before the task exists, so a crash between the two is recoverable. */
  taskId: string;
  launchRequestId: string;
  launchState: ResidentLaunchState;
  launchError: string | null;
  persona: ResidentPersonaSnapshot | null;
  runInstructions: string;
  /** The pinned revision's body. */
  settings: ResidentProfileRevision;
  /** The session-control grant its Launch click gave it, if any. */
  control: ResidentRunControl;
  createdAt: number;
  endedAt: number | null;
}

/**
 * The pinned-revision sections a live run's summary carries to the browser: the ones a board,
 * Console or dock surface draws from. A registry like `RESIDENT_PROFILE_SECTIONS`, extended the
 * same way - a later phase that shows its pinned settings in the browser (the loop's state in
 * the Console band) appends its section id here in one line. `authority` is here so the band
 * and the dock know whether a run asks for session control; the grant itself is the session's.
 *
 * Everything not listed stays on the daemon, which reads a run's whole pinned revision through
 * `ResidentStore.revision`. That keeps the profile instructions, the Persona id, the execution
 * and workspace choices, and every section a later phase adds for the daemon alone (skills, MCP
 * servers) off this event, which is re-sent on every launch-state change of every live run.
 */
export const RESIDENT_RUN_SUMMARY_SECTIONS = ["identity", "board", "authority", "loop"] as const satisfies readonly ResidentProfileSectionId[];
export type ResidentRunSummarySectionId = (typeof RESIDENT_RUN_SUMMARY_SECTIONS)[number];

/** The pinned revision as a run summary carries it: only `RESIDENT_RUN_SUMMARY_SECTIONS`. */
export type ResidentRunSummarySettings = Pick<ResidentProfileRevision, ResidentRunSummarySectionId>;

/**
 * A live run as the `residentRuns` SSE collection carries it: what the browser needs to join a
 * session to its run and draw it - the pinned revision's settings, projected to the sections
 * the browser draws - without the persona text, run instructions or launch input, which no
 * board surface reads.
 *
 * Only open runs (not ended, not failed) are in the collection, so it is bounded by the
 * residents actually running: each holds a live, non-terminal `resident` task.
 */
export interface ResidentRunSummary extends ResidentLoopStatus {
  compaction: { betweenIterations: boolean; nativeBackstop: boolean };
  id: string;
  profileId: string;
  profileRevision: number;
  taskId: string;
  launchState: Exclude<ResidentLaunchState, "failed">;
  /** Null when the run launched without a Persona. */
  personaName: string | null;
  /** The pinned revision's `RESIDENT_RUN_SUMMARY_SECTIONS`, never the profile's current one. */
  settings: ResidentRunSummarySettings;
  createdAt: number;
}

/** Project a pinned revision to the sections a run summary carries. */
export function residentRunSummarySettings(settings: ResidentProfileRevision): ResidentRunSummarySettings {
  return Object.fromEntries(
    RESIDENT_RUN_SUMMARY_SECTIONS.map((id) => [id, settings[id]]),
  ) as ResidentRunSummarySettings;
}

/** The wire summary of a run, or null when the run is not live and leaves the collection. */
export function residentRunSummary(run: ResidentRun): ResidentRunSummary | null {
  if (run.endedAt !== null || run.launchState === "failed") return null;
  return {
    id: run.id,
    profileId: run.profileId,
    profileRevision: run.profileRevision,
    taskId: run.taskId,
    launchState: run.launchState,
    personaName: run.persona?.name ?? null,
    compaction: HARNESS_CAPABILITIES[run.settings.execution.agent].residentCompaction!,
    loopState: run.loopState, iteration: run.iteration, lastSeq: run.lastSeq,
    nextWakeAt: run.nextWakeAt, consumedGeneration: run.consumedGeneration,
    pauseReason: run.pauseReason, wakeReason: run.wakeReason,
    settings: residentRunSummarySettings(run.settings),
    createdAt: run.createdAt,
  };
}

/**
 * A launch request. `requestId` makes it idempotent: a repeated click, a lost response or two
 * racing requests with the same id produce one run, one task and one SDK dispatch.
 */
export const LaunchResidentSchema = z
  .object({
    repoRoot: z.string().trim().min(1).max(RESIDENT_LIMITS.pathLength).nullable().default(null),
    instructions: z.string().max(RESIDENT_LIMITS.runInstructionsLength).optional(),
    requestId: z
      .string()
      .min(1)
      .max(RESIDENT_LIMITS.requestIdLength)
      .regex(/^[A-Za-z0-9._:-]+$/, "request id must be a token"),
  })
  .strict();
export type LaunchResident = z.infer<typeof LaunchResidentSchema>;

/**
 * The version of the normalized launch input stored on a run. A later phase that adds a
 * launch field bumps this and gives the field a default in `ResidentLaunchInputSchema`, so a
 * run recorded at an older version still compares correctly.
 */
export const RESIDENT_LAUNCH_INPUT_VERSION = 2;

/**
 * The normalized launch input, as stored in `resident_runs.launch_input`: the parsed request
 * without `requestId`, with the repository resolved to its real path and the run
 * instructions as stored. Every field a later version adds carries a default.
 */
export const ResidentLaunchInputSchema = z.object({
  version: z.number().int().positive(),
  repoRoot: z.string().nullable(),
  instructions: z.string().default(""),
});
export type ResidentLaunchInput = z.infer<typeof ResidentLaunchInputSchema>;

/** Run instructions as stored: trimmed, so whitespace alone never makes two requests differ. */
export function normalizeRunInstructions(instructions: string | undefined): string {
  return instructions?.trim() ?? "";
}

/** Build the current-version normalized input from a request whose repository is resolved. */
export function residentLaunchInput(resolvedRepoRoot: string | null, instructions: string | undefined): ResidentLaunchInput {
  return {
    version: RESIDENT_LAUNCH_INPUT_VERSION,
    repoRoot: resolvedRepoRoot,
    instructions: normalizeRunInstructions(instructions),
  };
}

/** Canonical JSON: sorted keys at every level, so equal inputs serialize to equal bytes. */
export function canonicalResidentJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

/**
 * Re-read a stored input through the current schema and restate it at the current version,
 * or null when it cannot be read. The comparison is then over meaning, not over the version
 * that happened to write it.
 */
export function normalizeStoredLaunchInput(raw: unknown): ResidentLaunchInput | null {
  const parsed = ResidentLaunchInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, version: RESIDENT_LAUNCH_INPUT_VERSION };
}

/** Whether a replayed request asks for exactly what the stored run recorded. */
export function launchInputsMatch(stored: unknown, request: ResidentLaunchInput): boolean {
  const normalized = normalizeStoredLaunchInput(stored);
  if (!normalized) return false;
  return canonicalResidentJson(normalized) === canonicalResidentJson({
    ...request,
    version: RESIDENT_LAUNCH_INPUT_VERSION,
  });
}

/** The opening turn of a Phase 1 resident: its role arrives as standing instructions. */
export const RESIDENT_OPENING_TURN = "Begin your standing task.";

/**
 * What a launch answered. One union for the route, the browser helper and the tests, so a
 * replay and a first launch are read the same way.
 */
export type ResidentLaunchResult =
  | { state: "launched"; run: ResidentRun; taskId: string }
  | { state: "pending"; run: ResidentRun }
  | { state: "failed"; run: ResidentRun; error: string };

/**
 * The MCP part of the launch summary: whether the harness defaults ride along, and what is
 * selected. `labels` names the selection in order when the caller can resolve it (a custom
 * server's name lives in the custom-server catalog, not the profile); otherwise it is counted.
 */
export function residentMcpSummary(mcp: ResidentMcpSection, labels?: readonly string[]): string {
  const count = mcp.selected.length;
  const named = labels && labels.length === count ? labels.join(", ") : `${count} selected`;
  if (mcp.inheritDefaults) return count === 0 ? "MCP: defaults" : `MCP: defaults + ${named}`;
  return count === 0 ? "MCP: Mission only" : `MCP: only ${named}`;
}

/**
 * A short, human summary of what a launch will carry, for Dispatch's read-only line.
 * `personaName` is null when the profile's Persona cannot be found; a profile naming none says so.
 */
export function residentLaunchSummary(
  settings: ResidentProfileRevision,
  personaName: string | null,
  agentLabel: string,
  mcpLabels?: readonly string[],
): string {
  const parts = [
    settings.persona.personaId === "" ? "no persona" : personaName ? `persona ${personaName}` : "persona missing",
    settings.instructions.markdown.trim() ? "profile instructions" : "no profile instructions",
    agentLabel,
    settings.execution.model ?? "default model",
    settings.execution.effort ? `${settings.execution.effort} effort` : "default effort",
    residentMcpSummary(settings.mcp, mcpLabels),
    settings.authority.controlOtherSessions ? "control: on" : "control: off",
  ];
  return parts.join(" · ");
}

/** A run whose recorded grant is complete enough to be applied again after a restart. */
export function residentRunControlRecorded(control: ResidentRunControl): boolean {
  return control.authorizedAt !== null && control.conversationId !== null
    && control.cwd !== null && control.episodeId !== null;
}

/** No grant recorded: what every run starts with, and what turning control off returns it to. */
export const RESIDENT_RUN_NO_CONTROL: ResidentRunControl = Object.freeze({
  authorizedAt: null,
  conversationId: null,
  cwd: null,
  episodeId: null,
});
