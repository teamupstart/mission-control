# Phase 5: install the extension into Pi's home

Part of [Pi parity](plan.md) - see [phased-plan.md](phased-plan.md) for the graph.

## Outcome

Phase 4's artifact reaches the operator's real Pi install, machine-wide, so a Pi session someone
starts themselves loads it without being launched through Mission Control. This is the phase
that makes "hand-run" true rather than demonstrable.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 4.** This installs its artifact.
- Nothing runs concurrently with it: Phase 6 inspects what this installs.

## Scope

0. `HARNESS_CAPABILITIES.pi.workQueue.uninstrumentedWhy` rewritten as an **actionable** sentence.
   This is the earliest phase that may, because it is the first one whose merge gives an
   operator something to turn on. Phases 1 and 4 deliberately keep it a statement of fact - see
   Phase 1's handoff.
1. An `ExtensionsSpec` capability - `dirEnvVar`, `homeDir`, `isolatedDirName`, `linkName` - non-
   null for Pi only.
2. A reconciler that creates and removes exactly one symlink, reusing
   `src/server/skills/reconcile.ts`'s rules and its isolation guard.
3. The daemon reconciling on startup, and the config that records the operator's intent.
4. Uninstall, wired the way `hooks/install.mjs` wires the skill-link teardown.

### Non-goals

- The Setup row and the install button. Phase 6.
- Detecting staleness. Phase 6. This phase creates a correct link; it does not report on a
  link that has gone bad.
- `pi install` and the `settings.json` `extensions` array. Both were considered and rejected in
  the approved decisions.

## Repository findings

### Pi's discovery accepts a symlink, and the link's NAME decides

`discoverExtensionsInDir`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:568`) handles
`entry.isSymbolicLink()` explicitly for both files and directories, and `isExtensionFile` (line
527) tests the **entry name** for `.ts` or `.js`. Measured, both in one directory:

```
lrwxr-xr-x  mission-control.js -> /tmp/pi-probe/built/index.mjs
-rw-r--r--  plain.mjs
-> loaded: built/index.mjs via file:///tmp/pi-probe/disco/extensions/mission-control.js
```

One load line, from the symlink. The `.mjs` was not discovered. So the link is named
`mission-control.js` regardless of the target's extension, and `linkName` belongs on the spec
rather than being composed at the call site.

Discovery is one level deep with no recursion, so a single file link is the right shape - not a
directory.

### The isolation rule is not optional, and it exists because of real data loss

`skillsDirFor` (`src/server/skills/reconcile.ts:61`) resolves `dirEnvVar` first, then a directory
under an explicit `MISSION_HOME`, then the operator's real home. Its comment records what the
rule prevents: an isolated test daemon reconciled the real install's symlinks against its own
empty config, decided every one was unwanted, and unlinked them - observed removing the live
install's `mission-html-plans`, silently, on a `startup` that runs on every launch.

`npm test` and the E2E harness both start daemons routinely, so **this is not a hypothetical for
this repository**. Reuse `skillsDirFor`'s exact resolution order. Do not write a second one.

`assertTestSkillIsolation` and `operatorSkillsDirs` (same file) are the guard that compares a
walk target against the operator's live directories through `realpathSync`, because "a trailing
slash, a `..` segment, `TMPDIR` on macOS living under `/var -> /private/var`, or a fixture that
symlinks a scratch path at a real one" each defeated a string comparison - "verified, both
shapes, before this existed". The extension link needs the same guard, over the same paths.

### Never a copy, and never a real file

The skills reconciler's rule is "only ever our own symlinks, never a real directory". The
extension link needs the identical discipline: if `~/.pi/agent/extensions/mission-control.js`
exists and is **not** a symlink we recognise, leave it alone and report - it is somebody else's
file, and an operator may have written their own extension under that name.

Symlinks over copies for the reason stated there: "a symlink has no drift: the file Claude reads
IS the file in the repo".

### Where the daemon reconciles, and what records intent

The skills path reconciles from config at startup, and the durable off-switch is the panel's
master switch because it persists `enabled: false` - `src/main/integrations.ts` explains why a
removal that is not persisted is worse than one that never claimed to happen ("this process
supervises the daemon, whose startup reconcile reads a config still saying `enabled: true` and
would put every link straight back").

The Pi extension needs the same: a persisted intent, or the install is undone on the next
daemon start. Decide where that lives - reusing the skills config's shape is likely right, but
verify rather than assume, because a second source of truth for "is the integration on" is
exactly what the repository forbids.

### Uninstall belongs to `hooks/install.mjs` too

`hooks/install.mjs --uninstall` already clears skill links "as TEARDOWN, not as the off-switch",
delegating to `uninstallSkillLinks` so the symlink rule keeps one implementation, and reporting
on both exits because "whether settings.json still holds a hook of ours says nothing about
whether the skills directory holds a link of ours". Add the extension link to that teardown for
the same reason: a checkout being abandoned should not leave a link pointing into it - and here
the consequence is worse than a stale skill, because a dangling extension link is silent and a
broken one stops every Pi session.

## Implementation steps

### 1. `src/shared/harness-capabilities.ts`

```ts
/**
 * Installing a Mission Control EXTENSION into this harness's own config, machine-wide.
 *
 * Null for a harness with no such loader, which is Claude and Codex: both extend through
 * MCP, so our tools reach them by registration rather than by a file in their home. Only
 * Pi loads in-process TypeScript from a directory it owns.
 *
 * Deliberately shaped like `SkillsSpec`, because the reconciler is the same reconciler and
 * the isolation rule is the same rule - the one that exists because an isolated daemon once
 * unlinked the live install's skills.
 */
