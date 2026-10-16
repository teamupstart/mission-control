# Signed binary distribution

## Qualification status

The producer, publisher and workflow are implemented, but **Phase 2 has not met its release
exit gate**. The operator-approved Developer ID team `S2FPCQK39Z` is pinned in
[`binary-publisher-policy.mjs`](../src/shared/binary-publisher-policy.mjs). The approval was
recovered from the task's saved human answer on 2026-10-15 after the original tool call had
timed out. Neither an environment variable nor a downloaded manifest can supply this trust root.

At implementation handoff on 2026-10-14, the local keychain reported zero code-signing
identities. Canonical repository secret/variable names showed the Release Please App owner
but no Apple signing/notarization configuration. The only GitHub environments were
`copilot` and `github-pages`. No controlled publication, signed-runtime qualification,
notarization submission, or clean-account Gatekeeper launch was performed. There is no
real binary manifest to give to Phases 3 or 4 yet. Local fixture results cannot establish
Apple identity, GitHub write permission, or Gatekeeper acceptance.

During setup on 2026-10-15, the operator created and installed
`Developer ID Application: Jordan Mance (S2FPCQK39Z)`. macOS `security find-identity -v
-p codesigning` now recognizes that certificate with its private key as a valid signing
identity. This supersedes the earlier empty-keychain observation. It establishes the local
signer, but does not establish exported credentials, notarization or signed-app qualification.
The operator subsequently reported exporting the password-protected `.p12` and downloading
the notarization team `.p8` with its Key ID and Issuer ID saved. Private file contents and
passwords were not read or included in evidence. No production signing run is claimed.

