// Claude Code's own plumbing, as it appears inside a turn the transcript attributes to
// the human.
//
// `role === "user"` does NOT mean "a person wrote this", and the grammar of what else
// arrives on that channel - `<local-command-caveat>`, `<command-name>`, the caveat XML -
// is Claude Code's, version by version. That is why it sits under `harness/claude/`
// rather than beside the byte-window machinery: another agent's scaffolding is different
// tags, or none, and a shared regex over both would be a guess about a format nobody has
// looked at yet.
//
// Two readers, two contracts, one tag vocabulary - see `conversationText` and
// `substantivePrompt` for why they are not the same function.

/**
 * Scaffolding that arrives on a user turn but that no human typed.
 *
 * `toMessage` already drops the turns that are purely a tool result, but Claude Code also
 * delivers its own bookkeeping through the same channel - and it is the MAJORITY of it.
 * Measured against this daemon's own `session_events` (396 real `UserPromptSubmit` events):
 *
 *   200 (51%)  <task-notification>   a background task reporting in
 *   188 (47%)  prose                 a human actually typed it
 *     6  (2%)  a slash command       "/no-mistakes"
 *
 * So without this filter 53% of goals would read `<task-notification> <task-id>byc4fw3pc…`.
 * A transcript read (the Tier 2 window) sees a different mix again - the `<command-*>` and
 * caveat wrappers below never reach the hook, and 265 of 265 `<command-name>` occurrences
 * were embedded in a larger turn rather than being one. That is why this strips blocks out
 * of a turn instead of classifying whole turns: both shapes occur, and only stripping
 * handles both.
 */
const DROP_TAGS = [
  "local-command-caveat",
  "local-command-stdout",
  "system-reminder",
  "task-notification",
  // The command's display name ("no-mistakes"), redundant beside <command-name> ("/no-mistakes").
  "command-message",
] as const;

/**
 * Scaffolding whose CONTENT is the human's ask, so it is unwrapped rather than dropped.
 *
 * A transcript records `/no-mistakes fix the arrow keys` as `<command-name>/no-mistakes
 * </command-name>` + `<command-args>fix the arrow keys</command-args>`, while the hook
 * reports the same thing as the flat string the human typed. Unwrapping both tags makes
 * the two sources agree, so Tier 1 (hook) and Tier 2 (transcript) can't disagree about
 * what was asked.
 *
 * Args are usually empty (17 of 387 sampled pairs carried any) but when they aren't they
 * are the whole goal - `/no-mistakes the changes for tab select, arrow movement, and hot
 * keys` is a far better sentence than `/no-mistakes`, so dropping them would throw away
 * the best signal these sessions have.
 */
const UNWRAP_TAGS = ["command-name", "command-args"] as const;

/**
 * Both match CLOSED blocks only. An unclosed tag is left alone deliberately: matching to
 * end-of-string would let a stray "<command-name>" a human typed in prose swallow their
 * entire prompt, and every one of the ~1,900 real turns sampled closed its tags. Showing
 * a slightly noisy goal beats deleting a real one.
 */
