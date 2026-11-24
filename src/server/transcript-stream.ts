import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { TranscriptStreamMsg } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { noteKeyFor, type Registry } from "./registry.ts";
import { sessionMessages, transcriptFor } from "./harness/index.ts";
import { attributeTranscript } from "./transcript-attribution.ts";
import type { DelegatedConversation } from "./delegated-turns.ts";
import {
  bindLaunchTurnMessage,
  resolveLaunchMarker,
  type LaunchTurnMarker,
} from "./launch-presentation.ts";
import { sleep } from "./util/timers.ts";
import { endedOnShutdown } from "./http-shutdown.ts";
import { taskTitlePresenter } from "./task-titles.ts";
import { spokenTranscriptState } from "./db.ts";
import { spokenLedger } from "./delivery-ledgers.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import type { TranscriptStreamRead } from "./harness/types.ts";

// The live transcript feed behind the session detail: send the recent history, then poll
// the file and push turns as the agent appends them.
//
// Harness-agnostic - it holds the SSE loop and the attribution, and asks
// `sessionMessages` for the reading. A harness whose record carries no conversation
// reports `unavailable` here for the same reason the one-shot window does, and says which
// harness and why rather than naming either shipped one at every reader.

/** How often the server re-checks the file for new turns while a card is open. */
const POLL_MS = 900;
/** Idle comment ping so the SSE connection survives proxies. */
const HEARTBEAT_MS = 15000;
/**
 * Most a `?from=` resume will carry before the stream re-seeds instead.
 *
 * A reconnect is normally seconds of missed turns, so this is not a performance dial - it
 * is where "I missed a moment" stops being a fair description. Past it the reader is told
 * to start from a fresh window rather than handed one enormous catch-up frame.
 */
const RESUME_MAX_BYTES = 2 * 1024 * 1024;

/** Hash the displayed prefix and its extension in one bounded-memory, asynchronous pass.
 * Offsets are in ascending order. A different inode is a different transcript even if its bytes match. */
async function cursorProofs(path: string, offsets: number[]): Promise<string[]> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat({ bigint: true });
    const hash = createHash("sha256").update([stat.dev, stat.ino, stat.birthtimeNs].join(":") + "\n");
    const buffer = Buffer.allocUnsafe(Math.min(offsets.at(-1) ?? 0, 256 * 1024));
    const proofs: string[] = [];
    let pos = 0;
    for (const end of offsets) {
      while (pos < end) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - pos), pos);
        if (!bytesRead) throw new Error("Transcript changed during cursor verification");
        hash.update(buffer.subarray(0, bytesRead));
        pos += bytesRead;
      }
      proofs.push(hash.copy().digest("hex"));
    }
    return proofs;
  } finally {
    await file.close();
  }
}

/**
 * SSE handler for `GET /api/sessions/:id/transcript/stream`.
 *
 * Turns are credited to whoever typed them - and a Mission Control-managed launch turn is
 * marked for the dashboard's own projection - via `attributeTranscript`, which lives beside
 * this rather than inside a harness's line parser: that is a pure parse of a file, this is
 * a fact only the running daemon holds (see injections.ts). It reaches the dashboard's
 * live stream and its backward pages; the one-shot reviewer window stays unattributed,
 * because that reader is asking what the AGENT did.
 */