The operator selected GitHub-hosted macOS runners and subsequently chose an alpha for each
eligible main commit, retaining only the latest complete alpha for distribution. Release
Please merges produce stable builds through their tags and are excluded from alpha jobs.
On 2026-10-16, GitHub confirmed that `desktop-distribution` exists with selected deployment
branch `main` and tag pattern `v*`. Its required reviewer is the `developer-platform` team,
with self-review prevented. After the operator added the settings, GitHub confirmed all
three required secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`) and all three
variables (`CSC_NAME`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). The certificate name matches
the verified local identity, and both API identifiers have the expected formats. Stored
secret values cannot be read back; only a real signing/notarization run can establish that
the exported certificate, password and API key work together. Environment configuration is
complete; real signed-release qualification and controlled publication remain outstanding.

## Ownership and prerequisites

Release Please still owns stable versions, tags, changelogs and GitHub Releases.
[`distribution.yml`](../.github/workflows/distribution.yml) consumes successful canonical
**push** CI for an exact commit. It rejects PR CI, forks, arbitrary branches, failed or
cancelled checks, and mismatched stable versions. `workflow_dispatch` can retry a main or
stable-tag input only after the same exact commit has passed canonical push CI.
Canonical merged Release Please PRs are identified through their exact merge commit, release
branch and `autorelease: pending`, `autorelease: tagged` or `autorelease: published` label.
Their main CI run skips packaging; their stable tag CI owns binary production.
A matching stable version tag on the exact commit also suppresses alpha packaging, including
retries after a PR label has been removed.

The protected `desktop-distribution` environment must be created and restricted to trusted
release operators/default-branch workflow execution, with approval controls appropriate to
the repository. Provision credentials in GitHub's encrypted secrets, never in a checkout,
task comment, evidence, or a manifest:

| Setting | Storage | Meaning |
| --- | --- | --- |
| Approved Apple Team ID | Reviewed `binary-publisher-policy.mjs` | Trust root used by producer and future consumers |
| `CSC_NAME` | Environment variable | Full `Developer ID Application: Name (TEAMID)` identity |
| `CSC_LINK` | Environment secret | Base64 Developer ID Application PKCS#12 export |
| `CSC_KEY_PASSWORD` | Environment secret | PKCS#12 password |
| `APPLE_API_KEY_BASE64` | Environment secret | Base64 App Store Connect notarization key |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Environment variables | Notarization key identity |
| `RELEASE_PLEASE_APP_CLIENT_ID` | Existing repository variable | Existing release GitHub App |
| `RELEASE_PLEASE_APP_PRIVATE_KEY` | Existing repository secret | Existing release App token owner |

The job materializes the notarization key as a private temporary file and removes it even
on failure. It mints a repository-scoped, contents-write App token **after** qualification.
No personal access token is introduced. The publisher uses native `gh` authentication,
explicitly targets `teamupstart/mission-control` on GitHub.com, disables debug HTTP logs,
and reports bounded errors without echoing transport responses or credentials.

### Initial Apple and GitHub setup

Use GitHub-hosted macOS runners. The operator selected this route during qualification;
no runner service or signing identity needs to be installed on the operator's daily Mac.
GitHub destroys the hosted job's virtual machine afterward. See
[GitHub's signing guide](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

1. Sign in to Apple Developer and open **Membership details**. Confirm the team that owns
   Mission Control's releases and give its non-secret, ten-character **Team ID** to the
   implementer for the reviewed publisher policy. See [Apple's Team ID guide](https://developer.apple.com/help/glossary/team-id/).
2. In Keychain Access, use **Certificate Assistant > Request a Certificate from a Certificate
   Authority**. Enter the account email and a descriptive common name, leave the CA email
   empty, and save the request to disk. As the Apple Account Holder, create a **Developer ID
   Application** certificate in **Certificates, Identifiers & Profiles**, upload that
   request, then download and install the certificate. Export it with its private key from
   Keychain Access as a password-protected `.p12` outside the checkout. A Developer ID
   Installer certificate is for `.pkg` installers and is not needed for these ZIP/DMG assets.
   Follow Apple's [CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
   and [Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) instructions.
3. In App Store Connect, open **Users and Access > Integrations > App Store Connect API >
   Team Keys**. If API access has not been enabled, the Account Holder must request it.
   Create a dedicated Mission Control notarization **team key** with **App Manager** access,
   as required by the installed [Electron notarization library](https://github.com/electron/notarize/blob/v2.5.0/README.md#usage-with-app-store-connect-api-key).
   Record the non-secret Key ID and Issuer ID. Download the `.p8` once and store it outside
   the checkout. This team key is not limited to one app; do not reuse a personal key or
   share its contents in chat. See [Apple's key management guide](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api).
4. A repository **admin** creates **Settings > Environments > desktop-distribution** and
   configures its protections before adding secrets. Require approval by Jordan7265 or a
   designated release reviewer. Enable **Prevent self-review** only when another reviewer
   is available. Select deployment branches/tags explicitly: branch `main` and tags `v*`.
   The workflow's input checks still enforce the exact source identity; the environment
   alone does not validate the commit checked out by a `workflow_run` job. Maintain access
   does not permit configuring this environment. See [GitHub's environment requirements](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
5. Add the settings in the table above to that environment. Copy the certificate's full
   `Developer ID Application: Name (TEAMID)` name into `CSC_NAME`. Transfer the private
   files directly to GitHub's encrypted secrets using the commands below, replacing only
   the local file paths. The password command prompts privately; do not use a password
   argument, paste credentials into chat, enable shell tracing, or save them as evidence.

```sh
base64 -i '/absolute/path/mission-control-signing.p12' | gh secret set CSC_LINK --repo teamupstart/mission-control --env desktop-distribution
gh secret set CSC_KEY_PASSWORD --repo teamupstart/mission-control --env desktop-distribution
base64 -i '/absolute/path/AuthKey_KEYID.p8' | gh secret set APPLE_API_KEY_BASE64 --repo teamupstart/mission-control --env desktop-distribution
```

After provisioning, verify secret **names** and environment protection rules, confirm the
certificate belongs to the pinned team, and run qualification on the final exact commit through the
normal reviewed workflow. Configuration alone does not satisfy the release exit gate.
The existing release App remains the publication owner; do not replace it with a personal
token to work around missing admin access.

## Produce and qualify

Use a clean exact-commit checkout on macOS arm64, Node 24+, Xcode command-line tools,
`npm ci`, and securely provisioned credentials. For local execution, `APPLE_API_KEY` names
the private key file rather than its base64 value. The Team ID must already be approved
in source. An output directory from an earlier attempt causes a refusal; a fresh checkout
is the safe way to rebuild without erasing publication recovery material.

```sh
# Stable, checked out at the Release Please tag:
MISSION_DISTRIBUTION_CHANNEL=stable MISSION_DISTRIBUTION_TAG=vX.Y.Z npm run package:distribution

