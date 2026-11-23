import type { MacAppOps } from './mac-app-lifecycle.mjs';
export interface UpdateProcessOwner {pid: number; fingerprint: string; group: boolean; work: string}
export function processFingerprint(identity: string | null): string | null;
export function readCheckProcessOwners(stateDirectory: string, ops: Pick<MacAppOps, 'identity'>): UpdateProcessOwner[];
export function captureUpdateProcessOwners(input: {stateDirectory: string; parent: {pid: number; identity: string | null}; bundle?: string; userDataDirectory?: string; processNames?: Record<number, string>}, ops?: MacAppOps): Promise<UpdateProcessOwner[]>;