export function transcriptStreamHandler(registry: Registry) {
  return (c: Context) =>
    streamSSE(c, endedOnShutdown(async (stream) => {
      const send = (m: TranscriptStreamMsg) => stream.writeSSE({ data: JSON.stringify(m) });
      // The dashboard's view of the agent's turns: task ids shown as titles (`task-titles.ts`).
      const titled = taskTitlePresenter(registry);

      const id = c.req.param("id");
      const session = id ? registry.getSession(id) : undefined;
      const source = session ? sessionMessages(session) : null;
      if (!source) {
        // Three different absences, and the operator can act on only two of them, so the
        // reason distinguishes them: a harness that keeps no readable conversation is a
        // permanent answer, while a missing file is one that arrives with the next hook.
        const readable = session ? transcriptFor(session)?.messages : null;
        await send({
          type: "unavailable",
          reason: !session
            ? "No such session."
            : readable
              ? "No transcript for this session yet (needs an agent session id from hooks)."
              : `${AGENT_IDENTITY[session.agent].label} doesn't write a readable transcript.`,
        });
        return;
      }
      const { read, path } = source;
      // Re-read per FRAME, not cached for the connection. A terminal dispatch records its
      // marker immediately before the paste, and a person can expand the card in the seconds
      // between discovery and that paste; a connection-scoped null would then draw the launch
      // contract in full until something forced a reconnect. It is a Map lookup behind a
      // keyed session, which is what `Registry.launchTurns` exists to make cheap.
      const launch = (): LaunchTurnMarker | null => resolveLaunchMarker(registry, id);
      /** Anchor the marker to the turn a frame just identified, so later reads agree. */
      const anchor = (messageId: string): void => bindLaunchTurnMessage(registry, id, messageId);
      /** The target conversation, per frame for the reason `launch` is. */
      const conversation = (): DelegatedConversation | null => {
        const current = id ? registry.getSession(id) : undefined;
        return current ? { key: noteKeyFor(current), transcript: source } : null;
      };

      let pos = 0;
      // `?from=<byte>` is a reader saying "I still have everything up to here, just tell
      // me what is new". Honouring it is what keeps a dropped connection from costing the
      // reader their scrollback: an `init` is anchored at the CURRENT end of the file, so
      // on a session that is actively working the anchor has already moved and the pages
      // above it no longer join onto anything.
      //
      // Refused, deliberately, in the two cases where continuing would be a guess: an
      // offset past EOF means the file was cleared or rotated and the anchor names a byte
      // that no longer exists, and a gap wider than `RESUME_MAX_BYTES` is more than a
      // reconnect can honestly be said to have missed. Both fall through to `init`, which
      // is correct rather than cheap - the reader is told to start over instead of being
      // handed a continuation with a hole in it.
      const resumeFrom = (): number | null => {
        const raw = c.req.query("from");
        if (raw === undefined || raw === "") return null;
        const from = Number(raw);
        if (!Number.isSafeInteger(from) || from < 0) return null;
        try {
          const size = statSync(path).size;
          if (from > size || size - from > RESUME_MAX_BYTES) return null;
        } catch {
          return null;
        }
        return from;
      };

      const voice = featureEnabled("voice");
      const spokenState = () => {
        const current = voice && id ? registry.getSession(id) : undefined;
        return current ? spokenTranscriptState(noteKeyFor(current)) : null;
      };
      type SpokenState = ReturnType<typeof spokenState>;
      let spoken = spokenState();
      let cursor: string | undefined;
      let revision: string | undefined;
      // Anchor parsing and both hashes to the same EOF. If the writer is active, validate
      // only those bytes a second time. Bytes appended beyond the anchor belong to the next frame.
      const capture = async <T extends TranscriptStreamRead>(state: SpokenState, from: number | null,
        readFrame: (end?: number) => T) => {
        if (!state) return { frame: readFrame(), before: undefined, cursor: undefined, revision: undefined };
        const snapshot = read.snapshot?.(path);
        if (!snapshot || (from !== null && from > snapshot.size)) throw new Error("Transcript cursor is unavailable");
        const { size, version } = snapshot;
        const proofs = await cursorProofs(path, from === null ? [size] : [from, size]);
        const whole = proofs[proofs.length - 1];
        const frame = readFrame(size);
        let completeLines = whole;
        if (frame.pos !== size || read.snapshot?.(path)?.version !== version) {
          const [throughLines, throughEof] = await cursorProofs(path, [frame.pos, size]);
          if (throughEof !== whole) throw new Error("Transcript prefix changed during cursor verification");
          completeLines = throughLines;
        }
        return { frame, before: from === null ? undefined : proofs[0], cursor: completeLines, revision: version };
      };
      const sendWindow = async (state: SpokenState, refreshSpoken: boolean) => {
        const captured = await capture(state, null, end => read.initial(path, end));
        const init = captured.frame;
        const project = () => titled.transcript(attributeTranscript(id, init.messages, launch(), anchor, conversation()));
        const messages = project();
        // Any ledger consulted during projection can finish a binding. When the token advances,
        // project again against that token before promising it to the reader.
        const decorated = state ? spokenState() : state;
        const changed = decorated?.receipt !== state?.receipt;
        await send({
          type: "init",
          messages: changed ? project() : messages,
          start: init.start, atStart: init.atStart, pos: init.pos,
          ...(voice && { spokenReceipt: decorated?.receipt ?? null }), ...(captured.cursor && { spokenCursor: captured.cursor }),
          ...((refreshSpoken || changed) && { refreshSpoken: true }),
        });
        pos = init.pos;
        cursor = captured.cursor;
        revision = captured.revision;
        spoken = decorated;
      };
      try {
        const from = resumeFrom();
        const heldCursor = c.req.query("spokenCursor");
        const stale = voice && c.req.query("from") !== undefined && (
          (c.req.query("spokenReceipt") || null) !== (spoken?.receipt ?? null)
          || (heldCursor !== undefined && !spoken)
          || (spoken !== null && from === null)
        );
        if (from !== null && !stale) {
          const captured = await capture(spoken, from, end => read.appended(path, from, end));
          const resumed = captured.frame;
          if (spoken && captured.before !== heldCursor) {
            await sendWindow(spoken, true);
          } else {
            pos = resumed.pos;
            cursor = captured.cursor;
            revision = captured.revision;
            await send({ type: "resume", messages: titled.transcript(attributeTranscript(id, resumed.messages, launch(), anchor, conversation())),
              pos, ...(cursor && { spokenCursor: cursor }) });
          }
        } else {
          await sendWindow(spoken, stale);
        }
      } catch {
        await send({ type: "unavailable", reason: "Could not read the transcript file." });
        return;
      }

      let sinceHeartbeat = 0;
      while (!stream.aborted) {
        await sleep(POLL_MS);
        if (stream.aborted) break;
        sinceHeartbeat += POLL_MS;
        if (sinceHeartbeat >= HEARTBEAT_MS) {
          await stream.writeSSE({ data: "", event: "ping" });
          sinceHeartbeat = 0;
        }
        try {
          const target = spoken && conversation();
          if (target) spokenLedger.retryDeferredBindings(target);
          const current = spokenState();
          if (current?.receipt !== spoken?.receipt) {
            await sendWindow(current, true);
            sinceHeartbeat = 0;
            continue;
          }
          const size = statSync(path).size;
          const observed = current ? read.snapshot?.(path)?.version : undefined;
          if (current && observed && observed === revision) continue;
          if (current && size <= pos) {
            await sendWindow(current, true);
            continue;
          }
          if (size < pos) pos = 0; // truncated / rotated - re-read from the top
          const captured = await capture(current, pos, end => read.appended(path, pos, end));
          const { messages, pos: next } = captured.frame;
          if (current) {
            if (captured.before !== cursor) {
              await sendWindow(current, true);
              continue;
            }
            cursor = captured.cursor;
            revision = captured.revision;
          }
          const advanced = next > pos;
          pos = next;
          if (messages.length > 0 || (current && advanced)) {
            await send({ type: "append", messages: titled.transcript(attributeTranscript(id, messages, launch(), anchor, conversation())), pos,
              ...(cursor && { spokenCursor: cursor }) });
            sinceHeartbeat = 0;
            continue;
          }
        } catch {
          // file briefly unavailable (rotation) - try again next tick
        }
      }
    }));
}
