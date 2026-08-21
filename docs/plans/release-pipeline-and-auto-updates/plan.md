# Release pipeline and auto-updates

## What this plan is

You asked two things. First: confirm that a user can clone the repository, install the app, and
then be prompted to update from new GitHub Releases - and if not, say where it breaks. Second:
close whatever gaps remain in the release process itself, so that publishing a release from
GitHub (or from a local skill) tags, builds, and updates the changelog on its own.

The short answer to the first question is that the mechanism is built, thoroughly designed, and
covered by roughly sixty unit tests - and it has **never once been able to fire**, because no
GitHub Release has ever existed. The release workflow that would create one has failed on every
push to `main` since it landed, for a single reason that is a repository setting rather than a
code defect.

This plan states the audited path exactly, lists every gap found, and proposes the work to close
them.

## Part 1 - the audited path, as built

The design is not what "auto-update from GitHub Releases" usually means, and the difference
matters for everything below. **Nothing is ever downloaded.** No release asset, no dmg, no zip.

The installed app uses the release only for its **tag name**. It then rebuilds itself from source
at that tag, in a git clone that only the updater owns, and swaps the resulting `.app` bundle into
place.

```mermaid
flowchart LR
  U[User's Mac] -->|make install| S[scripts/install-app.mjs]
  S -->|gh release list --repo mancej-cyc/ai-harness| GH[(GitHub Releases)]
  S -->|git clone + checkout tag| C[~/.mission-control/app-src]
  C -->|npm ci + npm run package| B[release/mac-arm64/Mission Control.app]
  B -->|atomic swap| A[/Applications/Mission Control.app]
  S -->|writes| R[install-receipt.json]

  A -->|every 6h, via gh| GH
  A -->|newer tag| BAN[Update banner: Update Now / Later]
  BAN -->|detached system node| H[scripts/apply-update.mjs]
  H -->|--ref vX.Y.Z| S
```

### What is genuinely good here

These are verified, not assumed, and they should survive any change this plan makes.

- **The trust boundary is real.** Every `gh` call passes `--repo mancej-cyc/ai-harness`
  explicitly (`src/main/updater.ts:96-120`), because `gh` otherwise infers the repository from
  the working directory - so the same documented command run inside a fork would install
  fork-controlled code under the same tag name. The canonical slug is a single export
  (`src/shared/install-receipt-schema.mjs:22`).
- **Prereleases and drafts are excluded in the query, not after it**
  (`--exclude-drafts --exclude-pre-releases`), and re-asserted defensively on the result
  (`src/main/updater.ts:172-174`). Filtering after asking for "the latest" cannot recover.
- **A failed release lookup is not an empty release list.** "No stable release yet" falls back to
  the default branch tip; "GitHub could not be asked" stops the install
  (`scripts/install-app.mjs:190-194`).
- **Rollback is layered.** The helper backs up the bundle *and* the receipt, and restores both on
  any failure, then relaunches the restored app (`scripts/apply-update.mjs:77-104, 171-192`). The
  swap itself is copy-to-hidden-sibling then two same-directory renames
  (`scripts/install-app.mjs:284-329`), so a full disk leaves the previous app in place.
- **The updater is gated five ways** - packaged only, arm64 only, managed receipt present,
  canonical repo, system Node available (`src/main/updater.ts:355-388`) - so a developer's
  `make install-app` build is never mistaken for a managed install.
- **Gatekeeper is a non-issue by construction.** Because the bundle is built on the user's own
  machine and ad-hoc signed, nothing crosses a download boundary and no quarantine bit is ever
  set. There is no `xattr` or `spctl` workaround anywhere, and none is needed.

### Where it breaks

**It never starts.** `latestStableRelease` returns `null`, so every check - background and manual
alike - lands on `up-to-date` (`src/main/updater.ts:455-457`). The app truthfully reports "you
are up to date" forever. There is no error, no log line, and no symptom a user could report.

## Part 2 - the gaps

### G1. The release workflow fails on every push to `main` (blocker)

Verified against the live repository:

| Check | Result |
| --- | --- |
| `gh release list` | empty - zero releases, ever |
| `gh api repos/.../tags` | empty - zero tags, ever |
| Open release PR | none |
| `CHANGELOG.md` | does not exist |
| Last 5 `Release` workflow runs | **failure, failure, failure, failure, failure** |
| Commits waiting to be released | 245 |

The failure is identical every time, and it is the last line of the run:

```
release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

Release Please gets all the way through: it parses the history, computes the bump (`updating from
0.1.0 to 0.2.0`), builds the tree, creates the commit, and pushes the branch
`release-please--branches--main--components--mission-control`. Then it tries to open the pull
request and GitHub refuses.

This is the repository/organization Actions setting **"Allow GitHub Actions to create and approve
pull requests."** The repository reports `can_approve_pull_request_reviews: false`. The owner
`mancej-cyc` is an Organization, and this setting can be enforced org-wide, so it may need an org
admin rather than a repo admin - the current token has repo `admin: true` but is not an org admin,
so which level is authoritative here could not be read and must be confirmed at the point of fix.

Nothing in the repository can work around this. It is one toggle, or a different credential, or a
release design that does not need a pull request at all. Those are the options in D1 below.

### G2. Commit titles are not conventional commits, so the changelog would be near-empty

Even once G1 is unblocked, what Release Please produces would be poor. Of the last 245 commits on
`main`:

- **40** parse as conventional commits (`feat:`, `fix:`, `docs:`, …).
- **20** are raw merge commits (`Merge pull request #707 from …`), which Release Please logs as
  `commit could not be parsed` - these appear by the dozen in the failing run's log.
