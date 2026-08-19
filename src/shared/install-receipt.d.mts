import type { InstallReceipt } from "./install-receipt-schema.mjs";

export function receiptPath(): string;
export function readReceipt(path?: string): InstallReceipt | null;
export function writeReceipt(receipt: InstallReceipt, path?: string): string;
