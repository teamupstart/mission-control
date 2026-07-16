// The skills feature's shared vocabulary: the marker that scopes what the
// reconciler may touch, the rungs a skill's enforcement can sit on, and the one
// command the daemon types to make a session pick up a change.
//
// It lives on the shared surface because all three cross the server/web boundary:
// the panel draws the rung, the catalog parses it, and the reconciler and the
// reload loop must agree on the prefix or the reconciler would either miss its own
// links or reach for someone else's.

/**
 * Every prefix the reconciler has ever created a `~/.claude/skills` directory under,
 * newest first: the head is what it WRITES today, and the whole list is what it
 * RECOGNISES as ours - i.e. the only things it will ever remove.
 *
 * That directory is the operator's, not ours - `no-mistakes`, `implement-plan` and
 * friends live there and are hand-authored. The prefix makes them untouchable by
 * construction rather than by care.
 *
 * It costs almost nothing legible: a skill's directory name and its frontmatter `name`
 * are independent, so `mission-html-plans/` containing `name: html-plans` presents in
 * the slash menu as `/html-plans`. The harness owns the namespace; the user types a
 * clean name.
 *
 * A LIST rather than one string, for the same reason `LEASE_HOLDERS` is: a directory
 * name outlives a rename. The `fleet-<id>` dirs are still sitting in `~/.claude/skills`
 * on every machine that enabled a skill before the rename, and they are still the links
 * Claude loads. A recogniser that knew only the current prefix would stop seeing them as
 * ours - never reconciled, never removed by the master switch, and a `mission-` duplicate
 * installed beside each one. They were us; answering the real question ("did WE put this
 * here?") means asking about all of them. Append on any future rename; never remove.
 *
 * One caveat, observed rather than assumed (claude 2.1.211): the MODEL's own skill
 * registry uses the DIRECTORY name, so it sees `mission-html-plans` where the human sees
 * `/html-plans`. Harmless - the description is what decides whether it reaches for the
 * skill, and that is untouched - but it means the prefix is not quite invisible, and
 * anything that ever matches on a skill's model-facing name has to expect it.
 */
export const SKILL_DIR_PREFIXES = ["mission-", "fleet-"] as const;

/** The prefix new directories are created under - the head of `SKILL_DIR_PREFIXES`. */
export const SKILL_DIR_PREFIX = SKILL_DIR_PREFIXES[0];

/** The directory name a catalog id gets when we install it fresh. */
export function missionSkillDirName(id: string): string {
  return `${SKILL_DIR_PREFIX}${id}`;
}

/**
 * The catalog id behind one of our directory names, or null when it isn't ours -
 * which doubles as the answer to "is this ours to remove?", and is the ONLY place the
 * prefix list is matched against a name. One encoding: a second one could drift from
 * this on the next rename, which is the very thing the list above exists to prevent.
 */
export function skillIdFromDirName(name: string): string | null {
  const prefix = SKILL_DIR_PREFIXES.find((p) => name.startsWith(p));
  return prefix ? name.slice(prefix.length) : null;
}

/**
 * The command that makes a live session re-read `~/.claude/skills` without being
 * restarted. Verified against claude 2.1.211: a directory symlinked in AFTER a
 * session reached its prompt is picked up by this and nothing else - there is no
 * watcher on the skills directory.
 *
 * Spelled once, here, for the same reason `WRAPUP_NO_MISTAKES` is: it is typed into
 * a live pane, so the bytes must have exactly one definition. It must also stay a
 * single line - a slash command that carries a newline is two submissions.
 *
 * Do NOT parse what comes back. On a REMOVAL the count correctly dropped (the skill
 * really did unload) while the label still read "(no changes)". The unload is real;
 * the message is not trustworthy. Treat delivery as fire-and-forget.
 */
export const RELOAD_SKILLS_COMMAND = "/reload-skills";

/**
 * How firmly a skill actually binds - and the reason the catalog carries it at all.
 *
 * Native skills are MODEL-INVOKED: enabling one loads its description into context
 * and nothing more. `/reload-skills` fixes *delivery*, not *activation*, and a
 * reloaded skill is loaded, not obeyed. The rung is what stops the panel's "Claude
 * will use this when relevant" from masquerading as a guarantee.
 *
 *  - `opportunistic` - Claude may reach for it when it judges it relevant.
 *  - `triggered`     - the description names concrete triggers, so it fires reliably
 *                      on those and not otherwise.
 *  - `intercepted`   - the skill installs something (a hook, a gate) that runs
 *                      whether or not the model chooses to.
 *  - `always-on`     - in context for every turn, no invocation involved.
 *
 * v1 ships nothing above `triggered`: the rungs above need hooks or an output style,
 * which the global-scope decision deliberately kept out (see the plan).
 */
export const SKILL_ENFORCEMENTS = ["opportunistic", "triggered", "intercepted", "always-on"] as const;
export type SkillEnforcement = (typeof SKILL_ENFORCEMENTS)[number];

/** The short label the panel's badge shows for each rung. */
export const ENFORCEMENT_LABEL: Record<SkillEnforcement, string> = {
  opportunistic: "when relevant",
  triggered: "on triggers",
  intercepted: "enforced",
  "always-on": "always on",
};

/** What the badge's tooltip says the rung actually promises. */
export const ENFORCEMENT_HINT: Record<SkillEnforcement, string> = {
  opportunistic: "Claude reaches for this when it judges it relevant. Loaded, not guaranteed.",
  triggered: "Fires on the triggers named in its description, and not otherwise.",
  intercepted: "Runs whether or not the model chooses to.",
  "always-on": "In context on every turn - no invocation involved.",
};
