# macOS app name transition

New packages install **Agent Mission Control.app**. The bundle identifier stays
`com.mission-control.app`, the internal executable stays `Contents/MacOS/Mission Control`,
and Electron still uses `Mission Control` for its application data name. The state home,
database, settings, session records and stable/alpha provenance do not move. This is an
installed bundle name change, not a repository or product-wide rebrand.

## Compatibility and rollout

The rename includes the binary consumer from draft PR #1214, reviewed at
`fa0e8987c1c466fa1b6773cfa58a411c9737089b`, adapted on the rename task's branch.
That PR remains draft with its DO NOT MERGE hold. Do not merge its original consumer
independently or overwrite its branch. Reconcile its disposition after review of the
combined change. No merge or release is authorized by implementation completion.

| Installed consumer | Original manifest, no appBundleName | Renamed manifest |
| --- | --- | --- |
| Released source updater before this change | Existing source build route | An ordinary source update can install this combined bridge at the recorded old path. Its next binary update performs the rename. The current standalone binary installer is also supported. |
| Original Phase 3 bootstrap or unadapted #1214 consumer | Original Mission Control.app layout only | Refuses the unknown manifest field before executing downloaded code. Fetch the current installer from the README; do not reuse a saved old bootstrap or remove validation. |
| Combined renamed consumer and installer | Parses historical identity for receipts/recovery, but refuses it as a new installation target | Installs the new layout, migrates the old name in the same directory, and supports subsequent stable and exact-SHA alpha updates. |

There is no fabricated legacy-layout copy, dual-root ZIP, alias app, historical backfill or
mutation of published assets. `appBundleName: "Agent Mission Control.app"` is present in
both the immutable manifest and signed `missionBinary` metadata. New artifacts use
`Agent-Mission-Control-vVERSION-darwin-arm64` or
`Agent-Mission-Control-alpha-FULL_SHA-darwin-arm64`, with `.zip` and `.dmg` extensions.
The ready manifest keeps its existing filename. Its absence means the release is unavailable,
not that the old-name updater is safe to roll out.

The consumer pins one declared archive root, checks exact asset ID, bytes and digest,
compares signed build identity, and retains the existing pinned Developer ID/notarization
policy. Target packages advertise `missionInstallTransaction.appNaming: 1`. Signing,
notarization, release approval and publisher verification are unchanged. The sole R1/R2
qualification contract is [forward-rollout.md](plans/desktop-without-system-node/forward-rollout.md).

## Existing installations

Quit the old application and run the **current** README binary installer after a complete
qualified renamed release is available. Use the same `MISSION_HOME` if it was customized.
Omit destination flags to preserve the receipt's directory and exact scope, including an
absent legacy scope. Personal, system and custom destinations all migrate within that folder.
Schema-1 clone and retained-installer receipts and schema-2 binary receipts are supported.
Updating or migrating through this binary route needs no host Node, npm, npx or compilation.

An occupied Agent Mission Control.app destination is never merged or overwritten during
rename, even if it looks like another copy of this product. Inspect and move that copy aside
explicitly, then retry. A fresh installation also refuses an unmanaged old-name sibling.
Do not delete receipts, change their paths by hand, or enroll a second app to bypass this check.
The explicit source installer remains available; when updating an existing receipt it keeps
its old path so already-running source helpers can finish their established handoff safely.

The updater displays both paths before shutdown. Later, Escape and cancellation preserve
the old app and receipt. Rename does not imply relocation or change system/custom consent.
Already-recorded protocol-1 system-to-personal migrations still recover under their original
rules. The new binary rename takes precedence over offering a new relocation.

## Replacement and recovery

The journal's protocol-3 rename is an extension of the existing transaction owner. It
retains a verified private old bundle and copies the accepted target into a private
`.mission-rename-staging-*` directory on the destination volume. It verifies that copy and
records its directory identity before publishing it with the shipped native addon's atomic
no-overwrite rename. An occupied destination, including an empty directory or symlink,
prevents publication. Copying and permission changes never operate on the public app path.
The published target launches for readiness before receipt commitment.
The target verifies packaged modules and the state lock addon before state or agents start.
No second managed installation takes ownership of state. A system-folder write may require
the existing narrowly scoped administrator authorization for private staging and publication;
custom paths never gain elevation. Authorized publication uses the helper's embedded runtime
and the same no-overwrite native operation, rechecking the source identity after the prompt.

Before commitment, recovery stops only the identified target, removes only the nonce-owned
reservation, keeps the old bundle and exact original receipt bytes, archives the new journal
away from legacy readers, and reopens the source. Unidentified processes, changed paths,
foreign reservations and changed receipts fail closed and retain recovery material.
A crash or denied staging cleanup can leave that private folder behind for manual inspection.
A cleanup failure reports its path without undoing publication or masking the original error. Ownership
is recorded before public publication, so recovery can identify a target published just before
the helper exited.

Cleanup captures the verified directory in a private `.mission-rename-cleanup-*` sibling
and checks its device/inode identity again before deletion. Administrator-authorized cleanup
repeats that capture and verification after the prompt. A changed directory is retained at
the reported path for manual inspection; cleanup never restores it over a concurrent arrival
or recursively deletes the public app path. Interrupted or permission-denied cleanup can leave
that private folder behind. Preserve it until the journal, receipt and retained app have been
inspected; do not delete it solely because its name resembles cleanup material.

After commitment, the verified old public bundle is retired. Recovery completes forward
using the new receipt; it never starts old code against potentially upgraded state. Private
backup bytes and the journal remain available for inspection. If permissions, a concurrent
edit or interruption prevents retirement, keep the renamed app and receipt, quit remaining
old processes and inspect the named source/backup manually. Do not roll the receipt back or
start the backup against live state. A later same-name update uses the established replacement
transaction and exact receipt recovery boundary.

Owned integration paths are repaired without enabling disabled integrations or replacing
custom commands. Existing sessions and their data remain; start fresh agent sessions to use
repaired hook/MCP paths. Replace an old Dock shortcut with the renamed app. An in-app update
captures Start at login before shutdown. A standalone migration from older code cannot read
that preference through Electron's macOS API: it leaves it untouched, reports pending login
confirmation, and asks you to set Start at login in the renamed app and choose Retry integration
repair. Automatic background retries never confirm that choice on your behalf.

## Verification boundary

Deterministic tests cover fresh installation, old-name source/binary receipts, all destination
scopes, collisions, cancellation, interruption around receipt commitment, readiness failure,
exact recovery and subsequent updates. The detached fixture downloads a ZIP through the real
binary worker, extracts it, retains its descriptor, replaces through a copied Electron helper
after the parent exits, and starts the target GUI with host Node/npm/npx invocation traps.
Its Apple trust responses are simulated only inside disposable test copies. It is not signed
release or Gatekeeper qualification. See [release verification](release-verification.md) for
current publication observations and the pending protected R1/R2 runs.
