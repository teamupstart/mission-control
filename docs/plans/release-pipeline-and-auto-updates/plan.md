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
- On success the helper deletes its temp dir including `previous-app.bundle`
  (`scripts/apply-update.mjs:214`), so once the install returns 0 there is no rollback material
  left even if the new app crashes on launch. Success is judged by `open`'s exit code, which does
  not mean the app stayed up.

### G9. `gh` is a hard runtime dependency with a silent failure mode

The install verifies `gh auth status`, but nothing keeps that true afterwards. Expired auth
degrades every background check to a quiet `idle` (`src/main/updater.ts:472-474`). A user whose
`gh` token lapsed silently stops receiving updates. Secondary rate limits (HTTP 403) are also not
special-cased and surface as a generic "cannot list releases here (exit N)".

### G10. No end-to-end coverage of the update surface

Nine unit test files cover the controller, the helper, and the banner - all against injected
ports. `runGh`, the real detached spawn, and the actual `git`/`npm ci`/`npm run package` build are
never exercised. `e2e/` has no update spec, which is consistent with the feature being
Electron-preload gated and invisible to the browser dashboard, but it does mean nothing tests the
seam that has never run in production.

## Part 3 - proposed work

The four open choices below were resolved in the dashboard review on 2026-08-21 and are recorded
under [Decisions](#decisions-resolved). The phases reflect what was chosen; the alternatives that
were not taken have been removed rather than left to re-litigate.

### Phase A - cut the first release (unblocks everything)

Nothing else in this plan can be verified until a release exists.

1. **Give Release Please a credential that is allowed to open a pull request** (D1). A fine-grained
   PAT or a GitHub App installation token, stored as a repository secret and passed to the action
   as `token:`. This sidesteps the organization policy rather than negotiating with it, and it does
   not depend on an org admin being available.
2. **Set the first release to `1.0.0`** (D4). Release Please computed `0.2.0` from the minority of
   commits it could parse, which is not a number anyone should have to defend. This needs
   `"release-as": "1.0.0"` in `release-please-config.json` for the first run only, and it must be
   removed immediately afterwards or every subsequent release is pinned to the same version.
3. Confirm the release pull request opens, review the generated `CHANGELOG.md`, and merge it.
4. Confirm the follow-up run creates the `v1.0.0` tag and publishes the Release, and that
   `scripts/assert-release-version.mjs` passes against it.
5. **Fix G7 in the same change** so `scripts/assert-release-version.mjs` and `src/shared/update.ts`
   agree on what a version is. Today a `-rc.1` tag passes the CI assertion and is then permanently
   invisible to the updater.

One consequence worth planning for: a PAT-pushed tag **does** start workflow runs, unlike the
`GITHUB_TOKEN`-pushed tag today. `ci.yml`'s `package` job is gated on `refs/tags/*` and will now
fire on every release. That is harmless - it builds a dmg and uploads it as a 90-day artifact
nobody has to consume - but it is a behaviour change, and `release.yml`'s header comment explicitly
documents the old assumption. Both the comment and the `package` job's gating need revisiting in
this phase: either let it run as a build check, or exclude release tags from it.

### Phase B - prove the user journey end to end

Only possible once Phase A has published a release. This is the "make sure that works" the task
asked for; it cannot be done by reading code, which is why it is its own phase.

1. On a clean machine state, run `make install` and confirm it selects the published `v1.0.0` tag
   rather than the default branch tip, and that the receipt records that tag.
2. Cut a second release.
3. Confirm the installed app surfaces the update banner, and that **Update Now** rebuilds, swaps,
   and relaunches at the new version.
4. Confirm the negative path: force a build failure and verify the previous app **and** its receipt
   are both restored, and the restored app relaunches.

### Phase C - generate the changelog from pull request titles and labels

D2. Conventional-commit parsing is the wrong tool for this repository's history - it reads 40 of
the last 245 commits and discards the 185 descriptive titles that are the actual product changes.
Generating from pull request titles and labels matches how history is already written, and it works
retroactively rather than only going forward.

1. Replace the commit-message changelog source with a pull-request-derived one - GitHub's own
   release-notes generator via `.github/release.yml`, or `git-cliff` configured against the GitHub
   API. Keep Release Please as the thing that owns the version, tag, and Release if it can be fed
   this way; otherwise this phase absorbs the tagging too.
2. **Close G3: disable merge commits on the repository**, leaving squash-only. A merge commit
   discards the pull request title into `Merge pull request #N from <branch>`, which carries nothing
   either generator can use. This is the setting that makes the rest of the phase hold.
3. Adopt a small, enforced label vocabulary for the sections the changelog groups by.

### Phase D - close the install and update-safety gaps

1. **G5** - give `README.md` a real install section pointing at `make install`, alongside the
   existing dev quick start. A cloner following the README today lands in dev mode and never meets
   the updater at all.
2. **G6** - add Xcode Command Line Tools to the documented prerequisites, and make
   `scripts/install-app.mjs` check for it up front, so a missing toolchain fails at install time
   with a clear message rather than mid-update with no UI on screen.
3. **G8** - put a timeout on `install()` in `scripts/apply-update.mjs`, and keep
   `previous-app.bundle` until the relaunched app has been observed alive, rather than deleting it
   the moment the install returns 0.
4. **G9** - re-check `gh auth status` on the update path and surface lapsed auth as an actionable
   state rather than silence; special-case HTTP 403 rate limiting instead of reporting it as a
   generic non-zero exit.
5. **G10** - decide whether any of this warrants an e2e spec given the Electron-preload gating, or
   whether Phase B's manual verification is the honest coverage boundary.

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

### A note on how this review was answered

The review was submitted 1h52m after it was requested. The `request_plan_decisions` MCP call has a
30-minute idle timeout, so it had already aborted; the answers were persisted correctly in the
`reviews` table but were never delivered back to the waiting session, which had to recover them by
reading the database directly. Plan reviews are inherently human-paced and routinely take longer
than thirty minutes. This is worth fixing independently of this plan.
