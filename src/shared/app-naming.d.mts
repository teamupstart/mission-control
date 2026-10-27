export const APP_BUNDLE_NAME: "Agent Mission Control.app";
export const LEGACY_APP_BUNDLE_NAME: "Mission Control.app";
export const APP_EXECUTABLE_NAME: "Mission Control";
export function isManagedBundleName(name: string): boolean;
export function binaryBundleName(metadata: {appBundleName?: string}): string;
