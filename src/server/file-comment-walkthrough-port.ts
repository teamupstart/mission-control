// The walkthrough, wired to the real daemon.
//
// Separate from `file-comment-walkthrough.ts` so that file keeps its claim: the state machine
// imports no store function, opens no database and touches no pane, which is what lets
// `test/file-comment-walkthrough.test.ts` drive every advance, hold, pause and restart path
// against a fake port instead of a fixture per case. This file is the only place the two meet.

import { randomUUID } from "node:crypto";
import {
  appendFileCommentMessage,
  beginFileCommentDelivery,
  loadFileCommentReview,
  loadFileCommentThread,
  loadFileCommentThreadsForSession,
  loadFileCommentThreadWithFullHistory,
  markFileCommentMessageDelivered,
  queueFileCommentThread,
  returnFileCommentDeliveryToQueue,
  setFileCommentReviewState,
  setFileCommentThreadStatus,
  updateFileCommentThreadAnchor,
} from "./db.ts";
import type { FileCommentThread } from "@shared/types.ts";
import { FileCommentWalkthrough, type FileCommentWalkthroughPort } from "./file-comment-walkthrough.ts";
import { sessionMessages } from "./harness/index.ts";
import { missionMcpToolName, verifyMissionMcpToolsForRunningSession } from "./mission-mcp.ts";
import type { PendingTurnManager } from "./pending-turns.ts";
import type { Registry } from "./registry.ts";
import { readSessionFile } from "./session-files.ts";

/**
 * How much of the conversation's tail the tool-less fallback reads.
 *
 * A comment's answer is the agent's next turn, so this only has to reach past whatever tool
 * calls that turn made. Twenty-four turns is the same order as the transcript surfaces
 * already read and keeps the cost of a timed-out comment to one bounded read.
 */
const FALLBACK_TAIL_TURNS = 24;

/**
 * The tool a session answers a comment through, as `MISSION_MCP_TOOLS` spells it.
 *
 * A constant HERE rather than in `mission-mcp.ts`, where the list entry is a bare literal on
 * purpose: `mission-mcp.test.ts` scrapes that array with a regex and `scripts/smoke-bundles.mjs`
 * resolves any CONSTANT in it through a hand-written name-to-module map. Naming it on this side
 * keeps both scrapes reading exactly what they read before.
 */
const FILE_COMMENT_REPLY_TOOL = "respond_to_file_comments" as const;

/**
 * Build the walkthrough and subscribe it to the three facts it runs on.
 *
 * Every durable write goes through phase 1's declared writers and every one of them is paired
 * with the live frame here, in the one place, so no caller can move a thread without a browser
 * hearing about it. That pairing is the same contract `FileCommentManager.publish` states.
 */
