// Which installed app this process actually is, according to the receipt.
//
// The receipt has always named an absolute `appPath`, and nothing ever compared it to the
// bundle the running process came out of. That was harmless while there was exactly one place
// an app could be installed. Personal installs make a second location ordinary, so a Mac can
// now hold two Mission Controls at once - the retained system copy and the personal one - and a
// process that updates "the app in the receipt" without checking it is the app in the receipt
// would let the old copy swap the new one out from under itself.
//
// So startup asks one question with four answers:
//
// - `managed`: this bundle is the one the receipt describes. Everything proceeds as before.
// - `unmanaged`: there is no usable receipt. The updater is already off for this case.
// - `mismatched`: there is a receipt and it describes some other bundle. The app still runs -
//   a person can use it - but it may not update anything, because the only thing it could
//   update is not itself.
// - `redirect`: the narrow, validated exception. The exact system product bundle, holding a
//   receipt that names this account's own canonical personal bundle, opens that app instead of
//   starting a second one. Nothing else redirects anywhere.
//
// Phase 2 of the user-scoped install plan owns the relocation that makes `redirect` common.
// Shipping the classification first is what keeps that relocation from being the moment two
// bundles first have to coexist safely.

import { join } from "node:path";
import { isTrustedInstallRepo } from "../shared/install-receipt-schema.mjs";
import type { InstallReceipt } from "../shared/install-receipt-schema.mjs";

/** The product bundle's directory name, which is also its identity on disk. */
export const APP_BUNDLE_NAME = "Mission Control.app";

/** The one shared location; personal installs live under a home directory instead. */
export const SYSTEM_APPS_DIR = "/Applications";

export type InstallIdentity =
  | { state: "unmanaged" }
  | { state: "managed"; receipt: InstallReceipt }
  | { state: "mismatched"; reason: string; receipt: InstallReceipt }
  | { state: "redirect"; target: string; receipt: InstallReceipt };

export interface IdentityInputs {
  /** The `.app` bundle this process is running from, already absolute. */
  runningBundle: string;
  /** The commit embedded in the running bundle, or null when it cannot be read. */
  runningCommit: string | null;
  receipt: InstallReceipt | null;
  /** This account's home directory. */
  home: string;
  /** Whether a bundle is present at a path. */
  exists(path: string): boolean;
  /** The commit embedded in the bundle at a path, or null when it cannot be read. */
  bundleCommit(appPath: string): string | null;
  /** `CFBundleShortVersionString` of the bundle at a path, or null when it cannot be read. */
  bundleVersion(appPath: string): string | null;
}

export function systemAppPath(): string {
  return join(SYSTEM_APPS_DIR, APP_BUNDLE_NAME);
}

export function userAppPath(home: string): string {
  return join(home, "Applications", APP_BUNDLE_NAME);
}

/**
 * Why a bundle is not the one a receipt describes, or `null` when it is.
 *
 * Commit equality when the receipt carries a commit, version equality when it does not.
 * `installedCommit` is optional and absent on every install made before it was added, so
 * demanding it would invalidate exactly the historical installs this change has to keep
 * working. A version is weaker evidence and is treated as such: it is the fallback, never the
 * preferred check.
 */
export function bundleIdentityProblem(
  receipt: InstallReceipt,
  commit: string | null,
  version: string | null,
): string | null {
  if (receipt.installedCommit) {
    if (!commit) return "the app bundle does not carry a source commit to compare";
    return commit === receipt.installedCommit
      ? null
      : `the app bundle was built from ${commit.slice(0, 7)} but the install receipt records ${receipt.installedCommit.slice(0, 7)}`;
  }
  if (!version) return "the app bundle does not report a version to compare";
  return version === receipt.installedVersion
    ? null
    : `the app bundle reports version ${version} but the install receipt records ${receipt.installedVersion}`;
}

/** Classify the running bundle against the receipt. Pure: every filesystem read is injected. */
export function classifyInstallIdentity(inputs: IdentityInputs): InstallIdentity {
  const { receipt, runningBundle, runningCommit, home } = inputs;
  if (!receipt) return { state: "unmanaged" };

  if (receipt.appPath === runningBundle) {
    const problem = bundleIdentityProblem(
      receipt,
      runningCommit,
      inputs.bundleVersion(runningBundle),
    );
    if (!problem) return { state: "managed", receipt };
    // Same path, different build. A developer install over a managed one lands here, and so
    // does a half-finished update. Redirecting would mean opening this same bundle again, so
    // the only safe answer is to run without the updater.
    return {
      state: "mismatched",
      reason: `Updates are disabled because ${problem}. Reinstall with the managed install command to repair it.`,
      receipt,
    };
  }

  const target = receipt.appPath;
  const mismatch = (reason: string): InstallIdentity => ({ state: "mismatched", reason, receipt });

  // Everything below is the redirect's guard list, and every clause is load-bearing. The
  // receipt is a file in the state directory; treating it as "a path to launch" without
  // pinning both ends of the move would turn it into a way to make Mission Control open an
  // arbitrary bundle.
  if (runningBundle !== systemAppPath()) {
    return mismatch(
      `Updates are disabled because this copy of Mission Control is at ${runningBundle}, while the managed installation is at ${target}. Open the app at ${target}, or reinstall with the managed install command.`,
    );
  }
  if (target !== userAppPath(home)) {
    return mismatch(
      `Updates are disabled because the managed installation is at ${target}, which is not this account's Mission Control. Reinstall with the managed install command.`,
    );
  }
  // Refused rather than asserted. The two paths above cannot be equal today, and a later change
  // to either one that made them equal would otherwise produce an app that launches itself.
  if (target === runningBundle) return mismatch("Updates are disabled because the install receipt points at this same app.");
  if (!isTrustedInstallRepo(receipt.repo)) {
    return mismatch(`Updates are disabled because this app was installed from ${receipt.repo}.`);
  }
  if (!inputs.exists(target)) {
    return mismatch(
      `Mission Control is installed at ${target}, but nothing is there. Reinstall with the managed install command, or keep using this copy without updates.`,
    );
  }
  const problem = bundleIdentityProblem(
    receipt,
    inputs.bundleCommit(target),
    inputs.bundleVersion(target),
  );
  if (problem) {
    return mismatch(
      `Mission Control at ${target} is not the app the install receipt describes: ${problem}. Reinstall with the managed install command.`,
    );
  }
  return { state: "redirect", target, receipt };
}

/**
 * The reason the updater gives for standing down, or `null` when it may run.
 *
 * `redirect` returns a reason too. A source copy that has been asked to hand over is emphatically
 * not the bundle to update, and if the hand-over fails this process keeps running - so the
 * updater has to be off for it either way.
 */
export function identityUpdateBlock(identity: InstallIdentity): string | null {
  if (identity.state === "mismatched") return identity.reason;
  if (identity.state === "redirect") {
    return `Updates are disabled because Mission Control is installed at ${identity.target}. Open the app there.`;
  }
  return null;
}