export interface ExtensionsSpec {
  dirEnvVar: string;
  homeDir: readonly string[];
  isolatedDirName: string;
  /**
   * The single link name, which must end in `.js`.
   *
   * On the spec rather than composed at the call site because Pi's discovery tests the
   * ENTRY NAME, not the target: measured, a `.js`-named symlink to a built `.mjs` loads and
   * a `.mjs` in the same directory is not discovered at all.
   */
  linkName: string;
}
```

Pi: `{ dirEnvVar: "PI_EXTENSIONS_DIR", homeDir: [".pi","agent","extensions"], isolatedDirName: "pi-extensions", linkName: "mission-control.js" }`.

Add `extensions: ExtensionsSpec | null` to `HarnessCapabilitiesBase` with a `withCapabilityNull`
fixture, per `harness-capabilities.test.ts`'s discipline - Claude and Codex are real null
declarers here, so it stays **off** `BY_FIXTURE`.

### 2. `src/server/skills/reconcile.ts` (or a sibling that reuses it)

Prefer extending the existing module over a new one, so `skillsDirFor`'s resolution and
`assertTestSkillIsolation`'s guard are literally the same code. Add:

- `extensionsDirFor(spec)` - or generalise `skillsDirFor` over both spec shapes, whichever
  leaves one implementation of the resolution order.
- `extensionsDirs()` - the `skillsDirs()` analogue, folding over every harness declaring
  `extensions`, de-duplicated for the reason `skillsDirs` gives.
- `reconcileExtensionLink(desired: boolean)` - create or remove exactly one link, refusing to
  touch anything that is not a symlink of ours, and returning the same `ReconcileResult` shape
  so problems are reported rather than swallowed.
- `uninstallExtensionLink()` for teardown.

Extend `operatorSkillsDirs`'s live-path list to cover the extensions directory, so the isolation
guard protects it too.

### 3. Daemon startup

Reconcile beside the skills reconcile, from the persisted intent. Report what changed the way
the skills pass does.

### 4. `hooks/install.mjs`

Add the extension link to `--uninstall`'s teardown and to `reportSkills`'s output (rename it if
it now reports two kinds of link). Never create the link on install, for the reason that file
gives about skills: "the daemon reconciles from the config, and creating links from here would
enable skills nobody switched on".

### 5. `src/shared/harness-capabilities.ts` - make the refusal actionable at last

`uninstrumentedWhy` has been a statement of fact since Phase 1, because until this phase there
was nothing an operator could do about it. Once this merges there is: the persisted intent that
turns the integration on. Rewrite it to name that, and keep it accurate about *where* - Phase 6
adds the Setup row, so until then the name to give is whatever surface this phase actually
exposes, not the row that does not exist yet.

If this phase's only switch is a config write with no UI, say so plainly rather than inventing
a control. The rule the whole chain follows: never point an operator at something your own merge
does not deliver.

### 6. Tests

- `extensionsDirFor` honours `PI_EXTENSIONS_DIR`, then `MISSION_HOME`, then the real home - the
  same three cases `skillsDirFor` is tested for.
- **The isolation regression, explicitly:** a daemon on an explicit `MISSION_HOME` does not
  touch the operator's real `~/.pi/agent/extensions`. Assert on the real directory being
  unchanged, including through a symlinked scratch path and a `..` segment, which are the two
  shapes recorded as having defeated the string comparison.
- An existing non-symlink at the link path is left alone and reported.
- A link pointing at a different target is repointed, idempotently, and re-running changes
  nothing.
- Uninstall removes our link and only ours.
- The link's name ends in `.js` - a one-line assertion that pins the measured discovery rule, so
  a future rename cannot silently make the extension undiscoverable.

## Data and compatibility

The persisted intent is the only new stored state. If the skills config's shape is reused, no
migration is needed; if a new key is added, it goes next to its upgrade path per the repository's
migration rule.

Upgrading a machine that has never installed this writes nothing until the operator asks.

## Verification

```sh
npm run typecheck && npm run lint && npm test
```

Plus, on a real machine, in this order:

1. With the integration off, `~/.pi/agent/extensions/` contains no link of ours.
2. Turn it on; the link appears; a **freshly started** hand-run `pi` loads it and the card
   reports state.
3. Start a second daemon on an explicit `MISSION_HOME`; the real link is **still there**. This is
   the data-loss regression and it is the check that matters most in this phase.
4. Turn it off; the link goes; a fresh `pi` no longer reports.
5. `npm run install-hooks --uninstall` from the checkout removes the link.

## Merge and exit criteria

- A hand-run Pi session on the operator's machine loads the extension with no `-e`.
- An isolated daemon cannot touch the real install, proven by test and by step 3 above.
- A file that is not ours at the link path is never modified.
- Turning the integration off is durable across a daemon restart.

## Downstream handoff

Phase 6 may rely on:

- `uninstrumentedWhy` being actionable from this phase onward. Phase 6 refines it to name the
  Setup row once that row exists.
- `capabilitiesFor("pi").extensions` and the resolver, to find the same directory the installer
  wrote to. **Phase 6 must resolve through the capability, not by rebuilding the path**, or the
  check and the installer will disagree on a machine with `PI_EXTENSIONS_DIR` set - which is
  precisely how a check reports a healthy install that is not the one being loaded.
- Exactly one link, at `linkName`.

Phase 6 must not repair the link. That is the approved report-only decision, and
`claude-hooks.ts`'s reason applies with more force here.

## Cross-phase audit record

- After Phase 4: consistent. Phase 4 produces the artifact, this installs it, and neither
  relocates the other's path - both go through `piExtensionPath()`.
- **Reconciliation with Phase 4:** the `.js` link name is a constraint on both. Phase 4's build
  emits `.js` and this phase's link is named `.js`; either alone would work while the pair is
  what Pi's discovery actually requires. Pinned by a test in both phases so neither can be
  changed alone.
- **Noted for Phase 6:** the capability-resolution requirement above was going to be an
  assumption there. Stated here as a handoff instead, because this phase owns the resolver.
- **Review correction (r2).** This phase acquired ownership of the `uninstrumentedWhy` rewrite.
  Phase 1 shipped that sentence naming an install, which nothing delivered until here, so an
  operator reading it in between was told to press a button that did not exist. Phases 1 and 4
  now keep it factual and this phase - the first whose merge provides a switch - makes it
  actionable.
- Reconfirmed against Phase 1: no interaction. Cost reads a transcript; this writes a link.
