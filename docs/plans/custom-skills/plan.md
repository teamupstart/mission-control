# Plan: Custom Skills (fleet-wide skill toggles)

Status: **built.** See "As built" at the foot for what changed on contact with the code,
and for the answer to the packaged-Electron question this plan left open.
Companion doc: the options analysis and the evidence behind every claim here live in the
review artifact; this file is the buildable version.

## Goal

Let an operator review a catalog of skills in the dashboard, read a short description, and
toggle one on. Enabling it must apply to **every** Claude session on the machine, including
sessions the harness never launched, and **running sessions must pick it up without being
terminated or recreated**. They may wait for a natural break, but a restart is not an
acceptable cost.

Skills are ordinary Claude Code skills. We use Claude's own skill loading rather than
reimplementing it.

## Why it fits this codebase (reuse, not rebuild)

Almost nothing here is new mechanism. The pieces already exist and are load-bearing elsewhere:

- `app_config` (`src/server/db.ts:129`) is a JSON-blob KV with `getAppConfig`/`setAppConfig`
  (`:1091`). A new key needs **no migration**.
- `src/server/foreman/config.ts:44` is the exact template for a schema-validated,
  server-persisted config bag.
- `settledIdle` (`src/server/foreman/queue-machine.ts:103`) already encodes "safe to type into
  this pane". We import it. We do not re-derive it.
- `injectPrompt` (`src/server/actions.ts:98`) already types into panes, and
  `autoWrapupPayload` (`src/shared/queue.ts:91`) already types a slash command
  (`/no-mistakes`) into a live session. `/reload-skills` is the same move, and a safer one:
  it does not push, does not commit, and is idempotent.
- `hooks/install.mjs` is the house discipline for touching global config: marker-matched,
  idempotent, preserves the user's formatting byte-for-byte. The skills reconciler copies it.
- `discovery/pane-mode.ts` already reads panes with `tmux capture-pane`.
- UI: `.kb-row` (`src/web/styles.css:3161`) is a label+description+control row already.
  `ForemanBar.tsx:122` has the master-toggle + `fieldset disabled` cascade. `useForeman.ts:70`
  has optimistic-update-with-revert.

The one genuinely new thing is **the daemon typing into panes unprompted**. See Edge cases.

## Verified behaviour (tested, not assumed)

Tested end-to-end against `claude 2.1.211` in a real tmux pane, using `injectPrompt`'s exact
`set-buffer` / `paste-buffer -p` / `send-keys Enter` sequence. A session was booted **without**
the skill, the symlink added **after** it reached its prompt, then `/reload-skills` injected:

```
❯ /reload-skills
  ⎿  Reloaded skills: 52 skills available (no changes)   ← before, symlink absent
# symlink created here, mid-session, no restart
❯ /reload-skills
  ⎿  Reloaded skills: 53 skills available (1 added)      ← picked up
```

Established by that test and its controls:

1. **`/reload-skills` picks up a newly symlinked directory mid-session.** The requirement is
   satisfiable. Command def: `name: "reload-skills"`, `supportsNonInteractive: true`,
   `thinClientDispatch: "post-text"`.
2. **Symlinks are followed.** Targets under both `/private/tmp` and `~/workspace` loaded.
3. **The `fleet-` directory prefix is safe.** Directory name and frontmatter `name` are
   independent: `fleet-html-plans/` containing `name: html-plans` loads and presents as
   `/html-plans`. Omitting `name` defaults it to the directory name. This is the ideal split:
   the harness owns the directory namespace, the user sees a clean skill name.
4. **`disable-model-invocation: true` excludes a skill from the "N available" count** and from
   model reach entirely. Almost never what a fleet skill wants. Do not set it in the catalog.
5. **Do not parse the response.** On removal the count correctly dropped (skill unloaded) but
   the label still read `(no changes)` instead of `(1 removed)`. The unload is real; the
   message is not trustworthy. Treat injection as fire-and-forget.
6. **Nothing auto-reloads.** No watcher on the skills directory. The existence of a command
   described as "Pick up skills added or changed on disk during this session" is itself the
   proof. The reload must be triggered.

## Decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Delivery | Skill files symlinked into `~/.claude/skills/` | Native loading, covers hand-started sessions |
| Reload loop home | The daemon | Always works; port bind is the mutex, no lease |
| Reload gate | `settledIdle` **plus** a `capture-pane` check | Strictest; see Edge cases for why |
| Scope | Global, v1 | **Removes the hook layer entirely from v1** |
| Blast radius | Global is the point | Accepted; does not relax marker discipline |
| Codex | Label rows claude-only, ship | Needs an agent badge and an honest count |
| Catalog | Baked into the repo | Sharpens the asar question below |
| UI home | A section in `SettingsModal` | Gains that modal's first async error path |

Global scope is the most valuable answer: per-repo scoping was the only justification for a
`SessionStart` `additionalContext` layer, so v1 needs **no** change to `harness-hook.mjs`, and
the hook's "write NOTHING to stdout" contract (`harness-hook.mjs:9`) survives intact. The
`/hooks/:event` route keeps returning `204`.

## The catalog (`skills/<id>/SKILL.md`, new)

Baked into the repo, versioned and reviewable with the app. Standard Claude frontmatter plus a
`fleet` block for catalog display:

```yaml
---
name: html-plans           # what the user sees; may differ from the directory
description: ...           # preloaded into context; drives model invocation
metadata:
  fleet:
    category: planning
    enforcement: opportunistic | triggered | intercepted | always-on
---
```

`enforcement` is not decoration. Native skills are **model-invoked**: enabling one does not
guarantee behaviour. The UI must show which rung a skill sits on so
"Claude will use this when relevant" never masquerades as a guarantee. `/reload-skills` fixes
*delivery*, not *activation*. A reloaded skill is loaded, not obeyed.

## Data model (`src/shared/protocol.ts`)

Beside `ForemanConfigSchema:220`, same partial-patch shape:

```ts
export const SkillsConfigSchema = z.object({
  enabled: z.boolean().default(false),          // master switch
  skills: z.record(z.boolean()).default({}),    // id -> enabled
  generation: z.number().int().default(0),      // bumped ONLY when the symlink set changes
});
```

`generation` is the whole coalescing story. A session never needs more than one reload to
become current no matter how many skills were flipped, so this is a **watermark, not a queue**.
Flip five skills in ten seconds and the generation lands at 5; a session that reloads once
reads the current directory and is done. A queue would have typed five commands into every
pane.

Bump the generation **only when the reconciler actually changed the symlink set**, never on
any config write. Otherwise touching an unrelated setting reloads the whole fleet.

Per-session ack: a new `skills_ack` column or row keyed by `noteKeyFor(s)` (`registry.ts:1688`)
holding the last generation that session acknowledged.

## Backend changes

### `src/server/skills/catalog.ts` (new)
Scan `skills/`, parse frontmatter, return `{ id, name, description, category, enforcement }[]`.

### `src/server/skills/config.ts` (new)
Mirror of `foreman/config.ts:44`. `getSkillsConfig` / `setSkillsConfig` over `app_config` key
`"skills"`. No migration.

### `src/server/skills/reconcile.ts` (new)
Sync `~/.claude/skills/fleet-<id>` against the enabled set.

- Marker: the `fleet-` prefix. **Only ever touch entries matching it.** The operator's
  `cyc-prod-build`, `no-mistakes`, `fix-bugs`, `implement-plan`, `phase-plan` must be
  untouchable by construction, not by care.
- Idempotent. Re-running is a no-op.
- Returns whether anything changed, so the caller knows whether to bump the generation.
- Uninstall removes every `fleet-*` and nothing else.

### `src/server/skills/reload.ts` (new) - the broadcast loop
Hangs off the **existing 1500ms discovery tick** (`config.ts:25`) rather than keeping its own
timer. The poller already re-reads the whole fleet each pass, which is exactly the freshness
this needs: a fan-out that snapshots once and injects N times reintroduces precisely the
staleness the per-target re-read at `worker.ts:288` exists to prevent. Riding the poller makes
the correct behaviour the lazy one.

