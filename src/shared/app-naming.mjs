// The on-disk name changes; bundle identity, executable and state locations do not.
export const APP_BUNDLE_NAME = "Agent Mission Control.app";
export const LEGACY_APP_BUNDLE_NAME = "Mission Control.app";
export const APP_EXECUTABLE_NAME = "Mission Control";
export function isManagedBundleName(name) {
  return name === APP_BUNDLE_NAME || name === LEGACY_APP_BUNDLE_NAME;
}
/** An absent field is the original, already-shipped archive layout. */
export function binaryBundleName(metadata) {
  return metadata.appBundleName ?? LEGACY_APP_BUNDLE_NAME;
}
