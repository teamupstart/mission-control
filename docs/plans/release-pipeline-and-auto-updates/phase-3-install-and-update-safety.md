# Phase 3 - Close the install and update-safety gaps

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

A person who clones the repository can find the install path, is told what they need before the
build fails, and cannot be left with no application at all by an update that hangs or by a lapsed
credential they were never told about.

This is the largest phase by diff and the only one that touches application code. It is
**independent of Phases 1 and 2** and may run concurrently with them.

## Entry criteria and dependencies

- **Direct phase dependencies:** none. Runs concurrently with Phase 1 and Phase 2.
- Touches no release infrastructure, so it cannot conflict with either.

## Scope

G5 (README install path), G6 (Xcode Command Line Tools preflight), G8 (update timeout and rollback
retention), and G9 (`gh` auth and rate limiting). G10 is answered by Phase 4, not here.

**Non-goals:**

- Any change under `.github/`, `release-please-config.json`, or
  `scripts/assert-release-version.mjs`. Phases 1 and 2 own those.
- Progress reporting during an update. The parent process is dead by then, so real progress needs a
  new surface, and that is a bigger design question than this phase should absorb.

## Repository findings

### G6 - the preflight idiom already exists

`scripts/install-app.mjs:412-435` is a uniform sequence: each check is a pure
`*PrerequisiteMessage(...)` predicate exported from `scripts/init-prerequisites.mjs`, returning
`null` or a message; the script gets the observable fact via `capture(...)`, passes booleans in,
and `fail()`s on a message. Follow it exactly; do not invent a second shape.

The predicates live in `scripts/init-prerequisites.mjs` and are tested in
`test/init-prerequisites.test.ts` - **that is where a CLT predicate and its test belong**, not in
`test/install-app.test.ts`, which covers no prerequisite logic at all.

`init-prerequisites.mjs:33` already mentions `xcode-select --install`, but only inside
`gitPrerequisiteMessage`, reached when `git --version` fails. **That is not the failure mode that
matters** - git is commonly present via Homebrew with no CLT at all.

The real failure: all of step 1 passes, the clone and checkout succeed, and the run dies in step 6
at `install-app.mjs:503` (`npm run package`) → `build-keep-awake-native.mjs:28-32`
(`node-gyp rebuild`). node-gyp prints its own text (`gyp: No Xcode or CLT version detected!`)
through `stdio: "inherit"`, and `install-app.mjs`'s `run()` wrapper reports only:

```
✗ `npm run package` failed: Command failed: npm run package
```

There is no CLT-specific message anywhere in the repository.

`scripts/init.mjs` checks only Node (`:72-76`) and, under `--with-e2e`, Chromium. It also runs
`npm run build` (`:96-102`) and hits the same wall - but through a `run()` that **warns rather than
fails** (`init.mjs:55-67`), so `make init` reports a warning and continues. Consider whether the
new check belongs there too.

### G8 - the timeout seam and the retention bug

`install()` (`scripts/apply-update.mjs:137-140`) calls `spawnSync` with
`{ encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }` and **no `timeout`**. Node's `spawnSync`
accepts `timeout` and `killSignal`; on expiry it returns `result.error` with `code: "ETIMEDOUT"`,
and the existing `if (result.error) throw result.error;` at `:143` already routes that into the
failure path. The raw message would be unhelpful, so give `ETIMEDOUT` its own explicit message.

Note `waitForParent` already has an independent timeout (`PARENT_EXIT_TIMEOUT_MS`, `:21`) with the
message `"the app did not quit before the update timeout"`. Do not conflate the two; a build that
hangs and an app that will not quit are different failures and should read differently.

**The retention bug is worse than the source plan described.** `runApplyUpdate`'s
`finally { ops.remove(tempDirectory); }` (`:214`) removes the temp directory - and with it
`previous-app.bundle` - on **every** exit path, success and failure alike. `restoreBundle` also
deletes its `.failed-<pid>` sibling (`:92`), so the broken new bundle is not retained either. After
a failed update there is nothing left to inspect and nothing left to roll back to a second time.

**Testing constraint.** `ops` is the injection seam (`:160`), and `test/apply-update.test.ts:20-45`
supplies `install` as a plain `(node, script, tag)` function. A timeout added *inside*
`realApplyOperations.install` is therefore **invisible to those tests**. Surface it through the
seam - an explicit `installTimeoutMs`, or assert directly on `realApplyOperations()`, which is
exported at `:106`.

### G9 - where an auth state can live

`ghFailure` (`src/main/updater.ts:132-141`) classifies three cases and marks every `UpdateError`
`retryable = true`. There is no `HTTP 403` or rate-limit branch, so a rate-limited `gh` falls
through to `"GitHub CLI cannot list releases here (exit N). Try again."`. The auth regex
(`/auth|login|credential|HTTP 401/i`) is also broad enough to catch unrelated messages containing
"login".

The silent failure is `updater.ts:471-473`: a background check that fails returns to `idle`
**unconditionally**. Only a manual check ever reaches `phase: "error"`. So lapsed auth is invisible
by construction.

Two viable seams:

1. **Reuse `phase: "error"` and make the background suppression conditional.** Add a `kind` to
   `UpdateError` (which currently carries only `message` and `retryable`, `:122-126`), thread it
   through `safeUpdateError`, and let a persistent, user-actionable class such as auth surface even
   from a background check while transient network failures stay quiet. Smaller blast radius.