Per tick, in this order (cheapest filter first):

1. `agent === "claude"` and `state !== "exited"`. Codex has no `/reload-skills`.
2. `ack < generation`. Skips everything already current.
3. `settledIdle(s, now, settleMs)` - imported from `queue-machine.ts:103`, not copied.
4. **Only now** spawn `capture-pane` and confirm a normal prompt. It is the last gate, not a
   filter: a subprocess per session per tick would be a real cost.
5. Mark the ack **before** injecting. Never retry.

Step 5's ordering is copied deliberately from the auto-wrapup path (`queue-apply.ts:277`),
whose comment stands: *"Never retry: a retry IS the double-push."* A reload is far more
forgiving than a wrap-up, but the ordering costs nothing and removes a class of double
delivery.

The `/reload-skills` literal lives in `src/shared/queue.ts` beside `autoWrapupPayload`, for the
reason that file already gives: the worker and the card must send the same bytes.

### `src/server/actions.ts:178`
Generalize the `driving` set from permission-mode cycling to **any pane write**. Nothing today
stops a reload broadcast from interleaving keystrokes with a Foreman auto-wrapup into the same
pane; a fleet-wide broadcast is the first feature that makes that collision likely.

### `src/server/routes.ts` (~:780, beside the foreman routes)
- `GET /api/skills` - catalog plus enabled state plus a stale count.
- `PUT /api/skills/config` - patch, reconcile, bump generation if changed.

## Frontend changes

