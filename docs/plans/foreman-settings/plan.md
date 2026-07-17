# Foreman settings: repo picker + move Tier out of the quick popover

Give Foreman a home in the settings panel: a repository **picker** for the live
allowlist (instead of pasting long paths into a textarea), and the **Tier** (cheap-tier)
control moved off the topbar popover. The popover keeps only the quick, in-the-moment
knobs.

> **Decided:** picker candidates come from **known fleet repos + a validated manual add**
> (Decision 1A); the popover keeps a **read-only "Live in N repos - manage in Settings"**
> summary in Live mode (Decision 2A).

## Why

Two problems with today's `ForemanBar` popover:

1. **The allowlist is a paste-a-path textarea.** To make Foreman live in a repo you type
   or paste its full realpath, one per line (`ForemanBar.tsx:217-240`). It only appears in
   Live mode, it's easy to typo, and there's no help picking a valid repo root - even
   though the dashboard already knows every session's repo.
2. **The popover is overloaded.** Enable, Mode, Auto-approve, Tier, Work queues, On-drain,
   and the allowlist all stack in one dropdown. Tier (the cheap-tier posture) is a
   configure-once policy, not a thing you flip in the moment - it doesn't belong next to
   Mode.

Now that settings live in navigable categories (the two-pane settings panel), Foreman gets
a category, and the durable configuration moves there.

## What moves where

| Control | Today | After |
|---|---|---|
| Enable Foreman | popover | **popover** (quick) |
| Mode (dry-run / semi-auto / live) | popover | **popover** (quick) |
| Auto-approve non-destructive access | popover | **popover** (quick) |
| Work queues (fix attempts, fix rounds) | popover | **popover** (quick) |
| On drain (ask / no-mistakes / pr) | popover | **popover** (quick) |
| **Tier (cheap tier: off / shadow / on)** | popover | **Settings → Foreman** |
| **Live repo allowlist** | popover textarea (Live mode only) | **Settings → Foreman** (picker + list) |

The split is deliberate: the popover keeps what you reach for while watching the fleet
(is it on, what mode, how deep the queue); the settings page holds what you set up once
(which tier posture, which repos are trusted for live sends).

## The repo picker

The allowlist is a list of **repo roots** (realpaths) Foreman may act in when live
(`ForemanConfig.repoAllowlist`, `protocol.ts:288`). The dashboard already carries exactly
these paths: every `SessionRow` has a `repoRoot` (`types.ts:121`) - "the root of the REPO
this checkout belongs to, from git's common dir ... the same `foremanAllowlisted` the
server gates on." So the picker can offer the repos the fleet is already working in,
instead of asking you to type a path.

**Settings → Foreman, below the settings rows:**

- **Enabled repositories** - the current `repoAllowlist`, one row each, with a remove (×).
  Empty state says "No repos yet - Foreman won't act live anywhere."
- **Add a repository** - a picker of candidate repo roots the fleet knows about but that
  aren't on the list yet, deduped. Pick one (or several) and Add appends to the allowlist.

Adding/removing is the existing `update({ repoAllowlist: [...] })` call - the daemon and
persistence are unchanged; only the input changes from free text to a picked value.

### Open question: where the picker's candidates come from

- **A. Live-session repos + manual add** *(recommended)* - candidates are the distinct
   `repoRoot`s across current sessions (derived on the client from data the dashboard
   already has), plus a text field to add a repo that has no active session, validated
   server-side so a typo can't enter a non-repo path. Covers the common case with zero new
   data and still lets you add a cold repo deliberately.
- **B. Live-session repos only** - the same client-derived list, no manual field. Simplest,
   no backend at all - but a repo with no session on the grid right now can't be added, so
   you're stuck when setting up a repo before its first session.
- **C. Filesystem directory browser** - a new daemon endpoint lists directories so you can
   navigate and pick any folder, validated as a git root. Most flexible, most surface: a
   new browsing API, its own UI, and path-traversal care. Heaviest for a list that is
   usually 1-3 entries.

## The popover, after

`ForemanBar` drops the Tier fieldset and the allowlist textarea. In Live mode, rather than
show nothing about which repos are trusted, it shows a one-line read-only summary that
points at the new home.

### Open question: what the popover says about the allowlist

- **A. Read-only summary + link** *(recommended)* - in Live mode, "Live in N repos - manage
   in Settings," so the popover still answers "is this repo covered?" at a glance without
   being an editor.
- **B. Nothing** - drop every mention; the allowlist lives only in Settings. Cleanest
   popover, but you lose the at-a-glance "am I actually live here" that Live mode wants.

## Implementation sketch

- **`src/web/components/ForemanSettingsPanel.tsx`** (new) - the Foreman settings category:
  the Tier radios (moved verbatim from the popover), then the allowlist manager (list +
  picker). Takes a `ForemanState` like `SkillsPanel` takes `SkillsState`.
- **`src/web/components/SettingsModal.tsx`** - add `{ id: "foreman", label: "Foreman", icon:
  … }` to `SETTINGS_CATEGORIES` and a `case` in `renderCategory`. Lift `useForeman` into the
  modal (as `useSkills` already is) so its poll runs while the category is open. Candidate
  repos come from the `sessions` the app already holds, passed in.
- **`src/web/components/ForemanBar.tsx`** - remove the Tier fieldset and the allowlist
  textarea; add the Live-mode summary line (per the decision above).
- **Server** - only if option A/C is chosen for candidates: a small validated
  "resolve this path to a repo root" endpoint, reusing the existing `resolveRepoRoot` /
  `realpathSync(top)` logic already used by dispatch (`routes.ts:982-989`). No schema or
  persistence change - `repoAllowlist` is already an array of strings.

## Testing

- Render test (`react-dom/server`, repo convention): the Foreman category lists the Tier
  options and the current allowlist; the picker offers a known repo not already listed and
  omits ones already on it; the empty state renders.
- Keep the `ForemanBar` behavior verified after Tier/allowlist removal (mode/queues/on-drain
  still commit).

## Sequencing

This builds on the two-pane settings panel (`mancej/settings-sidebar`), which is still in
validation. Implement on a follow-up branch based on that work once it settles, so the
in-flight run isn't disturbed.

## Out of scope

- Any change to how `repoAllowlist` persists or how the server gates live sends.
- Moving Enable / Mode / Work queues / On-drain (they stay in the popover, by request).
- Auto-approve access and the Tier model id (`triageModel`) - unchanged.
