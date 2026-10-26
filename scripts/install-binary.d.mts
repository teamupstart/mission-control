import { parseBinaryInstallArgs } from "./binary-install-policy.mjs";
export * from "./binary-install-policy.mjs";
export function installBinary(options: ReturnType<typeof parseBinaryInstallArgs>, ports?: Record<string, unknown>): Promise<{appPath: string; dryRun: boolean}>;
export function waitForInstalledDaemon(receipt: import('../src/shared/install-receipt-schema.mjs').InstallReceipt, stateDirectory: string, mac: Pick<import('./mac-app-lifecycle.mjs').MacAppOps, 'run'>, options?: {probe?: typeof fetch; timeout?: number}): Promise<void>;