# Alpha, checked out at the selected full main commit:
MISSION_DISTRIBUTION_CHANNEL=alpha npm run package:distribution
```

The command builds, stamps `missionCommit` and the unchanged C1 `missionBinary` metadata
before signing, and packages once with hardened runtime and mandatory Developer ID signing.
Electron's run-as-node fuse stays enabled; the Node options and inspector environment
fuses are disabled. `asar` stays off and the Phase 1 helper inventory stays packaged.
Ordinary `npm run package` remains the existing credential-free developer path.

The app is notarized and stapled before archive creation. Qualification checks the bundle
identifier, approved signer, notarized Developer ID assessment, staple, minimum OS,
arm64 executable, version, full commit, helper inventory and fuse state. A separate signed
DMG is made with `--prepackaged`, notarized and stapled. The app ZIP is generated by `ditto`
with its framework links and resources preserved. Both archives are opened read-only or
extracted privately, and their app digests and signatures must match the original app.
Archive hashes are computed afterward and never inserted back into signed metadata.

The signed-runtime probe copies the complete final app, preserves quarantine, starts its
actual shipped detached helper, retires the original temporary app path, and exits the
parent, which runs from another complete temporary copy so it cannot impersonate a
LaunchServices foreground app at the install destination. The helper must record the deliberate missing-source failure after the parent
exits. The copied runtime must still pass signature/staple/fuse checks and run the shipped
MCP `initialize`/`tools/list` handshake with Node/npm/npx traps untouched. It never replaces
the operator's app or launches a daemon or agent. This is a lifetime and runtime proof,
not a signed successful replacement or first-install GUI journey. Phase 1's transaction
fixtures remain regression coverage; later installer/updater phases must exercise their
actual successful signed journeys.

Before declaring Phase 2 release-ready, run the producer with the approved credentials,
exercise a clean-account/VM Gatekeeper launch with quarantine intact, and perform the
controlled canonical publication and retrieval. Record the exact source SHA, signer,
manifest and asset IDs, lengths and digests, plus the signed-runtime output. Do not disable
Gatekeeper or strip quarantine. Unknown database backward compatibility keeps the existing
forward-recovery boundary after receipt commitment; this producer grants no rollback waiver.

## Publish and retry

```sh
# The complete qualified output of package:distribution:
npm run publish:distribution