const DROP_RE = new RegExp(`<(${DROP_TAGS.join("|")})>[\\s\\S]*?<\\/\\1>`, "gi");
const UNWRAP_RE = new RegExp(`<(${UNWRAP_TAGS.join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");

/**
 * A machine tag OPENING the turn, closed or not - in which case the whole turn is machine
 * output and goes, however it ends.
 *
 * This is the truncation guard, and it is not hypothetical: `session_events` stores the
 * 120-char trimmed activity, so a `<task-notification>` logged there is cut off mid-block
 * and never closes. Any reader handed already-shortened text (that log, a future hook that
 * trims, a window clipped to a byte bound) would otherwise show the entire block as a goal
 * - the closed-block rule above silently does nothing on unclosed input.
 *
 * Anchoring to the START is what keeps this safe next to that rule. The prose it must not
 * eat mentions a tag in passing ("why does <command-name> show up in the goal?"); a turn
 * that BEGINS with one is Claude Code talking, not a person.
 */
const LEADING_MACHINE_TAG_RE = new RegExp(`^\\s*<(${DROP_TAGS.join("|")})>`, "i");

/**
 * A user turn as it should READ, with Claude Code's scaffolding removed - the conversation
 * log's counterpart to `substantivePrompt` below, over the same tags.
 *
 * Same tags, different contract, which is why this isn't just a call to that. It answers
 * "what is this session FOR?", so it flattens the text to one line and rejects turns that
 * state no work (`/clear`, effort echoes). This answers "what did the human SAY?", where a
 * `/clear` is exactly what they said and the line breaks in a pasted stack trace are the
 * shape of it - so both survive, and only what no human typed is removed.
 *
 * Without this the log renders Claude Code's plumbing as the human's own words: a turn
 * reading `<local-command-caveat>Caveat: The messages below were generated by the user
 * while running local commands…</local-command-caveat>`, attributed to "you". Stripped to
 * nothing, the turn is dropped by the empty check in `toMessage`.
 *
 * Pure, for testing.
 */
export function conversationText(raw: string): string {
  const stripped = raw.replace(DROP_RE, "");
  // A truncated block never closes, so DROP_RE can't have taken it; the whole turn is
  // machine output however it ends. Tested after the strip, since a caveat usually
  // PRECEDES real prose rather than replacing it (see `substantivePrompt`).
  if (LEADING_MACHINE_TAG_RE.test(stripped)) return "";
  return (
    stripped
      // Onto its own line rather than in place: `<command-name>/no-mistakes</command-name>
      // <command-args>fix the arrows</command-args>` with no whitespace between the tags
      // would otherwise unwrap to the single word "/no-mistakesfix the arrows". A newline
      // can't glue two tokens together, and can't disturb the indentation of a paste the
      // way collapsing runs of spaces would.
      .replace(UNWRAP_RE, (_m, _tag, inner: string) => `\n${inner.trim()}\n`)
      // The gaps those removals left - not the author's own blank lines, which stop at two.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Whole-turn text that is Claude's own echo of a local command, not an ask. `latestEffortLevel`
 * scrapes these same echoes for the effort level - here they are noise.
 */
const ECHO_RE = /^(?:\[Request interrupted[^\]]*\]|Set (?:effort level|model) to\b.*)$/is;

/**
 * Built-in commands that act on the SESSION rather than state any work. A human typed them,
 * so they pass every other test here, but neither is ever an answer to "what is this session
 * trying to solve".
 *
 * Neither reaches the hook path today - measured: 0 of 403 real `UserPromptSubmit` events
 * were `/clear` or `/compact`, though 198 transcripts contain a `/clear`; Claude Code handles
 * built-ins locally and reports them as SessionEnd/SessionStart/PreCompact lifecycle events
 * instead (only custom commands like `/no-mistakes` fire the prompt hook). This exists for
 * the TRANSCRIPT path, where it matters a lot: a `/clear` mints a new session, and that new
 * session's transcript OPENS with the clear echo - 169 of 198 sampled files have it in their
 * first 5% - so a reader taking the first substantive turn of a freshly cleared session gets
 * "/clear" as its goal.
 *
 * Deliberately narrow: exactly the two commands ruled on, not every built-in. `/tui` and
 * `/exit` are equally un-goal-like but nobody has decided that, and a filter that quietly
 * grows past what was decided is how a real ask eventually gets eaten.
 *
 * The terminator is whitespace-or-end, NOT `\b`: command names contain hyphens, and `\b`
 * matches between "clear" and "-", so `\b` silently swallowed `/clear-cache the stale build`.
 * The command token has to end for this to be that command.
 */
const META_COMMAND_RE = /^\/(?:clear|compact)(?:\s|$)/i;

/**
 * The human's own words in a user turn, with Claude Code's scaffolding removed, or null
 * when the turn contains none of them.
 *
 * Deliberately NOT length-filtered. An earlier draft of the plan called for rejecting text
 * "implausibly long to be a typed prompt", to keep Foreman's own 6k-23k char headless
 * prompts from being read as asks. Two things killed that rule: headless runs no longer
 * reach the hook at all (see `headlessEnv` in claude-cli.ts, which is what actually fixed
 * that), and real typed prompts run long - p90 of the clean first prompts on this machine
 * is 5,515 chars. A length cutoff would now reject nothing but genuine asks, and the most
 * detailed ones at that. Bounding what gets STORED is `clampPrompt`'s job instead.
 *
 * Pure, for testing.
 */
export function substantivePrompt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Closed blocks go first, so what's left leading a turn can only be an UNCLOSED tag.
  // Order matters: a caveat block usually PRECEDES real prose rather than replacing it
  // (121 of 236 sampled occurrences), so testing the leading tag before stripping would
  // throw those prompts away.
  const stripped = raw.replace(DROP_RE, " ");
  if (LEADING_MACHINE_TAG_RE.test(stripped)) return null;
  const text = stripped
    .replace(UNWRAP_RE, (_m, _tag, inner: string) => ` ${inner} `)
    .replace(/\s+/g, " ")
    .trim();
  if (!text || ECHO_RE.test(text) || META_COMMAND_RE.test(text)) return null;
  return text;
}
