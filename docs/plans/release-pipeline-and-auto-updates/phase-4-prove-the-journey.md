# Phase 4 - Prove the install-and-update journey against a real release

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

Someone has actually done it: cloned, installed, been offered a real update from a real GitHub
Release, accepted it, and watched the app come back at the new version. Plus the negative path -
a failed update leaves the previous app working.

This is the phase that answers the original request. Everything before it is machinery.

## Why this is a phase and not an exit criterion

Two reasons it cannot be folded into an earlier phase:

1. **It is gated on an event no agent controls.** It needs a published `v1.0.0`, which requires a
   human to merge the release pull request Phase 1 produces. That gate sits outside any pull
   request's lifecycle.
2. **It is the only test of the real seam.** Every existing layer is tested against a fixture -
   nine unit test files against injected ports, and `e2e/specs/update-banner.spec.ts` against a
   stubbed bridge with a hard-coded `available` snapshot. `runGh`, the detached spawn, and the
   real `git` / `npm ci` / `npm run package` build are exercised by nothing. Adding another fixture
   would not change that; running it for real is the only thing that does.

Its diff is genuinely unknown in advance, which is the honest reason it is last rather than a
checklist appended to Phase 3.

## Entry criteria and dependencies

- **Direct phase dependencies: Phase 1 and Phase 3.**
  - Phase 1, because a published stable Release must exist.
  - Phase 3, so the run exercises the hardened install and update paths rather than re-discovering
    the gaps that phase closes.
- **Not** dependent on Phase 2. How a release's notes are generated is irrelevant to whether the
  app can install and update itself.
- **External gate:** `gh release list --repo mancej-cyc/ai-harness --exclude-drafts
  --exclude-pre-releases` must return at least one release before this phase can begin.

## Scope

Running the journey end to end on real hardware, fixing what it breaks, and writing down the
procedure so the next release is verifiable without rediscovering it.

**Non-goals:**

- Redesigning the update mechanism. If the run reveals a design flaw rather than a bug, record it
  and raise it - do not absorb an unbounded redesign into a verification phase.
- Committing evidence. Screenshots, transcripts, and logs attach to the pull request and are
  produced in a gitignored location, per the repository's boundaries.

## Repository findings

- **A second release is needed to test an update**, since `isNewerVersion` is strictly-newer only
  (`src/shared/update.ts:63-73`). Verifying the update path requires `v1.0.0` **and** a successor.
  Plan for two releases, not one.
- **The updater is gated five ways** (`src/main/updater.ts:355-387`): packaged, arm64, managed
  receipt present, canonical repo, system Node available. A developer build installed via
  `make install-app` writes no receipt and is deliberately inert. **The verification must use
  `make install`**, not `make app` / `make install-app`, or it will prove nothing.
- **Timing is not instant.** The first check fires 30s + up to 60s jitter after launch, then every
  6h + up to 15m jitter (`updater.ts:28-31, 401-415`). Use **Check for Updates…** from the app menu
  or tray for the manual path rather than waiting on the background timer.
- **A background check that finds an update opens no dialog** - it only publishes the snapshot, so
  the banner is the sole background surface. The native dialog appears only on the manual path.
  Verify both.
- **`make install` needs roughly 1-2 GB** for `~/.mission-control/app-src` with its own
  `node_modules` and `release/` output.
- **There is no release runbook.** `docs/runbooks/` holds only `keep-awake.md` and
  `recurring-missions-standby.md`.

## Implementation steps

1. **Install from the published release.** Run `make install`. Confirm it selects the `v1.0.0` tag
   rather than the default branch tip, and that `~/.mission-control/install-receipt.json` records
   that tag, the canonical repo, and a matching `installedVersion`.
2. **Confirm the app reports itself current** against the release it was installed from.
3. **Publish a second release** through whatever path is live at the time.
4. **Verify the manual path:** **Check for Updates…** from the app menu and from the tray. Confirm
   the native dialog offers **Update Now** / **Later**, and that **Later** defers.
5. **Verify the background path:** confirm the banner appears without a dialog.
6. **Apply the update.** Confirm the app quits, rebuilds, swaps, and relaunches at the new version,
   and that the receipt is updated. Record how long it took - it is a full `npm ci` plus package,
   and the number belongs in the runbook.
7. **Verify the negative path.** Force a build failure in the updater-owned clone and confirm the
   previous app **and** its receipt are restored, the restored app relaunches, and the failure is
   reported on next launch from `update-outcome.json`. With Phase 3 merged, also confirm the
   previous bundle is retained.
8. **Verify the disabled paths** report accurately: a `make install-app` developer build (no
   receipt) and, if reachable, a missing system Node.
9. **Fix what breaks.** Bugs found here are in scope. A design flaw is recorded and raised.
10. **Write `docs/runbooks/release-verification.md`** - the procedure, the gates, the expected
    timings, and the failure signatures. Link it from `docs/desktop-and-packaging.md`.

## Verification

The evidence *is* the deliverable. For each numbered step, capture what actually happened -
terminal output, the receipt's contents before and after, screenshots of the banner and the native
dialog, the relevant lines from the rotating `update.log`. Attach to the pull request; never
commit.

If any step cannot be performed, **say so explicitly and say why**. A verification phase that
quietly skips its hardest step is worse than one that reports a gap, because it converts an unknown
into a false assurance - which is precisely the failure this whole plan exists to correct.

Standard gates (`npm run typecheck`, `npm run lint`, `npm test`) apply to any code this phase
changes, plus a Playwright spec if a fix touches a UI surface.

## Merge and exit criteria

1. A clean `make install` from the published release, with a correct receipt.
2. A real update offered, accepted, applied, and relaunched at the new version.
3. The negative path leaves the previous app working.
4. Both the manual and background surfaces verified.
5. Every finding either fixed in this phase or recorded as a raised issue.
6. `docs/runbooks/release-verification.md` exists and reflects what was actually done.
7. Evidence attached to the pull request; none committed.

## Downstream handoff

This phase closes the plan. The runbook it leaves behind is what makes the next release verifiable
without repeating this investigation.

## Cross-phase audit record

- **vs Phase 1:** depends on it for a published Release. Uses the exact `gh release list` query
  Phase 1's exit criteria confirm.
- **vs Phase 2:** independent. If Phase 2 has landed, step 3's release is cut through the new path;
  if not, through Release Please. Either satisfies this phase.
- **vs Phase 3:** depends on it, so the run exercises hardened paths. Step 7's retention check is
  meaningful only with Phase 3 merged - if the phases are somehow reordered, drop that assertion
  rather than reporting a false pass.
- **Coverage check:** with this phase, every gap G1-G10 is owned exactly once. G1/G7 → Phase 1;
  G2/G3 → Phase 2; G5/G6/G8/G9 → Phase 3; G10 → here; G4 → declined by D3 and explicitly not done.
