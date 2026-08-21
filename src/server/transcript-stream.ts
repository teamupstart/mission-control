import { statSync } from "node:fs";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { TranscriptStreamMsg } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { Registry } from "./registry.ts";
import { sessionMessages, transcriptFor } from "./harness/index.ts";
import { attributeTranscript } from "./transcript-attribution.ts";
import { sleep } from "./util/timers.ts";

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

/**
 * SSE handler for `GET /api/sessions/:id/transcript/stream`.
 *
 * Turns are credited to whoever typed them via `attributeTranscript`, which lives beside
 * this rather than inside a harness's line parser: that is a pure parse of a file, this is
 * a fact only the running daemon holds (see injections.ts). It reaches the dashboard's
 * live stream and its backward pages; the one-shot reviewer window stays unattributed,
 * because that reader is asking what the AGENT did.
 */
export function transcriptStreamHandler(registry: Registry) {
  return (c: Context) =>
    streamSSE(c, async (stream) => {
      const send = (m: TranscriptStreamMsg) => stream.writeSSE({ data: JSON.stringify(m) });

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

      try {
        const from = resumeFrom();
        if (from !== null) {
          const resumed = read.appended(path, from);
          pos = resumed.pos;
          await send({
            type: "resume",
            messages: attributeTranscript(id, resumed.messages),
            pos,
          });
        } else {
          const init = read.initial(path);
          pos = init.pos;
          await send({
            type: "init",
            messages: attributeTranscript(id, init.messages),
            start: init.start,
            atStart: init.atStart,
            pos,
          });
        }
      } catch {
        await send({ type: "unavailable", reason: "Could not read the transcript file." });
        return;
      }

      let sinceHeartbeat = 0;
      while (!stream.aborted) {
        await sleep(POLL_MS);
        if (stream.aborted) break;
        try {
          const size = statSync(path).size;
          if (size < pos) pos = 0; // truncated / rotated - re-read from the top
          const { messages, pos: next } = read.appended(path, pos);
          pos = next;
          if (messages.length > 0) {
            await send({ type: "append", messages: attributeTranscript(id, messages), pos });
            sinceHeartbeat = 0;
            continue;
          }
        } catch {
          // file briefly unavailable (rotation) - try again next tick
        }
        sinceHeartbeat += POLL_MS;
        if (sinceHeartbeat >= HEARTBEAT_MS) {
          await stream.writeSSE({ data: "", event: "ping" });
          sinceHeartbeat = 0;
        }
      }
    });
}