# Or retained original qualified bytes from the Actions artifact:
node scripts/publish-distribution.mjs /absolute/path/to/retained-distribution
```

The CLI verifies `build-metadata.json` and `qualification.json` against the final local
archive bytes and the pinned team. These local files are producer evidence, not client
trust roots. It resolves the canonical release tag back to the exact commit. Stable
publication requires an existing non-draft, non-prerelease Release Please release. Alpha
requires the exact commit to be on canonical main and uses a dedicated prerelease
`alpha-<full-40-character-sha>`, never GitHub's mutable latest pointer. Alpha C1 metadata
retains its normal package version and `releaseTag: null`.

The publisher uploads the app ZIP and DMG without clobbering, then downloads their canonical
asset IDs and verifies actual lengths and SHA-256 bytes. Only after both succeed does it
upload bounded `mission-control-manifest.json`, containing the real immutable asset IDs.
The manifest is verified after upload too. A release object or Actions artifact alone is
not a ready binary. Consumers must select by exact stable tag or alpha commit and require
the manifest, both referenced assets, and the pinned publisher policy.

| Observed state | Recovery |
| --- | --- |
| No ready manifest, some matching uploads | Reuse the original local bytes; the publisher uploads only missing files |
| Lost response during upload | Retry; readback determines whether the server accepted it |
| Ready manifest and identical complete bytes | Verify without replacing assets; alpha retries also resume retirement of older sets |
| Any byte, ID, length, channel or commit mismatch | Refuse; never overwrite a published identity |
| A GitHub `starter` asset or corrupt partial upload | Refuse; an operator may inspect and remove only unadvertised failed uploads before retrying |
| Ready manifest but a referenced asset is missing | Refuse; do not silently repair or offer another commit |
| New alpha verified, previous alpha cleanup interrupted | Retry the current build's publication; retirement resumes with readiness removed before payload deletion |
| Exact alpha identity has been retired | Refuse republication; request a new explicit offer |
| Credentials, CI eligibility, signing or notarization fail | No ready manifest; resolve the specific prerequisite |

Timestamped signatures and notarization mean rebuilding the same commit need not reproduce
the same archive bytes. Retry with the original qualified assets, retained as a 90-day
Actions artifact before publication. If those bytes are lost, do not replace an advertised
identity; issue a new explicit release/commit identity through the normal owner.

Stable recovery releases remain available indefinitely. Alpha publication keeps only the
newest complete ready build by Git ancestry, not release creation time. After verifying the
replacement's actual archive bytes, the publisher marks each older ancestor release retired,
removes its ready manifest, confirms readiness is gone, and deletes its ZIP/DMG. Small empty
release/tag records remain as retirement markers so an old retry cannot recreate a different
asset identity. Unrelated assets, stable releases, divergent commits, and unverified newer
builds are never deletion targets. Interrupted cleanup is resumable; it can temporarily retain
extra bytes but cannot advertise a partial old set. A job that finishes out of order verifies
the newer ready build and retires its own older identity.

Release discovery is bounded to 1,000 records, including retired markers. Exceeding that
limit refuses retention rather than deleting from an incomplete inventory. The limit must
be reviewed before the repository reaches that size; retirement markers must not be
manually removed to work around it.

All Actions alpha jobs share one non-cancelling concurrency group for publication and
retirement. GitHub may replace an older pending job with a newer queued job. A local manual
publication must not run concurrently with Actions or another local publisher. Superseded or
cancelled CI commits are unavailable unless their exact eligible build completes. A failed
new build leaves the previous ready alpha available.

The operator's latest-only policy means an outstanding offer for an old alpha can expire.
Later clients may use an already verified local stage, but if the exact remote set has been
retired they must request a new explicit offer. They must never silently install a different
commit or compile locally. This changes retention from the plan's retain-all default; it does
not change C1 identities or relax the manifest/asset checks required by later consumers.

`gh api` handles both direct asset responses and redirects. No manifest URL is executed or
used as an HTTP destination. GitHub CLI's authentication transport refuses to add an auth
header after a hostname-changing redirect; this implementation does not extract or forward
a token itself. This follows the [GitHub CLI transport](https://github.com/cli/cli/blob/trunk/api/http_client.go)
and [GitHub release asset API](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28).
Signing order and fuse policy follow [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
and [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), checked against the installed builder implementation.

## Verification and phase deviations

Focused tests cover publication ordering, interrupted/resumed uploads, immutable collisions,
metadata and architecture mismatches, incomplete or malformed ready sets, access denial,
redacted errors, streaming limits, stable/alpha eligibility, credential preflight and workflow
secret boundaries. Actionlint validates workflow syntax. Neither proves live permissions.
Run typecheck, lint, build and smoke as well. No UI behavior changed in this phase.

The implementation deliberately uses a separate non-cancelling distribution workflow rather
than putting publishing inside cancellation-enabled CI. It waits for successful exact-commit
push CI and preserves the old developer DMG artifact. The new producer pins the supported
arm64 `macos-15` image: GitHub is [retiring macOS 14 on 2026-11-02](https://github.com/actions/runner-images/issues/13518).
Both existing native addons and the Electron payload declare a macOS 12.0 minimum; this
phase does not change their deployment targets or the older developer CI job.
At the operator's request, alpha retirement keeps only the latest complete build while
preserving immutable exact-commit identities and explicit expiration of old offers. Stable
recovery assets remain retained. C1, receipts, install transactions, Setup and updater behavior
remain unchanged. The probe exercises a safe, real detached failure after parent removal rather
than launching an unqualified full app against a live installation. These deviations and
the unfulfilled signing/publication gate must be carried into the eventual pull request.
