// What Settings > Task shaping shows, as pure functions over the config view the event stream
// holds. No React and no fetches, so the render tests and the panel read the same answers.
//
// The rules themselves are not restated here. Which shapers are on and in what order come from
// `shaperSwitchedOn` and `compareShapingOrder` in `@shared/shaping.ts`, the functions the
// daemon's resolver runs, so the list can never disagree with a launch. What a write does is
// the daemon's: `previewShapingIntent` only draws a click before its answer arrives.

import { z } from "zod";
import { SHAPING_STAGES } from "@shared/shaping-registry.ts";
import {
  canonicalJson,
  compareShapingOrder,
  moveInShapingOrder,
  shapingEntryRevision,
  ShaperManifestSchema,
  ShaperSchema,
  shaperIsLocal,
  shaperSwitchedOn,
  shapingReferences,
  TaskShapingSchema,
  type Shaper,
  type ShapingConfigView,
  type ShapingIntent,
  type ShapingReferenceStatus,
  type ShapingRun,
  type ShapingStage,
  type UnsupportedShaperView,
} from "@shared/shaping.ts";

/** An entry this build cannot run, as the view carries it: id, label and reason only. */
export function isUnsupportedShaper(entry: Shaper | UnsupportedShaperView): entry is UnsupportedShaperView {
  return "unsupported" in entry;
}

/** One registered shaper's row in the list. */
export interface ShapingListRow {
  id: string;
  label: string;
  /** The definition, or null for an entry that cannot run. */
  shaper: Shaper | null;
  /**
   * Whether it is switched on, by the resolver's own rule. For an entry that cannot run, its
   * stored choice: it never runs either way, but a stored on can still be switched off.
   */
  on: boolean;
  /** Why it cannot run, or null when it can. */
  problem: string | null;
  /** The entry's `shapingEntryRevision`, sent with any intent that acts on what this row shows. */
  revision: string;
}

/** Rows for one stage, in run order, or the entries that cannot run (`stage: null`). */
export interface ShapingListGroup {
  stage: ShapingStage | null;
  rows: ShapingListRow[];
}

/**
 * The list Settings draws: one group per stage in stage order, each in the order a launch runs
 * it, then the entries this build cannot run, in stored order. Every stage is listed, empty or
 * not, so the operator can see where a new shaper will land.
 */
export function shapingList(view: ShapingConfigView): ShapingListGroup[] {
  const known: Array<ShapingListRow & { position: number; stage: string }> = [];
  const unsupported: ShapingListRow[] = [];
  view.shapers.forEach((entry, position) => {
    if (isUnsupportedShaper(entry)) {
      unsupported.push({
        id: entry.id, label: entry.label, shaper: null,
        on: view.overrides[entry.id] === true, problem: entry.unsupported, revision: shapingEntryRevision(entry),
      });
      return;
    }
    known.push({
      id: entry.id, label: entry.label, shaper: entry, stage: entry.stage, position,
      on: shaperSwitchedOn(view, entry.id, "registered"), problem: null, revision: shapingEntryRevision(entry),
    });
  });
  known.sort(compareShapingOrder(view.order));
  const strip = ({ position: _position, stage: _stage, ...row }: (typeof known)[number]): ShapingListRow => row;
  const groups: ShapingListGroup[] = SHAPING_STAGES.map((stage) => ({
    stage, rows: known.filter((row) => row.stage === stage).map(strip),
  }));
  if (unsupported.length > 0) groups.push({ stage: null, rows: unsupported });
  return groups;
}

/**
 * The intent that moves one shaper a step within its stage, or null when it cannot move that way
 * (already first or last, or not a row the list draws). It names where the shaper goes - right
 * after a neighbour, or first - rather than a whole order, and the daemon applies it to the order
 * as stored when it arrives. So a move made in another window meanwhile is kept, a repeated
 * intent changes nothing, a shaper the list does not draw keeps its slot, and the daemon, which
 * knows the folder's shapers, decides what may make room when the order is full.
 */
