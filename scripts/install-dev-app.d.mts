import type { BundleOps } from "./app-bundle-swap.mjs";
import type { inspectInstallDirectory } from "./install-destination.mjs";

export const USAGE: string;

export function parseArgs(argv: string[]): {
  options: { appsDir: string | null };
  help: boolean;
  problem: string | null;
};

export function installDevApp(input: {
  appsDir?: string | null;
  repoRoot: string;
  home?: string;
  exists?: (path: string) => boolean;
  makeDirectory?: (path: string) => void;
  inspect?: typeof inspectInstallDirectory;
  swap?: (input: {
    sourceBundle: string;
    appPath: string;
    appsDir: string;
    pid: number | string;
    ops?: BundleOps;
  }) => { problem: string | null; elevated: boolean; stranded: string[] };
  pid?: number | string;
  log?: (line: string) => void;
}): { problem: string | null; appPath: string | null; elevated?: boolean };