export function createFileCommentWalkthrough(
  registry: Registry,
  pendingTurns: PendingTurnManager,
): FileCommentWalkthrough {
  const publish = (thread: FileCommentThread | null): FileCommentThread | null => {
    if (!thread) return null;
    // The orphan backstop `FileCommentManager.publish` keeps, for its reason: a settled thread
    // must never be upserted back into the live collection, even by a writer added later.
    if (thread.status === "orphaned") registry.removeFileCommentThread(thread.id);
    else registry.upsertFileCommentThread(thread);
    return thread;
  };

  const port: FileCommentWalkthroughPort = {
    now: () => Date.now(),
    replyTool: async (sessionId) => {
      const session = registry.getSession(sessionId);
      if (!session) return null;
      // The question `TaskManager` already asks before it resets a scout's checkout, asked
      // here for the same reason and with the same limits. It interrogates the BUILT bundle -
      // `dist/mcp/server.mjs`, which only `npm run build` refreshes and which git ignores - and
      // orders that file against this session's start, so a bundle rebuilt after the agent
      // spawned reports as unusable rather than speaking for a child still running the previous
      // build. An operator's own session that never registered our server at all is the case
      // this cannot see; the transcript fallback is what covers it, and it is why a null here
      // and a session that simply ignores the tool produce the same recoverable outcome.
      //
      // Cached per build identity by `publishedTools`, and warmed at boot by
      // `reportMissionMcpDrift`, so an ordinary pass pays a `stat` and nothing more.
      let check;
      try {
        check = await verifyMissionMcpToolsForRunningSession(
          [FILE_COMMENT_REPLY_TOOL],
          session.startedAt,
        );
      } catch {
        // A probe that cannot answer must never be able to stop a review. `tick` turns an
        // escaping rejection into a pause with a reason, which would be the wrong outcome
        // entirely here: this decides one line of the payload, and the tool-less rendering is
        // a working review rather than a degraded one.
        return null;
      }
      // The fully-qualified name an MCP client namespaces our tool under, resolved through the
      // one module that owns the server name - so a rename cannot leave the payload naming a
      // tool no session registers, which is an instruction the loop cannot honour.
      return check.ok ? missionMcpToolName(FILE_COMMENT_REPLY_TOOL) : null;
    },
    session: (sessionId) => registry.getSession(sessionId) ?? null,
    review: (sessionId) => loadFileCommentReview(sessionId),
    setReviewState: (sessionId, state, pauseReason) => {
      const review = setFileCommentReviewState(sessionId, state, pauseReason, Date.now());
      registry.upsertFileCommentReview(review);
      return review;
    },
    // Read DURABLY rather than from the registry's projection, for the reason
    // `FileCommentManager.writable` states: the held copy is whatever was last published, and
    // the writers that move a thread are precisely the ones this has to see.
    //
    // `orphaned` is dropped because those threads have left the review; everything else stays,
    // including `answered` and `unanswered`, because `progressOf` counts them to work out
    // which comment of how many this is.
    threads: (sessionId) =>
      loadFileCommentThreadsForSession(sessionId)
        .filter((thread) => thread.status !== "orphaned")
        .sort(
          (a, b) =>
            (a.queueSeq ?? Number.MAX_SAFE_INTEGER) - (b.queueSeq ?? Number.MAX_SAFE_INTEGER) ||
            a.createdAt - b.createdAt,
        ),
    // The uncapped read, taken for ONE thread at the two moments the delivery ordinal is
    // decided rather than for every thread on every tick. The ordinal counts a message's
    // position among ALL of a thread's human messages, and the ordinary hydration carries only
    // the newest fifty - so a thread past that cap would otherwise print an ordinal the agent
    // could quote back and nothing could resolve.
    threadWithHistory: (threadId) => loadFileCommentThreadWithFullHistory(threadId),
    readFile: async (sessionId, path) => {
      const session = registry.getSession(sessionId);
      if (!session?.cwd) throw new Error("this session has no checkout to read");
      const document = await readSessionFile(session.cwd, path);
      return { text: document.text, revision: document.revision };
    },
    updateAnchor: (threadId, patch) => publish(updateFileCommentThreadAnchor(threadId, patch, Date.now())),
    beginDelivery: (threadId, deliveryId) =>
      publish(beginFileCommentDelivery(threadId, deliveryId, Date.now())),
    markDelivered: (messageId) => publish(markFileCommentMessageDelivered(messageId, Date.now())),
    markUnanswered: (threadId) => publish(setFileCommentThreadStatus(threadId, "unanswered", Date.now())),
    returnToQueue: (threadId) => publish(returnFileCommentDeliveryToQueue(threadId, Date.now())),
    requeueAtTail: (threadId) => publish(queueFileCommentThread(threadId, Date.now())),
    submit: (sessionId, text) => {
      const result = pendingTurns.submit(sessionId, text);
      return {
        ok: result.ok,
        turnId: result.pendingTurn?.id ?? null,
        error: result.error ?? null,
      };
    },
    pendingTurn: (sessionId, turnId) =>
      registry.getSession(sessionId)?.pendingTurns.find((turn) => turn.id === turnId) ?? null,
    agentTurnsSince: (sessionId, since) => {
      const session = registry.getSession(sessionId);
      if (!session) return [];
      // A harness that records no readable conversation (Codex kept none for years) is not a
      // session that failed to answer - it is a session nothing can be read out of, which is
      // what an empty read says here.
      const located = sessionMessages(session);
      if (!located) return [];
      let messages;
      try {
        // The TAIL only, and bounded: this runs once per timed-out comment, and an answer to a
        // comment delivered moments ago is at the end of the conversation or nowhere.
        messages = located.read.window(located.path, 0, FALLBACK_TAIL_TURNS).messages;
      } catch {
        return []; // an unreadable transcript is not a session that said nothing
      }
      const turns: string[] = [];
      // Newest first, which is the order the caller reads them in: a thread delivered more
      // than once wants the agent's latest word on it.
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;
        if (message.role !== "assistant" || !message.text.trim()) continue;
        // `ts` is 0 when the record carried no timestamp (see `TranscriptMessage`). Such a turn
        // cannot be placed against `since` at all, so it is omitted rather than guessed at -
        // admitting it would put a turn from an earlier delivery into this delivery's window,
        // which is the one thing this filter exists to prevent.
        if (message.ts === 0 || message.ts < since) continue;
        turns.push(message.text);
      }
      return turns;
    },
    // `appendFileCommentMessage` with `agent`, and nothing else: the fallback recovers a
    // handle but not reliably the ordinal, so it can confirm no delivery and must move no
    // status and no queue position.
    appendAgentReply: (threadId, body) => {
      const thread = loadFileCommentThread(threadId);
      if (!thread) return null;
      appendFileCommentMessage({
        id: randomUUID(),
        threadId,
        author: "agent",
        sessionId: thread.sessionId,
        body,
        now: Date.now(),
      });
      return publish(loadFileCommentThread(threadId));
    },
  };

  const walkthrough = new FileCommentWalkthrough(port);

  // 1. The confirmed-delivery signal. The ONE fact that stamps `delivered_at`.
  registry.onTurnDelivered((e) => walkthrough.onTurnDelivered(e.sessionId, e.turnId));
  // 2. Everything time-based. There is no settled-idle event in this daemon - every consumer
  //    subscribes to `session_upsert` and applies `settledIdle` with its own window, which is
  //    what the walkthrough's own timer does. This only makes it react promptly to a session
  //    that just went idle rather than waiting out the next tick.
  registry.subscribe((e) => {
    if (e.type === "session_upsert") walkthrough.onSessionChanged(e.session.id);
    else if (e.type === "session_remove") walkthrough.onSessionGone(e.id);
  });

  return walkthrough;
}