export function moveIntent(view: ShapingConfigView, id: string, offset: -1 | 1): Extract<ShapingIntent, { kind: "move" }> | null {
  const group = shapingList(view).find((candidate) => candidate.stage !== null && candidate.rows.some((row) => row.id === id));
  if (!group) return null;
  const rows = group.rows.map((row) => row.id);
  const at = rows.indexOf(id);
  const to = at + offset;
  if (to < 0 || to >= rows.length) return null;
  const others = rows.filter((row) => row !== id);
  return { kind: "move", id, after: to === 0 ? null : others[to - 1]! };
}

/**
 * The view as it will look once the daemon applies `intent`, so a click shows at once. It is a
 * drawing, never the rule: the daemon's own `applyShapingIntent` decides, and the next frame
 * replaces this either way. An upsert that this build would refuse draws nothing.
 */
export function previewShapingIntent(view: ShapingConfigView, intent: ShapingIntent): ShapingConfigView {
  const overrides = { ...view.overrides };
  switch (intent.kind) {
    case "upsert": {
      const parsed = ShaperSchema.safeParse(intent.shaper);
      if (!parsed.success) return view;
      const at = view.shapers.findIndex((entry) => entry.id === parsed.data.id);
      const shapers = [...view.shapers];
      if (at === -1) shapers.push(parsed.data);
      else shapers[at] = parsed.data;
      overrides[parsed.data.id] = false;
      return { ...view, shapers, overrides };
    }
    case "remove":
      delete overrides[intent.id];
      return {
        ...view,
        shapers: view.shapers.filter((entry) => entry.id !== intent.id),
        overrides,
        order: view.order.filter((id) => id !== intent.id),
      };
    case "enable":
      overrides[intent.id] = intent.enabled;
      return { ...view, overrides };
    case "reorder":
      return { ...view, order: [...new Set(intent.order)] };
    case "move": {
      const group = shapingList(view).find((candidate) => candidate.stage !== null && candidate.rows.some((row) => row.id === intent.id));
      if (!group) return view;
      // No pruning here: only the daemon knows which stored ids still name a shaper. A move it
      // has to make room for draws nothing until its frame arrives.
      const placed = moveInShapingOrder({ rows: group.rows.map((row) => row.id), order: view.order, id: intent.id, after: intent.after });
      return placed.ok ? { ...view, order: placed.order } : view;
    }
    case "settings":
      return {
        ...view,
        caller: { ...view.caller, ...intent.caller },
        limits: { ...view.limits, ...intent.limits },
      };
  }
}

export function sameShapingView(a: ShapingConfigView, b: ShapingConfigView): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Whether `view` shows the outcome `intent` asked for: what confirms a write. Each intent is
 * checked against its own result, never against the preview, because the daemon may apply an
 * intent with effects the preview cannot know - a removal that keeps a folder shaper's id off,
 * or a move it makes room for - and a preview that drew nothing must not count as confirmation.
 */
export function shapingIntentReflected(view: ShapingConfigView, intent: ShapingIntent): boolean {
  switch (intent.kind) {
    case "remove":
      // The registration is gone. What the daemon kept for a folder shaper of that id is its own.
      return !view.shapers.some((entry) => entry.id === intent.id);
    case "enable":
      return view.overrides[intent.id] === intent.enabled;
    case "move": {
      // The shaper sits right after the named neighbour, or first, among its stage's rows.
      const group = shapingList(view).find((candidate) => candidate.stage !== null && candidate.rows.some((row) => row.id === intent.id));
      if (!group) return false;
      const rows = group.rows.map((row) => row.id);
      const at = rows.indexOf(intent.id);
      return intent.after === null ? at === 0 : at > 0 && rows[at - 1] === intent.after;
    }
    case "upsert":
    case "reorder":
    case "settings":
      return sameShapingView(previewShapingIntent(view, intent), view);
  }
}

