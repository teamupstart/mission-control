/**
 * What the conversation pane's AGENT launcher does for a given session - and the one place
 * that is decided.
 *
 * The button means "put me on this conversation, in a real terminal", and there are three
 * genuinely different ways to honour that:
 *
 *  - The session already runs in a pane. Then the terminal exists, and the answer is to
 *    FOCUS it. Spawning `claude --resume <id>` beside it would start a SECOND process on
 *    one conversation file, which is not a second view of the session - it is two agents
 *    appending to the same store, and the harnesses do not arbitrate that.
 *  - The session is embedded (`runtime: "sdk"`). Its driver has to stop before the same
 *    conversation opens in a terminal, so this is a handoff rather than a second launch.
 *  - An exited agent has nothing left to focus or stop. Its retained pane handles are stale,
 *    so the conversation is resumed in the terminal the operator chooses.
 *
 * Pure, and in `shared`, because BOTH sides have to reach the same verdict. The browser
 * asks it to shape the control - with a live pane there is no terminal to choose, so the
 * button loses its caret and its menu entirely - and the daemon asks it to refuse a request
 * that disagrees. Split into two implementations they would drift, and the drift is silent
 * in the worst direction: a UI offering resume over a live pane, and a route that takes it.
 * This is the treatment `resolveSessionRuntime` gets for the same reason.
 */

import type { AgentType, SessionRuntime, SessionState } from "./types.ts";
import type { PaneHandles } from "./pane.ts";
import { canWriteTo } from "./pane.ts";
import { capabilitiesFor } from "./harness-capabilities.ts";

/**
 * What the agent launcher will do. `null` means it can do nothing, and
 * `agentLaunchBlockedReason` says what was missing.
 */
export type AgentLaunchAction = "focus" | "handoff" | "resume";

/**
 * The narrow shape this needs, rather than a whole `Session`.
 *
 * `canMessage` takes its inputs this way for a stated reason and this follows it: a caller
 * holding something less than a full session - a `DiscoveredSession`, a test fixture - can
 * still ask, and cannot accidentally be handed a session-shaped object that happens to be
 * missing the field the verdict turns on.
 */
export interface LaunchableSession extends PaneHandles {
  agent: AgentType;
  runtime: SessionRuntime;
  state: SessionState;
  cwd: string | null;
  /** The harness-native conversation id, once the session has reported one. */
  agentSessionId: string | null;
}

/**
 * Which action the agent launcher takes, or null when none is possible.
 *
 * Order matters and is not arbitrary: an exited session's retained pane handles are stale.
 * For every live session, the pane check still comes before any question about whether the
 * harness can resume. A live session with a pane is focusable whatever its harness can do
 * with a session id, and asking about resume first would grey out the button for a harness
 * with no resume spec even though focusing its pane would have worked perfectly.
 */
export function agentLaunchAction(s: LaunchableSession): AgentLaunchAction | null {
  if (s.state === "stopping") return null;
  if (s.state !== "exited" && canWriteTo(s)) return "focus";
  if (!capabilitiesFor(s.agent).resumes) return null;
  if (!s.agentSessionId) return null;
  if (!s.cwd) return null;
  if (s.state === "exited") return "resume";
  return s.runtime === "sdk" ? "handoff" : null;
}

/**
 * Why the agent launcher can do nothing, as a sentence, or null when it can.
 *
 * A sentence rather than a boolean, the rule `OpenTargetView.unavailable` sets: "this
 * harness cannot reopen a conversation" is a permanent property of the build, "it has not
 * reported a conversation id yet" resolves itself in a second, and "no checkout" is a
 * discovery gap. Three different things for a human to do, and one greyed button with no
 * explanation covers all three equally badly.
 *
 * The checks run in the same order as `agentLaunchAction`'s, so the reason always names the
 * FIRST thing missing rather than an arbitrary one.
 */
export function agentLaunchBlockedReason(s: LaunchableSession): string | null {
  if (agentLaunchAction(s) !== null) return null;
  if (s.state === "stopping") return "this session is stopping";
  if (!capabilitiesFor(s.agent).resumes) {
    return `${s.agent} cannot reopen a conversation from its command line`;
  }
  if (!s.agentSessionId) return "this session has not reported a conversation id yet";
  if (!s.cwd) return "this session has no checkout to open a terminal in";
  return "this live session has no terminal pane to focus";
}

/**
 * Whether a shell can be opened for this session at all.
 *
 * Only the checkout is required - unlike the agent launcher this asks nothing about the
 * harness, because a shell is not the agent's. Kept beside its sibling so the two refusals
 * are written in one vocabulary.
 */
export function shellLaunchBlockedReason(s: {
  cwd: string | null;
  workspace?: { authority: "provider"; capabilities: { shell: boolean } } | null;
}): string | null {
  if (s.workspace?.authority === "provider" && !s.workspace.capabilities.shell) {
    return "Pinned Pipeline evidence is read-only";
  }
  return s.cwd ? null : "this session has no checkout to open a terminal in";
}
