import { APP_BUNDLE_NAME } from "./app-naming.mjs";

export interface BinaryEnrollment {
  action: "install" | "enroll" | null;
  destination: string;
  message: string;
}

export const BINARY_RECOVERY_URL = "https://github.com/teamupstart/mission-control#installation";
export const BINARY_UPDATE_UNAVAILABLE = "Automatic binary updates are not available in this build. Use the signed binary installer for manual replacement; it preserves your installation destination and state.";

/** A mounted or translocated app can install elsewhere, never enroll itself. */
export function binaryEnrollmentChoice(input: {bundle: string; home: string; managedPath: string | null; temporary?: boolean; problem?: string | null}): BinaryEnrollment {
  const {bundle, home, managedPath, problem} = input;
  if (problem) return {action: null, destination: bundle, message: problem};
  if (input.temporary) {
    return {action: "install", destination: managedPath?.replace(/\/Mission Control\.app$/, `/${APP_BUNDLE_NAME}`) ?? `${home}/Applications/${APP_BUNDLE_NAME}`,
      message: "This temporary copy cannot be enrolled or updated here. Install the verified app at a persistent destination before using it."};
  }
  if (managedPath) return {action: null, destination: managedPath, message: managedPath === bundle
    ? "This destination is already managed. Check for updates here, or use the signed installer for recovery."
    : `A different managed installation is at ${managedPath}. Open it or use the signed installer; this copy cannot take over its receipt.`};
  return {action: "enroll", destination: bundle, message: "Enroll this copied app at its current destination. GitHub CLI downloads its exact published build to verify provenance. Your state and integration settings are preserved."};
}