- The remaining **185** are prose titles: *"Make workflow test evidence first-class and
  auditable (#708)"*, *"Retire the Cards dashboard layout (#706)"*.

Those 185 are the actual product changes, and every one of them would be invisible in
`CHANGELOG.md` and would contribute nothing to the version bump. The first release would ship a
changelog describing about a sixth of the work, and the semantic version would be decided by an
unrepresentative sample. `release.yml`'s own header comment assumes "conventional-commit squash
titles", which is a description of a convention the repository does not currently follow.

### G3. Merge commits are enabled and in use

The repository allows squash, merge, and rebase. Both styles appear in recent history. A merge
commit discards the PR title into `Merge pull request #N from <branch>`, which carries no
information Release Please can use. Squash-only is the setting that makes G2's fix stick.

### G4. No Release ever carries a downloadable artifact

`ci.yml`'s `package` job builds the dmg, but:

- It runs on `startsWith(github.ref, 'refs/tags/')` or `workflow_dispatch`, and the release tag is
  pushed with `GITHUB_TOKEN` - **GitHub does not start workflow runs from that token**, so the job
  does not fire on a release. `release.yml:24-27` documents this as deliberate.
- When it does run, it uploads to `actions/upload-artifact`, which expires in 90 days and requires
  a logged-in GitHub session to download. It is **not** attached to the Release.

For the source-build updater this is correct and costs nothing - the dmg is genuinely not needed.
It only matters if you ever want a person to download and run the app without cloning, which is a
scope decision (D3), and one that pulls in Developer ID signing and notarization, since a
downloaded bundle *would* be quarantined.

### G5. The README never mentions the install path

Your stated user journey is "clone the repo and install the application". `README.md`'s **Quick
start** offers `git clone`, `make init`, `npm run dev` - the development server on
`127.0.0.1:5173`. It does not mention `make install`, the desktop app, or updates at all. The
managed install is documented well, but only in `docs/overview.md:168-218`, well down a long page.
A cloner following the README lands in dev mode and never encounters the updater.

### G6. Xcode Command Line Tools is an undocumented prerequisite

`npm run package` runs `scripts/build-keep-awake-native.mjs`, which shells out to `node-gyp
rebuild` for the Keep Awake native addon. That needs Xcode CLT. `docs/overview.md:174` lists the
prerequisites as `git`, an authenticated `gh`, and an Apple Silicon Mac. CLT is missing from that
list.

This is worse in the update path than the install path: the rebuild happens **after the app has
quit**, with no UI on screen, so a missing toolchain surfaces as a failed update rather than as a
failed install.

### G7. The two version parsers disagree about prereleases

`scripts/assert-release-version.mjs:22` accepts `v1.2.3-rc.1`. `src/shared/update.ts:58` rejects
anything that is not exactly `\d+\.\d+\.\d+`. A prerelease tag would therefore pass the CI
assertion and then be permanently invisible to the updater. This is latent today only because
prereleases are excluded by the `gh` query anyway, but it is a trap for anyone who later reaches
for an rc.

### G8. Applying an update is a long, silent, unbounded rebuild

Accepting an update quits the app and runs `npm ci` plus a full `npm run package` on the user's
machine. Meanwhile:

- There is no progress reporting beyond a static "Preparing to update" line - the parent process
  is already dead, so nothing *can* report.
- `install()` (`scripts/apply-update.mjs:136`) has **no timeout**. A hung `npm ci` leaves the user
  with no app running and no interface at all, indefinitely.
- The helper deletes its temp dir including `previous-app.bundle` in a `finally`
  (`scripts/apply-update.mjs:214`), so the rollback material is gone on **every** exit path -
  success and failure alike - and is unavailable even if the new app crashes on first launch.
  Success is judged by `open`'s exit code, which does not mean the app stayed up.

### G9. `gh` is a hard runtime dependency with a silent failure mode

The install verifies `gh auth status`, but nothing keeps that true afterwards. Expired auth
degrades every background check to a quiet `idle` (`src/main/updater.ts:472-474`). A user whose
`gh` token lapsed silently stops receiving updates. Secondary rate limits (HTTP 403) are also not
special-cased and surface as a generic "cannot list releases here (exit N)".

### G10. Nothing exercises the update surface against a real release

**Corrected during phase investigation.** An earlier draft of this plan said `e2e/` had no update
spec. It does: `e2e/specs/update-banner.spec.ts` covers the banner flow. The gap is narrower and
different from what was first written.

Nine unit test files cover the controller, the helper, and the banner, all against injected ports,
and the e2e spec stubs the entire desktop bridge with a fixed `available` snapshot. So every layer
is tested against a fixture, and **no layer is tested against reality**: `runGh`, the real detached
spawn, and the actual `git` / `npm ci` / `npm run package` build are never exercised, and there is
no e2e coverage of `install-app.mjs` or `apply-update.mjs` at all.

That is defensible for a feature gated behind Electron, a managed receipt, and a live GitHub
Release - but it means the seam that has never run in production is also the seam nothing tests.
Phase 4 exists to close that by running it for real, not by adding another fixture.

## Part 3 - proposed work

**The definitive roadmap is [`phased-plan.md`](phased-plan.md)** (rendered:
[`phased-plan.html`](phased-plan.html)), with one file per phase beside it. That index owns the
phase boundaries, the dependency graph, the sizing rationale, and the cross-phase contracts, and it
is what the scheduled implementation tasks point at.

An earlier draft of this section carried a provisional A-D roadmap. It has been replaced rather
than kept alongside, because it had drifted into contradicting the real one in three ways that
would have misled anyone following it: it still asked Phase C to choose between changelog
alternatives that decision C1 has since settled, still asked Phase D to decide whether G10 warrants
an e2e spec, and ordered the real-journey verification *before* the update-safety work when the
actual graph makes verification depend on it.

The four phases:

| # | Phase | Depends on | Owns |
| --- | --- | --- | --- |
| **1** | [Unblock the release trigger and cut v1.0.0](phase-1-cut-the-first-release.md) | - | G1, G7, D1, D4 |
| **2** | [Generate the changelog from pull request titles and labels](phase-2-changelog-from-pull-requests.md) | 1 | G2, G3, D2, C1 |
| **3** | [Close the install and update-safety gaps](phase-3-install-and-update-safety.md) | - | G5, G6, G8, G9 |
| **4** | [Prove the journey against a real release](phase-4-prove-the-journey.md) | 1, 3 | G10 |

**Phases 1 and 3 are concurrent** - they share no files. Phase 2 follows Phase 1 because both edit
`.github/workflows/release.yml` and because a changelog redesign should be built against a release
cycle that has actually run. **Phase 4 depends on Phase 3**, so the one real end-to-end run
exercises the hardened install and update paths rather than rediscovering the gaps Phase 3 closes;
it is additionally gated on a human merging the release pull request Phase 1 produces, which is why
it cannot be an exit criterion of an earlier phase.

Two things settled since the review, both recorded in full in the phase files:

- **C1 - what owns the version, tag, and Release.** Removing conventional commits as the changelog
  source also removed the semver bump driver, which this plan did not anticipate. Resolved as
  **C1-b**: a `workflow_dispatch` release where the human picks the bump and the workflow generates
  notes from pull request titles and label categories. It replaces Release Please. The D1 token
  remains in use, because it is what makes a release tag trigger `ci.yml`.
- **G10** is answered by running the journey for real in Phase 4, not by adding another fixture.

### Not doing: artifact distribution

D3. Releases will **not** carry a downloadable dmg. The source-build updater does not need one, and
adding it would pull in a paid Apple Developer ID plus notarization - without which a downloaded
bundle is quarantined and the current "it just opens" property is lost. G4 is therefore accepted
rather than fixed, and the dmg the `package` job builds stays a CI artifact.

## Decisions (resolved)

Resolved in the dashboard plan review on 2026-08-21.

| | Decision | Chosen | Why |
| --- | --- | --- | --- |
| **D1** | How to unblock the release trigger (G1) | **PAT or GitHub App token for Release Please** | Bypasses the organization policy outright instead of depending on an org admin, and does not recur for future repositories. Side effect: its tag push starts workflows, so `ci.yml`'s `package` job begins firing on release tags. |
| **D2** | What the changelog is generated from (G2) | **Pull request titles and labels** | Matches how this repository actually writes history. Conventional-commit parsing sees 40 of 245 commits and would ship a changelog describing a sixth of the work. |
| **D3** | Whether Releases carry a downloadable dmg (G4) | **No - source-build updater only** | The updater does not need an asset, and avoiding it avoids Developer ID signing and notarization entirely. |
| **D4** | The first release number | **v1.0.0** | 1286 commits and a shipping product. Release Please's computed `0.2.0` derives from an unrepresentative minority of parseable commits. Far easier to choose now than later. |

Those are the decisions as taken, with the reasoning that applied at the time. One has since been
partly overtaken: **D1's premise weakened when C1 resolved as C1-b.** With no release pull request,
the organization policy it was chosen to bypass stops applying. The token is still wanted and still
in use - it is what makes a release tag trigger `ci.yml` - so D1's work stands and Phase 1 needed no
revision, but its original justification no longer carries Phase 2. See
[`phased-plan.md`](phased-plan.md) for the full record.

### A note on how this review was answered

The review was submitted 1h52m after it was requested. The `request_plan_decisions` MCP call has a
30-minute idle timeout, so it had already aborted; the answers were persisted correctly in the
`reviews` table but were never delivered back to the waiting session, which had to recover them by
reading the database directly. Plan reviews are inherently human-paced and routinely take longer
than thirty minutes. This is worth fixing independently of this plan.