// ---------------------------------------------------------------------------------------------
// What a shaper runs or calls

/** One labelled fact about where a shaper reaches. */
export interface ShaperReachLine {
  label: string;
  value: string;
}

/** Quote an argument only when it needs it, so the common case reads as typed. */
function shellWord(word: string): string {
  return word === "" || /[\s"'\\$`]/.test(word) ? JSON.stringify(word) : word;
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellWord).join(" ");
}

function headerLines(headers: Readonly<Record<string, string>>): ShaperReachLine[] {
  return Object.entries(headers).map(([name, value]) => ({ label: `Header ${name}`, value }));
}

/**
 * Exactly what a shaper runs or calls: the command line, the URL and headers, or the built-in
 * and the files it reads. Header values are config, and the schema holds every credential as a
 * `{env:NAME}` reference, so nothing here is a secret.
 */
export function shaperReach(shaper: Shaper): ShaperReachLine[] {
  const transport = shaper.transport;
  switch (transport.type) {
    case "command":
      return [{ label: "Runs", value: commandLine(transport.command, transport.args) }];
    case "mcp": {
      const server = transport.server;
      const where = server.type === "stdio"
        ? [{ label: "Runs MCP server", value: commandLine(server.command, server.args) }]
        : [{ label: "Calls MCP server", value: server.url }, ...headerLines(server.headers)];
      return [
        ...where,
        { label: "Tool", value: transport.tool },
        { label: "Context", value: transport.contextDelivery === "argument" ? "As a fourth argument, context" : "Folded into the task argument" },
      ];
    }
    case "http":
      return [{ label: "Calls", value: `POST ${transport.url}` }, ...headerLines(transport.headers)];
    case "builtin": {
      const { include, summary, facts } = transport.options;
      const reads = [...include.map((entry) => entry.path), ...(summary ? [summary] : []), ...(facts ? [facts] : [])];
      return [
        { label: "Built in", value: transport.builtin },
        { label: "Reads", value: reads.length > 0 ? reads.join(", ") : "No files" },
      ];
    }
  }
}

/** The one-line form a row shows under its label. */
export function shaperReachSummary(shaper: Shaper): string {
  const [first] = shaperReach(shaper);
  return first ? `${first.label}: ${first.value}` : "";
}

/**
 * Every environment variable a shaper names, in order and once each: the ones it asks to be
 * passed through, and every `{env:NAME}` its headers reference. Names only, never values.
 */
export function shaperEnvironmentNames(shaper: Shaper): string[] {
  const names: string[] = [];
  const transport = shaper.transport;
  const headerReferences = (headers: Readonly<Record<string, string>>): string[] =>
    Object.values(headers).flatMap((value) => (shapingReferences(value) ?? [])
      .filter((reference) => reference.startsWith("env:"))
      .map((reference) => reference.slice(4)));
  switch (transport.type) {
    case "command":
      names.push(...transport.env);
      break;
    case "mcp":
      names.push(...(transport.server.type === "stdio" ? transport.server.env : headerReferences(transport.server.headers)));
      break;
    case "http":
      names.push(...headerReferences(transport.headers));
      break;
    case "builtin":
      break;
  }
  return [...new Set(names)];
}

/** Each named variable with whether the daemon has it set, where the reply says so. Never a value. */
export function shaperEnvironmentStatus(
  shaper: Shaper,
  references: ShapingReferenceStatus,
): Array<{ name: string; status: "set" | "unset" | null }> {
  return shaperEnvironmentNames(shaper).map((name) => ({
    name,
    status: Object.hasOwn(references, name) ? references[name]! : null,
  }));
}

/**
 * What the shaper is given, stated beside it. A remote shaper is never sent a local path, a
 * file's contents or a token other than its own header references; `plan.md` fixes the list.
 */