2. **Add an eighth phase** to `UPDATE_PHASES` (`src/shared/update.ts:4-12`) and a new
   `UpdateSnapshot` member. This forces renderer work: `test/update-desktop-contract.test.ts:35`
   and `test/update-banner.test.ts:35` both pin phase coverage, and `e2e/specs/update-banner.spec.ts`
   imports `UpdateSnapshot` directly.

**Recommendation: seam 1.** It reuses an existing rendered state, and the distinction being drawn
is genuinely about whether a failure is worth interrupting someone over - which is what `retryable`
already gestures at.

Also worth noting: `latestStableRelease` makes **two** `gh` calls per check (`releaseList` then
`releaseView`), which doubles the rate-limit budget. And `gh` is never checked at startup, only
lazily at check time - `start()`'s five `disabled` reasons (`:355-387`) do not include it.

### G5 - README placement

`README.md` is 233 lines; Quick start is `:204-216` and covers only the dev-server path
(`make init` && `npm run dev`). Line 216 says "use the setup guide below", but the next section
(`:218 ## Go deeper`) is a link list. The install path (`make install`) appears nowhere in the
README.

Top-level headings: `:9` See the fleet, `:37` Dispatch with context, `:110` Build the operating
system around the work, `:122` Design reusable review workflows, `:135` Coordinate the fleet,
`:144` Report a public product issue through an agent, `:159` Watch a pipeline engine you already
use, `:204` Quick start, `:218` Go deeper, `:225` Regenerate screenshots.

Place the install content as a subsection of Quick start, or as a new `##` between `:216` and
`:218`. Keep the dev-server path - both audiences are real. Make the *distinction* explicit, since
that is the thing a reader currently cannot discover: `npm run dev` is for working on Mission
Control, `make install` is for using it and is the only path that receives updates.

## Implementation steps

Order them G6 → G5 → G8 → G9; the first two are small and independent, the last two are the real
work.

1. **G6.** Add a CLT predicate to `scripts/init-prerequisites.mjs` in the existing idiom, detect
   the fact in `scripts/install-app.mjs`'s step 1 via `capture("xcode-select", ["-p"])` or
   equivalent, and add a case to `test/init-prerequisites.test.ts`. Decide whether `scripts/init.mjs`
   should also check it. Add CLT to the documented prerequisites in `docs/overview.md:174`.
2. **G5.** Add the README install section.
3. **G8.** Add a timeout to `install()`, surfaced through the `ops` seam so it is testable; give
   `ETIMEDOUT` a distinct message; and retain `previous-app.bundle` past a failure - move it
   somewhere durable under the state directory, or make the `finally` conditional on success.
   Decide and document the retention lifetime; do not leave a bundle behind forever.
4. **G9.** Classify auth and rate-limit failures distinctly in `ghFailure`, thread the class
   through `UpdateError` and `safeUpdateError`, and make the background suppression at `:471-473`
   conditional so a persistent auth failure becomes visible without making transient network blips
   noisy.

## Verification

- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- New unit tests: a CLT prerequisite case in `test/init-prerequisites.test.ts`; timeout and
  backup-retention cases in `test/apply-update.test.ts`; auth-visible-from-background and
  rate-limit-classification cases in `test/updater.test.ts`.
- **If G9's chosen seam changes what the banner renders, a Playwright spec is required** - the
  repository's rule admits no exemptions for UI changes. `e2e/specs/update-banner.spec.ts` already
  exists and stubs the bridge with a fixed snapshot; extend it rather than adding a second spec.
  If the change is invisible to the renderer, say so explicitly in the pull request.
- G6 is best confirmed by observing the new message on a machine without CLT. If that is not
  available, the predicate's unit test plus a manual forced-failure is the honest bar - say which
  was done.

## Merge and exit criteria

1. A missing Xcode CLT fails at install-time step 1 with a message naming `xcode-select --install`,
   not at step 6 with `Command failed: npm run package`.
2. `README.md` documents `make install` and distinguishes it from the dev-server path.
3. A hung build is bounded by a timeout with its own message, and the previous bundle survives a
   failed update.
4. A lapsed `gh` credential becomes visible without a manual check; rate limiting reads as rate
   limiting.
5. Full gate green, with a Playwright spec if the renderer changed.

## Downstream handoff

Phase 4 relies on the improved failure messages when it runs the journey for real, and should
verify these paths deliberately rather than assuming them. Nothing here changes the update
protocol, the receipt schema, or the release query.

## Cross-phase audit record

- **vs Phase 1:** disjoint by construction. Phase 1 fixes G7 in `scripts/assert-release-version.mjs`
  specifically to avoid `src/shared/update.ts`, which this phase may touch for G9's `UpdateError`
  and snapshot types. **If Phase 1's reverse-divergence cleanup needs `src/shared/update.ts`,
  coordinate** - whichever merges second rebases.
- **vs Phase 2:** fully disjoint. No shared files. May merge in either order.
- **vs Phase 4:** Phase 4 depends on this phase, so that the real end-to-end run exercises the
  hardened paths rather than re-discovering the gaps this phase closes.
- **Correction fed back to `plan.md`:** the source plan's G10 claimed `e2e/` had no update spec.
  `e2e/specs/update-banner.spec.ts` exists. `plan.md` has been corrected, and the G8 description
  was also sharpened - the temp directory is removed on every exit path, not only on success.
