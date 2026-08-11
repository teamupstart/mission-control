#!/usr/bin/env node
// Claude Code's hook bridge -> Mission Control.
//
// Configured to run for every event in `claudeHooks.events` (the event name arrives as
// argv[2]). Everything in this file is Claude's half of the bridge: the payload key
// mapping below is Anthropic's hook JSON schema, and the two sniffs read fields only a
// `PostToolUse` on `Bash` has. The transport - stdin, the POST, the timeouts, exit 0 - is
// nobody's, and lives in `@shared/hook-bridge.mjs`; a second agent's bridge is another
// file this size beside this one, not a fork of the pipeline.
//
// The daemon's other half is `HARNESSES.claude.hooks` (`src/server/harness/claude/
// hooks.ts`), which says what each of these events MEANS. The two are a pair: this file
// decides what reaches the wire, that one decides what the card does with it.
//
// The filename is load-bearing and must not change: it is the marker both installers
// match on to find their own entries in a user's `~/.claude/settings.json`, and those
// entries are live on machines running older checkouts.

import { captureTerminalEnv } from "../src/shared/harness-runtime.mjs";
import { postHookEvent, readStdin } from "../src/shared/hook-bridge.mjs";
import { opensPullRequest, pullRequestUrlsIn } from "../src/shared/pr-command.mjs";

/**
 * Sniff the PR URLs out of a PostToolUse payload. `gh pr create` prints the new
 * PR's URL on stdout, which Claude hands back in `tool_response`. Scoped to Bash
 * results so merely reading a PR page (WebFetch/Read of a pull URL) can't flash a
 * false chip; even if one slips through, the PR poller clears it within a tick
 * because the link won't match the session's branch. Returns undefined when
 * there's nothing to report - the common case, kept cheap.
 *
 * ALL of them, not the first. One tool call can open a pull request in each of a
 * multi-repo task's repositories, and the daemon has to hear about every one: the first
 * decorates the card, and each is announced so the Inspector adopts it and the task's
 * completion quorum can count it.
 */
function sniffPrUrls(payload, event) {
  if (event !== "PostToolUse") return undefined;
  if (payload.tool_name && payload.tool_name !== "Bash") return undefined;
  const field = payload.tool_response;
  if (field == null) return undefined;
  const text = typeof field === "string" ? field : JSON.stringify(field);
  const urls = pullRequestUrlsIn(text);
  return urls.length > 0 ? urls : undefined;
}

/**
 * Whether this tool call is the agent OPENING a pull request, as opposed to merely
 * printing one's URL.
 *
 * The sniff above answers "a PR URL appeared" and is deliberately loose, because all
 * it drives is a chip the poller retracts a tick later. This answers "we opened it",
 * which is a different question with a much higher bar: it is what the Inspector
 * adopts a PR on, and adopting wrongly means posting review comments on a pull
 * request that belongs to someone else. The predicate itself lives in
 * `src/shared/pr-command.mjs` so it can be table-tested; see the note there.
 *
 * Returns undefined rather than false when it doesn't match, so the common case adds
 * nothing to the wire. The command itself is NEVER sent - only this boolean - so a
 * command line carrying a secret doesn't leave the machine on account of this.
 */
function sniffPrCreated(payload, event) {
  if (event !== "PostToolUse") return undefined;
  if (payload.tool_name !== "Bash") return undefined;
  return opensPullRequest(payload.tool_input?.command) ? true : undefined;
}

/**
 * Claude's hook JSON, as `HookIngest`.
 *
 * Every key on the left is Anthropic's, version by version. Everything optional is sent
 * as `undefined` rather than null so it drops out of the JSON entirely - the daemon
 * distinguishes "this event omits the field" (keep what we knew) from "this event says
 * the field is empty", and `permission_mode` is the one that depends on it.
 */
function toIngest(payload, event) {
  const prUrls = sniffPrUrls(payload, event);
  return {
    agent: "claude",
    event,
    sessionId: payload.session_id ?? null,
    cwd: payload.cwd ?? null,
    transcriptPath: payload.transcript_path ?? null,
    ts: Date.now(),
    env: captureTerminalEnv(),
    toolName: payload.tool_name,
    prompt: payload.prompt,
    message: payload.message,
    source: payload.source,
    reason: payload.reason,
    // Claude's current permission mode (the Shift+Tab state), present on most
    // hook events. Undefined on events that omit it - the daemon keeps the last
    // known mode rather than clearing it.
    permissionMode: payload.permission_mode,
    // The scalar stays FIRST on the wire and keeps its exact meaning - the URL that
    // decorates this card - so a daemon that predates `prUrls` still reads what it always
    // did. `prUrls` is the whole set, and only the plural is fanned out to adoption.
    prUrl: prUrls?.[0],
    prUrls,
    prCreated: sniffPrCreated(payload, event),
  };
}

async function main() {
  // A headless `claude -p` the daemon or Foreman spawned is Claude Code, so it fires
  // these hooks exactly like a human's session - but it is our own machinery talking to
  // itself, not a session anyone is watching. Reporting it binds the run to a real card
  // (see `headlessEnv` in src/server/claude-cli.ts) and, once it can't, still leaves a
  // trail of phantom prompts in `session_events`. Declining here is the cheaper half of
  // the fix: no POST at all rather than a POST the daemon has to reject.
  if (process.env.MISSION_HEADLESS) return;

  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = {};
  }
  const event = process.argv[2] || payload.hook_event_name || "";
  await postHookEvent(toIngest(payload, event));
}

main().finally(() => process.exit(0));