export function shaperReceives(shaper: Shaper): { remote: boolean; sent: string[]; never: string | null } {
  if (shaper.transport.type === "builtin") {
    return {
      remote: false,
      sent: ["Runs inside Mission Control and reads only the files its options name, in each repository's worktree."],
      never: null,
    };
  }
  if (shaperIsLocal(shaper)) {
    return {
      remote: false,
      sent: [
        "Runs on this machine as you, with a scrubbed environment plus the variables it names.",
        "Receives the task's prompt, its context, and each repository's name and local path.",
      ],
      never: null,
    };
  }
  return {
    remote: true,
    sent: [
      "The task's prompt",
      "The task's context: title, kind, labels, priority, harness, runtime and after-work workflow",
      "Repository names, with the facts and summary a gatherer produced",
      "The launch's trace context, when it has one",
      "The headers above, each {env:NAME} resolved when it is called",
    ],
    // Scoped to the fields the transport leaves out. The prompt, the title and a gatherer's facts
    // and summary are free text, so they carry whatever was typed or read into them.
    never: "Mission Control leaves out the repositories' local paths and every credential except the header references above. "
      + "The text it does send is passed on as written: a prompt, title, fact or summary that contains a path, "
      + "file contents or a secret sends that too.",
  };
}

// ---------------------------------------------------------------------------------------------
// Importing a manifest

export type ManifestReading =
  | { ok: true; shaper: Shaper; ignoredEnabled: boolean }
  | { ok: false; reason: string };

function issueText(issue: { path: PropertyKey[]; message: string; code: string } | undefined): string {
  if (!issue) return "The manifest is not a valid shaper.";
  const at = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
  const message = issue.code === "unrecognized_keys" ? "This build does not recognise a field the manifest names." : issue.message;
  return `${at}${message}`;
}

/**
 * Read a pasted or chosen manifest the way the daemon will: `ShaperManifestSchema` first, so a
 * folder manifest pastes as it is, then the registered definition, which refuses what only a
 * folder can hold, such as a `./` command. A refusal names the field and why, credential rule
 * included, and nothing is sent. The manifest's own `enabled` does not apply to a registered
 * shaper: a save always stores it switched off.
 */
export function readShaperManifest(text: string): ManifestReading {
  if (text.trim() === "") return { ok: false, reason: "Paste a shaper manifest, or choose its file." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `This is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const manifest = ShaperManifestSchema.safeParse(json);
  if (!manifest.success) return { ok: false, reason: issueText(manifest.error.issues[0]) };
  const { enabled, ...definition } = manifest.data;
  const shaper = ShaperSchema.safeParse(definition);
  if (!shaper.success) return { ok: false, reason: issueText(shaper.error.issues[0]) };
  return { ok: true, shaper: shaper.data, ignoredEnabled: enabled !== undefined };
}

// ---------------------------------------------------------------------------------------------
// Reading a dry run's reply

/** One injected entry, as `POST /api/shaping/test` answers it (`ShapingInjectedEntry`). */
const ShapingInjectedEntryReplySchema = z.object({
  shaperId: z.string(),
  label: z.string(),
  stage: z.string(),
  repo: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  path: z.string().nullable(),
  body: z.string(),
  truncated: z.boolean(),
  omittedBytes: z.number().int().nonnegative(),
});

/** The dry run's whole reply, `ShapingRun`: every field present, none supplied by the reader. */
const ShapingRunReplySchema = z.object({
  summary: TaskShapingSchema.nullable(),
  section: z.string(),
  entries: z.array(ShapingInjectedEntryReplySchema),
});

/**
 * A dry run's success reply, or null when it is not a complete run. Nothing is filled in: a
 * reply missing its summary, section or entries is a broken contract, and drawing it as a run
 * that adds nothing would hide that.
 */
export function readShapingRun(data: unknown): ShapingRun | null {
  const parsed = ShapingRunReplySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
