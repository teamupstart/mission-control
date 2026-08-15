import {
  ARCHIVE_PROMPT_LIMITS,
  type ArchiveManifestPromptEntry,
  type ArchiveManifestPromptTrail,
} from "@shared/archives.ts";
import type { Session, Task, TurnOrigin } from "@shared/types.ts";
import { harnessFor, sessionMessages, type SessionMessages } from "../harness/index.ts";
import type { TranscriptMessages } from "../harness/types.ts";
import { originOf } from "../injections.ts";
import { clipUtf8Bytes, utf8Bytes } from "../util/utf8.ts";
import {
  scoutPromptContext,
  scoutPromptFingerprint,
  scoutPromptTurns,
  type ScoutPromptContext,
  type ScoutPromptTurn,
} from "./prompt-context.ts";
import { SCOUT_APPENDIX_MARKER } from "./prompt.ts";

/** The store and harness seams are injectable so collector tests need no Registry. */
export interface ScoutPromptCollectorDependencies {
  context(taskId: string, episodeId: string): ScoutPromptContext | null;
  turns(taskId: string, episodeId: string): ScoutPromptTurn[];
  sessionMessages(session: Session): SessionMessages | null;
  transcriptMessages(task: Pick<Task, "agent">): TranscriptMessages | null;
  liveOrigin(sessionId: string, text: string): TurnOrigin | undefined;
}

const DEFAULT_DEPS: ScoutPromptCollectorDependencies = {
  context: scoutPromptContext,
  turns: scoutPromptTurns,
  sessionMessages,
  transcriptMessages: (task) => harnessFor(task.agent).transcript?.messages ?? null,
  liveOrigin: originOf,
};

export interface CollectedScoutPromptTrail {
  trail: ArchiveManifestPromptTrail;
  /** The last card title Phase 1 froze, for exit recovery. */
  frozenSessionName: string | null;
}

interface FollowUpCandidate {
  entry: ArchiveManifestPromptEntry;
  journalId: string | null;
  orderAt: number | null;
  ordinal: number;
}

/**
 * Collect one scout episode without depending on a final head-and-tail transcript window.
 *
 * The journal is authoritative for authorship and positive delivery. The transcript supplies
 * direct human turns and conversation order; missing journaled human turns are merged back in
 * after the bounded forward walk. Any point where completeness or attribution cannot be
 * established sets `truncated` and takes the privacy-safe path of retaining only known-human
 * journal rows.
 */
