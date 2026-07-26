import { statSync } from "node:fs";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { TranscriptMessage, TranscriptStreamMsg } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { Registry } from "./registry.ts";
import { sessionMessages, transcriptFor } from "./harness/index.ts";
import { originOf } from "./injections.ts";
import { sleep } from "./util/timers.ts";

// The live transcript feed behind the expanded card: send the recent history, then poll
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
 * Credit the turns Foreman and the dashboard typed to them, so the log doesn't read as
 * the human having asked for work they never asked for.
 *
 * Deliberately not inside the harness's line parser: that's a pure parse of a file, this
 * is a fact only the running daemon holds (see injections.ts). Only the SSE stream is
 * annotated - the one-shot window feeds Foreman's own reviewer, which is reading for what
 * the AGENT did.
 */
function attribute(sessionId: string | undefined, messages: TranscriptMessage[]): TranscriptMessage[] {
  if (!sessionId) return messages;
  return messages.map((m) => {
    if (m.role !== "user" || !m.text) return m;
    const origin = originOf(sessionId, m.text);
    return origin ? { ...m, origin } : m;
  });
}

/** SSE handler for `GET /api/sessions/:id/transcript/stream`. */
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
      try {
        const init = read.initial(path);
        pos = init.pos;
        await send({
          type: "init",
          messages: attribute(id, init.messages),
          start: init.start,
          atStart: init.atStart,
        });
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
            await send({ type: "append", messages: attribute(id, messages) });
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