### `src/web/useSkills.ts` (new)
Clone `useForeman.ts`: 4s poll, optimistic update with revert. Skills config is coarse
dashboard chrome, not worth an SSE channel (that file's comment explains why). A rejected patch
must not leave its value on screen.

### `src/web/components/SkillsPanel.tsx` (new)
Rows on the `.kb-row` shape. Master toggle plus `fieldset disabled` cascade from
`ForemanBar.tsx:113-122`. Each row shows name, description, an **enforcement badge**, and a
**claude-only badge**. Where useful: "N sessions will pick this up when they next go idle",
excluding codex sessions or the count lies on a mixed fleet.

### `src/web/components/SettingsModal.tsx:30`
A second `<section className="settings-section">`. Note this modal has only ever persisted to
localStorage, so it gains its first async error path; `:104` already renders a
`.settings-error`, so wire `config.error` into it.

### `src/web/styles.css:3161`
`.skill-row` derived from the existing `.kb-row` block, plus badge styles.

### `README` / architecture notes
Record that **the daemon is no longer strictly reactive**. See below.

## Edge cases & safety

**The Enter key is the whole problem.** `injectPrompt` sends `Enter` unconditionally
(`actions.ts:114`). A permission dialog is a **select list, not a text prompt**: the pasted
text is swallowed and `Enter` activates whichever option is highlighted. That is an unattended
answer to a permission prompt nobody read, delivered to every session at once.

This is not hypothetical. It happened on the first attempt at the test above. A freshly spawned
`claude` in an unfamiliar directory does not open at its prompt, it opens on:

```
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
  2. No, exit
```

The probe pasted `/reload-skills` and would have sent `Enter` into that list, answering "Yes, I
trust this folder". It only escaped because the readiness check did not match, so it timed out
instead of injecting. A broadcast that assumes "the session is up, therefore it is at a prompt"
would press that button in every pane. **The gate is not paperwork.** This is why the decision
was `settledIdle` *plus* `capture-pane`.

Note `reportBucket(s) === "idle"` is **not** a safe substitute for `settledIdle`: idle is that
function's catch-all fallthrough (`session.ts:135`), so it is true for uninstrumented sessions
where idleness is a default rather than a report.

**The daemon stops being reactive.** Until now it typed into a pane only downstream of a route
call, which meant downstream of a person; autonomous typing was quarantined in Foreman's
separate leased opt-in process. This ends that invariant. The risk is not v1, it is v2, when
someone reasons from the old rule. Write it down where the next reader hits it.

**Global blast radius.** `~/.claude/skills` affects every claude on the machine, including
sessions the fleet has nothing to do with. Accepted deliberately. `install.mjs` set the
precedent, but hooks only changed telemetry; skills change what the model does. Marker
discipline and a real uninstall are therefore not optional.

The real uninstall is the **master switch**, and only it: `applySkillsConfig({enabled:
false})` persists the intent, unlinks every `fleet-*`, and bumps the generation so the
fleet is told to drop them. That durability is the whole point - the daemon reconciles
`~/.claude/skills` against the config on every start, so any removal that leaves the
config saying "on" is undone by the next launch, which would also re-broadcast a reload.
`uninstallSkillLinks()` is the walk, not the decision: it is reached from
`hooks/install.mjs --uninstall` as a dev-teardown convenience (a checkout being abandoned
has no panel to click), and is deliberately NOT wired into the packaged tray's "Remove
Claude integrations", which is scoped to hooks and the MCP server. The tray runs in the
Electron main process, which supervises the daemon rather than owning the config - it
could unlink, but it could not make it stick.

**Transcript cost.** Each reload writes a command and its response into the session's context.
Cheap once, not free across twenty sessions times every toggle. The generation watermark is the
mitigation; the misuse to avoid is bumping it on any config write.

**Packaged Electron (open, decide at build time).** A repo-baked catalog plus a symlink means
`~/.claude/skills/fleet-x -> <appRoot>/skills/x`. Fine from the repo. In a packaged build the
resources may live inside an `.asar`, which is not a real directory, so `claude` could not read
through the symlink. The mechanism is proven sound (symlinks are followed, `/private/tmp`
targets load); the only question is whether `appRoot` is a readable path when packaged. If not,
the reconciler copies instead and compares a content hash to detect drift.

**Codex.** No `/reload-skills`, no `~/.claude/skills`. Rows are labelled claude-only and the
loop filters `agent === "claude"`. A toggle that silently no-ops on half the grid is the same
failure that disqualified launch flags.

## Testing

- `reconcile`: creates/removes only `fleet-*`; leaves a fixture "user skill" untouched;
  idempotent across repeated runs; reports changed/unchanged correctly.
- `generation`: bumps only when the symlink set changes; N rapid toggles produce one reload per
  session (watermark, not queue).
- `reload` selector: excludes codex, excludes exited, excludes `ack >= generation`, excludes
  `!settledIdle`. Assert an `awaiting_input` session is **never** selected. This is the test
  that matters.
- `reload` ordering: ack is written before inject; a failed inject does not retry.
- E2E (manual, documented): the tmux probe above. Boot a session, symlink mid-session, inject,
  assert `(1 added)`.
- UI: render tests via `react-dom/server` (the SSE stream blocks browser automation on this
  dashboard).

## Out of scope (future)

- Per-repo scoping via `SessionStart` `additionalContext`. Only if global proves wrong.
- User-authored skills and an editor.
- Adopting the operator's existing `~/.claude/skills` as read-only catalog rows.
- Plugin packaging for skills that need hooks, output styles, or MCP bundled with them.
  `/reload-plugins` exists as the sibling, but is `supportsNonInteractive: false` and dispatches
  as a `control-request`; the skills path is the better-supported one.
- Always-on enforcement above the "intercepted" rung (output styles, `--append-system-prompt`).
- Codex parity via `AGENTS.md`.

## As built

Everything above shipped as decided. What follows is only where the code differs from
the text, plus what the build established that the plan could not.

**The asar question is answered: symlinks, no copy.** `electron-builder.yml` already
ships `asar: false`, and for a closely related reason - Claude launches the satellite
scripts with an EXTERNAL node that can't read inside an archive either. So `appRoot/skills/<id>`
is a real directory in a packaged build and the symlink resolves. `skills/**/*` was added
to the packaged `files` list. If asar is ever turned back on, the reconciler must copy and
compare a content hash; nothing on the symlink path survives it.

**The catalog dir resolves from `config.ts`, not from `skills/catalog.ts`.** esbuild
bundles the whole server into `dist/server/index.mjs`, so every bundled module's
`import.meta.url` collapses to that one file's - and only a module already two levels down
in the source tree resolves `../../skills` the same before and after bundling. `catalog.ts`
is three levels down, so the identical expression there is correct packaged and points at a
nonexistent `src/skills` in dev. This was a real bug, caught by the catalog test.

**The `/reload-skills` literal lives in `src/shared/skills.ts`, not `src/shared/queue.ts`.**
The plan's stated reason - "the worker and the card must send the same bytes" - doesn't
transfer: there is no card, and the reload has exactly one sender. It's still on the shared
surface (it's typed into a pane, so the bytes need one definition), just not inside a module
about the work-item lifecycle. The enforcement rungs needed a shared home anyway.

**The reload loop has its own timer rather than riding `startPoller`.** It reuses
`POLL_INTERVAL_MS`, so there's no new knob, and it matches the three sibling pollers
(nomistakes, pr, runtime-meta). What "ride the poller" was actually protecting - a
per-target re-read instead of a fan-out from one snapshot - is kept, and is the
load-bearing half.

**Two things the plan didn't have, both forced by the same question ("what does this
feature owe an operator?"):**

- `generationAt`. Without it every session discovered from here to the end of time gets an
  unsolicited `/reload-skills` the first time it goes idle: no ack row, and `0 < generation`
  forever. A session that booted after the symlink landed already loaded it.
- A rollback on `pasted: false`. The plan inherited "never retry" from the auto-wrapup
  path, whose reason - *"a retry IS the double-push"*, because `/no-mistakes` opens a PR -
  is exactly what does not transfer. `/reload-skills` is idempotent, so here a silent miss
  (the panel claiming a skill is live in a session that never heard) is worse than a
  duplicate. The ack still lands before the keystroke; it's taken back only on the one
  state actions.ts defines as positive evidence nothing reached the pane.

**`applySkillsConfig` decides before it writes, and reconciles before it persists.** A
half-applied patch would leave the config claiming a skill that isn't on disk, and every
way of rendering that lies; the remaining crash window is the harmless direction (disk
ahead of config), which startup's `reconcileSkills` heals. The first cut wrote and rolled
back instead, which was wrong twice over: the undo pass also HEALED unrelated drift, so
the disk really moved while the caller reported `changed: false` and told nobody - a
skill installed that no session would ever load, and no drift left for the panel to
report - and afterwards nothing could tell the healing from the undoing. Refusing up
front has no write to take back.

**Refusal is scoped to the patch, at BOTH layers.** A reconcile pass reports on every
enabled skill, not just the ones that moved, so one stuck row (a skill a `git pull`
deleted) makes `problems` non-empty forever. Scoping only the rollback wasn't enough -
the route still answered 409 on any problem, which turned a toggle that had fully
applied (links written, generation bumped, fleet notified) into "nothing changed",
reverted the switch, then let the next poll flip it back on. `refused` is therefore its
own field, separate from `problems`, and the route 409s on that alone.

**The catalog distinguishes "absent" from "unreadable", and the reconciler keys on
directories that EXIST rather than on rows we could parse.** This was the worst bug in
the first cut, and it was invisible because the wrong behaviour had a test asserting it.
"Not in the parsed catalog" has two causes - deleted from the repo, or its SKILL.md
defeated our deliberately narrow frontmatter reader - and only the first is a reason to
unlink. Conflated, a formatting-only edit (a description folded to `>-`, still valid
YAML, still loaded by Claude) uninstalled a working skill from every session on the
machine and bumped the generation so they all dropped it at once. An unreadable
`skills/` was worse: every id looked deleted, so one permissions hiccup uninstalled the
lot. The catalog now reports `readable` and `present`, the reconciler refuses to touch
anything when the catalog is unreadable, and a block scalar is reported instead of read
as the literal string `">-"`.

**`changed` means "what Claude loads moved", not "we wrote something".** Two bugs here:
a `remove() && link()` short-circuit dropped an unlink on the floor when the relink
failed (disk moved, `changed: false`, nobody told - the one state this design must not
have), and re-pointing a link whose old target still RESOLVED was counted as a change,
so rebuilding the app somewhere else typed `/reload-skills` into every idle claude on
the machine.

**`pendingReloads` and `reloadNeeded` share one predicate (`reloadOwed`).** They had
drifted: the count omitted `hasPane` and `hooksSeen`, so it sat above zero forever for
sessions nothing could ever reload - the exact never-reaches-zero failure the count
excludes codex to avoid. The split is the codebase's own `hooksSeen` (permanent, so it
belongs to the count) vs `instrumented` (a 30-minute freshness window, so it belongs
only to "safe to type right now" - a healthy session that goes quiet flips it, and the
count must not blink out for one).

**The panel re-reads the disk rather than trusting the reconciler's memory.** Reconcile
problems reach the operator on the PUT that produced them; a STARTUP reconcile has no
PUT to answer, so its failures went to a console nobody reads while every toggle
rendered on. `skillDrift` is a read-only check on each poll.

**The `skills` patch merges per key.** Replacement would make the panel round-trip the
whole map on every click, so a second open dashboard would silently switch off a skill the
first just enabled fleet-wide.

**"Absence of evidence is not evidence" turned out to be the whole shape of this
subsystem's bugs**, and it recurred in four places that each looked unrelated: a skill
missing from the parsed catalog (deleted, or unparseable?), an unreadable `skills/` (no
skills, or no answer?), an unreadable `~/.claude/skills` (empty, or not allowed to
look?), and a `fleet-` entry that isn't a symlink (stale, or someone's own work?). Every
one defaulted to the destructive reading, and every one is silent. If you add a branch
here, the question to ask is which of the two things a null means.

