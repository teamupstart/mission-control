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
  ShaperManifestSchema,
  ShaperSchema,
  shaperIsLocal,
  shaperSwitchedOn,
  shapingReferences,
  shapingViewHasRevisions,
  shapingViewRevision,
  TaskShapingSchema,
  type Shaper,
  type ShapingConfigView,
  type ShapingIntent,
  type ShapingReferenceStatus,
  type ShapingRun,
  type ShapingStage,
  type UnsupportedShaperView,
} from "@shared/shaping.ts";

/**
 * What became of one write: the daemon stored it, refused it (or the panel refused to send it),
 * its answer never arrived so the daemon may or may not have stored it, or it was not sent because
 * another write was in flight or the panel had no connection. A control keeps what the operator
 * entered unless the write was saved or refused, so an unconfirmed one can be compared and retried.
 */
export type ShapingWriteOutcome = "saved" | "refused" | "unconfirmed" | "not_sent";

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
  /**
   * The daemon's revision of the stored definition, sent as `expect` with any intent that acts on
   * what this row shows. Null only while an optimistic import awaits the frame that brings it.
   */
  revision: string | null;
  /**
   * A later stored entry with an id an earlier one already owns. It never runs and has no
   * revision of its own, so it is drawn for information only: every intent naming its id acts
   * on the owning row, and removing that row removes this entry too.
   */
  duplicate: boolean;
  /** How many later stored entries repeat this row's id: removing this row removes them too. */
  repeats: number;
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
  const owners = new Map<string, ShapingListRow>();
  view.shapers.forEach((entry, position) => {
    const owner = owners.get(entry.id);
    if (owner) {
      // The daemon classifies a repeat as unsupported; it is drawn without controls of its own.
      owner.repeats += 1;
      unsupported.push({
        id: entry.id, label: entry.label, shaper: null, on: false,
        problem: isUnsupportedShaper(entry) ? entry.unsupported : null, revision: null, duplicate: true, repeats: 0,
      });
      return;
    }
    const revision = shapingViewRevision(view, entry.id);
    if (isUnsupportedShaper(entry)) {
      const row: ShapingListRow = {
        id: entry.id, label: entry.label, shaper: null,
        on: view.overrides[entry.id] === true, problem: entry.unsupported, revision, duplicate: false, repeats: 0,
      };
      owners.set(entry.id, row);
      unsupported.push(row);
      return;
    }
    const row = {
      id: entry.id, label: entry.label, shaper: entry, stage: entry.stage, position,
      on: shaperSwitchedOn(view, entry.id, "registered"), problem: null, revision, duplicate: false, repeats: 0,
    };
    owners.set(entry.id, row);
    known.push(row);
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
export function moveIntent(view: ShapingConfigView, id: string, offset: -1 | 1): Extract<ShapingIntent, { kind: "place" }> | null {
  const group = shapingList(view).find((candidate) => candidate.stage !== null && candidate.rows.some((row) => row.id === id));
  if (!group) return null;
  const rows = group.rows.map((row) => row.id);
  const at = rows.indexOf(id);
  const to = at + offset;
  if (to < 0 || to >= rows.length) return null;
  const others = rows.filter((row) => row !== id);
  // Bound to the definition shown, like a switch: a replacement written meanwhile is not moved.
  // A row with no revision, as from a daemon older than this dashboard, offers no move at all.
  const expect = shapingViewRevision(view, id);
  if (expect === null) return null;
  return { kind: "place", id, after: to === 0 ? null : others[to - 1]!, expect };
}

/**
 * The view as it will look once the daemon applies `intent`, so a click shows at once. It is a
 * drawing, never the rule: the daemon's own `applyShapingIntent` decides, and the next frame
 * replaces this either way. An upsert that this build would refuse draws nothing.
 */
export function previewShapingIntent(view: ShapingConfigView, intent: ShapingIntent): ShapingConfigView {
  // An intent bound to a revision applies only to that definition. Once another window has
  // replaced it, drawing the click by id would show the replacement switched or removed, which the
  // daemon will refuse: the view is drawn as stored while the request's answer is awaited.
  if (shapingIntentSuperseded(view, intent)) return view;
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
      // The stored definition's revision is the daemon's to derive; it arrives with the frame.
      return { ...view, shapers, overrides, ...withoutRevision(view, parsed.data.id) };
    }
    case "remove": {
      delete overrides[intent.id];
      return {
        ...view,
        ...withoutRevision(view, intent.id),
        shapers: view.shapers.filter((entry) => entry.id !== intent.id),
        overrides,
        order: view.order.filter((id) => id !== intent.id),
      };
    }
    case "enable":
      overrides[intent.id] = intent.enabled;
      return { ...view, overrides };
    case "reorder":
      return { ...view, order: [...new Set(intent.order)] };
    case "move":
    case "place": {
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

/** The view's revisions without `id`'s, or nothing at all for a view that carries none. */
function withoutRevision(view: ShapingConfigView, id: string): Partial<Pick<ShapingConfigView, "revisions">> {
  if (!shapingViewHasRevisions(view)) return {};
  const { [id]: _dropped, ...revisions } = view.revisions;
  return { revisions: revisions as Record<string, string> };
}

/**
 * Whether `view` shows that `intent` can no longer apply: it is bound to a revision, and the
 * definition it was sent for has since been replaced or removed. The daemon will refuse it, and
 * nothing it does can reach what is stored now, so the panel need not wait on it to take the next
 * edit; its answer is still awaited, and shown when it comes.
 */
export function shapingIntentSuperseded(view: ShapingConfigView, intent: ShapingIntent): boolean {
  return (intent.kind === "enable" || intent.kind === "remove" || intent.kind === "place") && intent.expect !== undefined
    && shapingViewRevision(view, intent.id) !== intent.expect;
}

/** The lock every move within `stage` holds while it awaits its answer. */
export function shapingStageLockKey(stage: string): string {
  return `stage:${stage}`;
}

/** A daemon commit: the process that made it, and its number in that process. */
export interface ShapingCommit {
  instance: string;
  commit: number;
}

/** The commit a view shows, or null for a view that names none, from a daemon older than commits. */
export function shapingViewCommit(view: { readonly instance?: unknown; readonly commit?: unknown }): ShapingCommit | null {
  const { instance, commit } = view;
  return typeof instance === "string" && typeof commit === "number" && Number.isSafeInteger(commit) ? { instance, commit } : null;
}

/**
 * Whether `view` shows `awaited` or a later commit. A view from another daemon process is past it
 * too: that process sent its own snapshot, which is what is stored now, whatever came before.
 */
export function shapingViewReached(view: ShapingConfigView, awaited: ShapingCommit): boolean {
  const shown = shapingViewCommit(view);
  return shown === null || shown.instance !== awaited.instance || shown.commit >= awaited.commit;
}

/**
 * The commit a row waits for, given the one it already waits for and the one a newly arrived answer
 * made. Answers can arrive in any order, so a late answer for an earlier commit never lowers what
 * the row waits for: within one daemon process the later commit stands. An answer from another
 * process was compared against a view from that process (`shapingRowsAhead`), so it is the one
 * the stream will deliver, and stands.
 */
export function shapingLaterCommit(held: ShapingCommit | undefined, made: ShapingCommit): ShapingCommit {
  return held !== undefined && held.instance === made.instance && held.commit >= made.commit ? held : made;
}

/**
 * What a frame is measured against before it counts as an import's receipt: whether the view
 * already showed the import stored when it was sent, the shaper's revision then, and the daemon
 * process that issued that revision.
 */
export interface ShapingReceiptBaseline {
  shown: boolean;
  revision: string | null;
  instance: string | null;
}

/** The baseline for `request`, an import, as `view` stood when it was sent. */
export function shapingReceiptBaseline(view: ShapingConfigView | null, request: ShapingIntent): ShapingReceiptBaseline {
  const id = request.kind === "upsert" ? (request.shaper as { id: string }).id : null;
  return {
    shown: view !== null && shapingIntentReflected(view, request),
    revision: view !== null && id !== null ? shapingViewRevision(view, id) : null,
    instance: view !== null ? shapingViewCommit(view)?.instance ?? null : null,
  };
}

/**
 * Whether `config`, a frame that shows the import stored, is evidence of the import itself. When
 * the view already showed it stored as it was sent, as an identical reimport is, any frame would
 * show it: only one where the shaper's revision has moved on from the one it had then counts, and
 * only when the same daemon process issued both, since a restarted daemon issues every revision
 * anew. With no revision or process to compare, as from a daemon that sends none, no frame counts,
 * and only the daemon's answer can settle the outcome.
 */
export function shapingFrameIsReceipt(baseline: ShapingReceiptBaseline, config: ShapingConfigView, id: string): boolean {
  if (!baseline.shown) return true;
  const now = shapingViewRevision(config, id);
  const instance = shapingViewCommit(config)?.instance ?? null;
  return baseline.revision !== null && now !== null && now !== baseline.revision
    && baseline.instance !== null && instance === baseline.instance;
}

/**
 * The shapers an accepted write's `answer` shows at a revision `view` does not, when `view` shows
 * an earlier commit than the answer. A write's answer can arrive before the frame that carries it,
 * and a frame from another writer can land in between, moving a row's revision on without reaching
 * this write's: either way, until the stream reaches the answer's commit, an action on such a row
 * would name a revision the daemon has moved past, and be refused.
 */
export function shapingRowsAhead(view: ShapingConfigView, answer: ShapingConfigView): string[] {
  const made = shapingViewCommit(answer);
  if (made === null || shapingViewReached(view, made) || !shapingViewHasRevisions(answer)) return [];
  return Object.keys(answer.revisions).filter((id) => shapingViewRevision(answer, id) !== shapingViewRevision(view, id));
}

/**
 * Every control a write can affect, all locked while it awaits its answer and all required free
 * before it is sent. An import stores its shaper switched off, so it also holds that shaper's row:
 * a switch on sent while it waits could otherwise be undone by the import landing after it, and an
 * import is not sent while a write on that row awaits its own answer. A move places its shaper
 * among the rest of its stage, so it holds that stage: a move of another row there, sent while it
 * waits, could otherwise be undone by it landing after. A whole reorder holds every stage.
 */
export function shapingLockKeys(intent: ShapingIntent, key: string, view: ShapingConfigView | null = null): string[] {
  const keys = new Set([key]);
  if (intent.kind === "upsert") keys.add(`row:${(intent.shaper as { id?: unknown }).id}`);
  if (intent.kind === "move" || intent.kind === "place") {
    const entry = view?.shapers.find((candidate) => candidate.id === intent.id && !isUnsupportedShaper(candidate));
    if (entry && !isUnsupportedShaper(entry)) keys.add(shapingStageLockKey(entry.stage));
  }
  if (intent.kind === "reorder") for (const stage of SHAPING_STAGES) keys.add(shapingStageLockKey(stage));
  return [...keys];
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
      // The choice alone is not this request's outcome: a peer may have replaced the shaper and
      // switched the replacement the same way. Bound to a revision, it counts only for the
      // definition it was sent for; an enable never changes a revision, so a stored one keeps it.
      return view.overrides[intent.id] === intent.enabled
        && (intent.expect === undefined || shapingViewRevision(view, intent.id) === intent.expect);
    case "move":
    case "place": {
      // The shaper sits right after the named neighbour, or first, among its stage's rows, and for
      // a placement it is still the definition sent for: a replacement placed there is not its outcome.
      if (intent.kind === "place" && shapingViewRevision(view, intent.id) !== intent.expect) return false;
      const group = shapingList(view).find((candidate) => candidate.stage !== null && candidate.rows.some((row) => row.id === intent.id));
      if (!group) return false;
      const rows = group.rows.map((row) => row.id);
      const at = rows.indexOf(intent.id);
      return intent.after === null ? at === 0 : at > 0 && rows[at - 1] === intent.after;
    }
    case "upsert": {
      // The definition is stored as sent, and switched off. Its revision is the daemon's.
      const parsed = ShaperSchema.safeParse(intent.shaper);
      if (!parsed.success) return false;
      const stored = view.shapers.find((entry) => entry.id === parsed.data.id);
      return stored !== undefined && canonicalJson(stored) === canonicalJson(parsed.data) && view.overrides[parsed.data.id] === false;
    }
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

/** What an intent did, in words, so a refusal that lands after a newer write names its own action. */
export function describeShapingIntent(intent: ShapingIntent): string {
  switch (intent.kind) {
    case "upsert": return `importing ${intent.shaper.id}`;
    case "remove": return `removing ${intent.id}`;
    case "enable": return `switching ${intent.id} ${intent.enabled ? "on" : "off"}`;
    case "move":
    case "place": return `moving ${intent.id}`;
    case "reorder": return "reordering the shapers";
    case "settings": return "saving the caller identity and budgets";
  }
}

/**
 * The text a refusal shows. A refusal for a write that a newer one has since followed says it
 * belongs to the earlier action, so it never reads as the outcome of the change just made.
 */
export function shapingRefusalText(intent: ShapingIntent, reason: string, superseded: boolean): string {
  return superseded ? `An earlier change, ${describeShapingIntent(intent)}, was refused: ${reason}` : reason;
}

/**
 * The text for a write whose answer never arrived. Not a refusal: the daemon may have stored it.
 * `shown` is whether an event stream update showed the change stored at the time. It says what
 * that update showed, in the past tense: a later write may have changed it, and the list shows
 * what is stored now.
 */
export function shapingUnconfirmedText(intent: ShapingIntent, shown: boolean, superseded: boolean, cause: string): string {
  const outcome = shown
    ? `${cause} An update from the daemon showed this change stored, but no answer confirmed it. The list shows what is stored now.`
    : `${cause} Whether this change was stored is unknown: this shows the daemon's current settings, so make the change again if it is missing.`;
  return superseded ? `An earlier change, ${describeShapingIntent(intent)}, is unconfirmed: ${outcome}` : outcome;
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