export function collectScoutPromptTrail(
  task: Pick<Task, "id" | "agent" | "intent">,
  episodeId: string | null,
  session: Session | null,
  dependencies: ScoutPromptCollectorDependencies = DEFAULT_DEPS,
): CollectedScoutPromptTrail {
  const context = episodeId ? dependencies.context(task.id, episodeId) : null;
  const turns = context ? dependencies.turns(task.id, context.episodeId) : [];
  let truncated = context?.truncated ?? context === null;
  const candidates: FollowUpCandidate[] = [];
  let candidateBytes = 0;
  let ordinal = 0;

  // The transcript can be much larger than the portable trail. Keep a bounded rolling set
  // while walking it; final selection still runs after journal recovery and keeps the newest.
  const retain = (candidate: Omit<FollowUpCandidate, "ordinal">): void => {
    const original = candidate.entry.text;
    const text = clipUtf8Bytes(original, ARCHIVE_PROMPT_LIMITS.entryBytes);
    if (utf8Bytes(original) > ARCHIVE_PROMPT_LIMITS.entryBytes) truncated = true;
    const kept: FollowUpCandidate = {
      ...candidate,
      entry: { ...candidate.entry, text },
      ordinal: ordinal++,
    };
    candidates.push(kept);
    candidateBytes += utf8Bytes(text);
    const entryCeiling = ARCHIVE_PROMPT_LIMITS.entries * 2;
    const byteCeiling = ARCHIVE_PROMPT_LIMITS.totalBytes * 2;
    while (candidates.length > entryCeiling || candidateBytes > byteCeiling) {
      const dropped = candidates.shift();
      if (!dropped) break;
      candidateBytes -= utf8Bytes(dropped.entry.text);
      truncated = true;
    }
  };

  const journalByFingerprint = new Map<string, ScoutPromptTurn[]>();
  for (const turn of turns) {
    const queue = journalByFingerprint.get(turn.fingerprint) ?? [];
    queue.push(turn);
    journalByFingerprint.set(turn.fingerprint, queue);
  }
  const usedJournalIds = new Set<string>();

  const located = session ? dependencies.sessionMessages(session) : null;
  const reader = located?.read ?? dependencies.transcriptMessages(task);
  let transcriptPath = context?.transcriptPath ?? null;
  if (!transcriptPath && context?.transcriptOffset === 0) transcriptPath = located?.path ?? null;
  // A different live path cannot safely inherit a non-zero byte anchor from the old file.
  if (context?.transcriptPath && located && located.path !== context.transcriptPath) truncated = true;

  const offset = context?.transcriptOffset ?? null;
  let size: number | null = null;
  if (reader && transcriptPath) {
    try {
      size = reader.size(transcriptPath);
    } catch {
      // A rotated or concurrently removed transcript is missing evidence, not a reason to
      // prevent the already-frozen capture job from being reserved.
      truncated = true;
    }
  }
  const readable = Boolean(
    context &&
      reader &&
      transcriptPath &&
      offset !== null &&
      size !== null &&
      offset <= size &&
      (!context.transcriptPath || !located || located.path === context.transcriptPath),
  );

  if (!readable) {
    truncated = true;
  } else {
    let cursor = offset!;
    let openingRemoved = false;
    while (cursor < size!) {
      let page: ReturnType<TranscriptMessages["after"]>;
      try {
        page = reader!.after(transcriptPath!, cursor);
      } catch {
        // The file can disappear between `size` and this bounded read. Durable human rows
        // are merged below, so fail closed on completeness and keep recovery moving.
        truncated = true;
        break;
      }
      if (page.end <= cursor) {
        truncated = true;
        break;
      }
      for (const message of page.messages) {
        if (message.role !== "user" || message.text === "") continue;
        if (!openingRemoved && message.text.includes(SCOUT_APPENDIX_MARKER)) {
          openingRemoved = true;
          continue;
        }

        const queue = journalByFingerprint.get(scoutPromptFingerprint(message.text));
        const journal = queue?.shift();
        if (journal) {
          usedJournalIds.add(journal.id);
          // Unknown persisted origins are excluded, never guessed to be human.
          if (journal.origin !== "human" || journal.text === null) {
            if (journal.origin === "human" && journal.text === null) truncated = true;
            continue;
          }
          retain({
            entry: {
              kind: "follow_up",
              text: journal.text,
              at: instant(journal.deliveredAt),
            },
            journalId: journal.id,
            orderAt: journal.deliveredAt,
          });
          continue;
        }

        // When the durable journal hit a bound, an unattributed transcript turn might be an
        // evicted automated instruction. Keep known human rows only rather than inventing a
        // human author for it.
        if (context!.truncated) continue;
        const attributed =
          message.origin ??
          dependencies.liveOrigin(context!.sessionId ?? session?.id ?? "", message.text);
        if (attributed) continue;
        retain({
          entry: {
            kind: "follow_up",
            text: message.text,
            at: instant(message.ts),
          },
          journalId: null,
          orderAt: message.ts > 0 ? message.ts : null,
        });
      }
      cursor = page.end;
      if (page.atEnd && cursor < size!) {
        truncated = true;
        break;
      }
    }
  }

  // A positively delivered human row can beat the transcript to disk, or outlive a missing
  // or rotated file. Merge every one the walk did not match.
  for (const turn of turns) {
    if (turn.origin !== "human" || turn.text === null || usedJournalIds.has(turn.id)) continue;
    retain({
      entry: { kind: "follow_up", text: turn.text, at: instant(turn.deliveredAt) },
      journalId: turn.id,
      orderAt: turn.deliveredAt,
    });
  }

  candidates.sort((left, right) => {
    if (left.orderAt !== null && right.orderAt !== null && left.orderAt !== right.orderAt) {
      return left.orderAt - right.orderAt;
    }
    return left.ordinal - right.ordinal;
  });

  const journalIds = new Set<string>();
  const recoveryKeys = new Set<string>();
  const followUps: ArchiveManifestPromptEntry[] = [];
  for (const candidate of candidates) {
    const key = `${normalize(candidate.entry.text)}\u0000${candidate.entry.at ?? ""}`;
    if (candidate.journalId) {
      if (journalIds.has(candidate.journalId)) continue;
      journalIds.add(candidate.journalId);
      // Distinct journal identities are distinct accepted deliveries, even when their text
      // and millisecond happen to agree.
      recoveryKeys.add(key);
    } else {
      if (recoveryKeys.has(key)) continue;
      recoveryKeys.add(key);
    }
    followUps.push(candidate.entry);
  }

  return {
    trail: boundScoutPromptTrail(task.intent, followUps, truncated),
    frozenSessionName: context?.sessionName ?? null,
  };
}

/** Apply the portable byte and entry ceilings, retaining the initial and newest follow-ups. */
export function boundScoutPromptTrail(
  initialText: string,
  followUps: readonly ArchiveManifestPromptEntry[],
  alreadyTruncated = false,
): ArchiveManifestPromptTrail {
  let truncated = alreadyTruncated;
  const initial = clipUtf8Bytes(initialText, ARCHIVE_PROMPT_LIMITS.entryBytes);
  if (utf8Bytes(initialText) > ARCHIVE_PROMPT_LIMITS.entryBytes) truncated = true;

  const clipped = followUps.map((entry) => {
    const text = clipUtf8Bytes(entry.text, ARCHIVE_PROMPT_LIMITS.entryBytes);
    if (utf8Bytes(entry.text) > ARCHIVE_PROMPT_LIMITS.entryBytes) truncated = true;
    return { ...entry, kind: "follow_up" as const, text };
  });
  const entryLimit = ARCHIVE_PROMPT_LIMITS.entries - 1;
  const newest = clipped.slice(-entryLimit);
  if (newest.length !== clipped.length) truncated = true;

  const initialBytes = utf8Bytes(initial);
  let total = initialBytes;
  const kept: ArchiveManifestPromptEntry[] = [];
  for (let index = newest.length - 1; index >= 0; index -= 1) {
    const entry = newest[index]!;
    const bytes = utf8Bytes(entry.text);
    if (total + bytes > ARCHIVE_PROMPT_LIMITS.totalBytes) {
      truncated = true;
      break;
    }
    total += bytes;
    kept.unshift(entry);
  }

  return {
    entries: [{ kind: "initial", text: initial, at: null }, ...kept],
    truncated,
  };
}

function instant(value: number): string | null {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