### Known and accepted

- **The `pending` count can stick above zero.** It gates on `hooksSeen` (permanent) while
  the reload gates on `settledIdle` (which needs `instrumented`, a 30-minute freshness
  window). A session that fired hooks once and then went silent forever - hooks
  uninstalled mid-session, an agent wedged without exiting - is counted and never
  reloaded. The alternative is worse: gating the count on `instrumented` makes it blink
  to zero for a session that is merely quiet, which is the single most common state in
  this fleet, and a zero that means "nobody needs this" when twenty sessions do is a
  worse lie than an N that lingers.
- **The pane lock makes every write refusable.** `sendText`/`injectPrompt` can now answer
  PANE_BUSY, and existing callers read any failure as a real one - `dispatcher.ts` fails
  a whole task on it. The contention window is a real autonomous writer against a real
  pane, so the refusal is correct (an interleaved paste is worse), and it is very narrow:
  a freshly dispatched session has `startedAt >= generationAt`, so the reload loop never
  targets it.

### Verified live (claude 2.1.211, real tmux pane, real `~/.claude/skills`)

Through the production path (`applySkillsConfig` -> `reconcileSkillLinks`), against a
session already at its prompt:

```
❯ /reload-skills
  ⎿  Reloaded skills: 52 skills available (no changes)   ← before the symlink
# fleet-html-plans symlinked here, mid-session, no restart
❯ /reload-skills
  ⎿  Reloaded skills: 53 skills available (1 added)      ← picked up
```

- The skill presents in the slash menu as `/html-plans` from a `fleet-html-plans/`
  directory, with its own description. The prefix split holds.
- **But the MODEL's skill registry uses the DIRECTORY name** - it sees `fleet-html-plans`.
  Harmless (the description is what drives invocation, and it's untouched) but the prefix
  is not quite invisible, and anything matching on a model-facing skill name must expect it.
- The reconciler linked and later unlinked `fleet-html-plans` while five hand-authored
  skills - three of them symlinks - sat beside it untouched, byte for byte.
- **The gate was tested against two real dialogs, not a fixture.** A fresh claude opened on
  the "Quick safety check: Is this a project you created or one you trust?" list, and later
  the probe drove itself onto a genuine permission dialog sitting on `❯ 1. Yes`. The pane
  read returned null - i.e. refused - for both. That is the unattended-approval failure the
  whole design exists to prevent, declined against the real thing.
