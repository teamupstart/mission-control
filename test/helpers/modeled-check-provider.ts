import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CheckTreeOwnership,
  CheckTreeProvider,
  CheckTreeRef,
} from "../../src/server/workflows/check-lease.ts";
import { resetWorktreeToCommit } from "../../src/server/git/ensemble-snapshot.ts";
import { mainRepoRoot } from "../../src/server/util/git.ts";
import { stubRun, type RunResult } from "../../src/server/util/exec.ts";
import { legacyCheckHolder, LEGACY_CHECK_HOLDER_PREFIX } from "../../src/server/worktrees/legacy-treehouse.ts";

export interface TreehouseCli {
  status(repoRoot: string): Promise<RunResult>;
  get(repoRoot: string, holder: string): Promise<RunResult>;
  return(input: { cwd: string | null; path: string; force: boolean }): Promise<RunResult>;
}

export function checkHolderToken(attemptId: string): string {
  return legacyCheckHolder(attemptId);
}

export function isCheckHolder(holder: string | null | undefined): boolean {
  return typeof holder === "string" && holder.startsWith(LEGACY_CHECK_HOLDER_PREFIX);
}

export interface ModeledPoolTree {
  path: string;
  holder: string | null;
  state: string;
}

export function parsePoolStatus(stdout: string): ModeledPoolTree[] {
  const rows: ModeledPoolTree[] = [];
  const pattern = /^(\S+)[ \t]+(leased|in-use|available|dirty|you're here)[ \t]+(\S+)(?:[ \t]+\(held by (.+?)\))?[ \t]*$/;
  for (const line of stdout.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    rows.push({ path: canonical(match[3]!), state: match[2]!, holder: match[4]?.trim() || null });
  }
  return rows;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Test-only modeled warm provider. Production has no Treehouse acquisition interface. */
export class ModeledCheckTreeProvider implements CheckTreeProvider {
  readonly kind = "treehouse" as const;

  constructor(
    private readonly cli: TreehouseCli,
    private readonly reset: (repoRoot: string, leasePath: string, baseSha: string) => Promise<void>,
  ) {}

  async acquire(input: { repoRoot: string; attemptId: string }): Promise<{
    path: string;
    holderToken: string;
    leaseId: string | null;
  }> {
    const holderToken = checkHolderToken(input.attemptId);
    const result = await this.cli.get(input.repoRoot, holderToken);
    const path = result.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
    if (!path) throw new Error(`modeled provider could not acquire: ${result.stderr || `exit ${result.code}`}`);
    return { path: canonical(path), holderToken, leaseId: null };
  }

  pin(input: { repoRoot: string; path: string; baseSha: string }): Promise<void> {
    return this.reset(input.repoRoot, input.path, input.baseSha);
  }

  async ownership(ref: CheckTreeRef): Promise<CheckTreeOwnership> {
    const status = await this.cli.status(ref.repoRoot);
    if (status.code !== 0) return { state: "unreadable", reason: `modeled status exited ${status.code}` };
    const tree = parsePoolStatus(status.stdout).find((entry) => entry.path === canonical(ref.leasePath));
    if (!tree || tree.state === "available" || tree.holder === null) return { state: "gone" };
    return { state: "held", holder: tree.holder };
  }

  handBack(ref: CheckTreeRef): Promise<RunResult> {
    return this.cli.return({ cwd: ref.repoRoot, path: ref.leasePath, force: true });
  }

  withLock<T>(_repoRoot: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export async function pinModeledWorktree(
  repoRoot: string,
  leasePath: string,
  baseSha: string,
): Promise<void> {
  const owner = mainRepoRoot(leasePath);
  const asked = mainRepoRoot(repoRoot) ?? realpathSync(repoRoot);
  if (!owner || owner !== asked) {
    throw new Error(`refusing to reset a checkout we cannot prove belongs to ${asked}`);
  }
  await resetWorktreeToCommit(leasePath, baseSha);
}

export const successfulReturn = (): RunResult => stubRun({ stdout: "", stderr: "", code: 0 });
