import { z } from "zod";
import { partialPatch } from "./zod-shapes.ts";

/** Shipped roots for a machine that has never saved repository-index settings. */
export const DEFAULT_INDEXED_DIRECTORIES = [
  "~/workspace",
  "~/code",
  "~/dev",
  "~/upstart",
] as const;

export const MAX_INDEXED_DIRECTORIES = 16;

export const IndexedDirectorySchema = z.object({
  path: z.string().trim().min(1, "Directory paths cannot be empty."),
});

export type IndexedDirectory = z.infer<typeof IndexedDirectorySchema>;

/**
 * The default belongs on the field rather than in a migration. An absent key therefore
 * gains the shipped roots, while an intentionally stored empty array remains empty. That
 * distinction is what makes every seeded root removable without extra bookkeeping.
 */
export const RepoIndexConfigSchema = z.object({
  // The structural ceiling, checked before any row is parsed. `MAX_INDEXED_DIRECTORIES` is
  // the product rule and is refused with its own message by `repo-index-config.ts`; this only
  // stops an absurd list from being parsed element by element first.
  directories: z.array(IndexedDirectorySchema).max(MAX_INDEXED_DIRECTORIES * 16).prefault(
    DEFAULT_INDEXED_DIRECTORIES.map((path) => ({ path })),
  ),
});

export const RepoIndexConfigPatchSchema = partialPatch(RepoIndexConfigSchema);

export type RepoIndexConfig = z.infer<typeof RepoIndexConfigSchema>;
export type RepoIndexConfigPatch = z.infer<typeof RepoIndexConfigPatchSchema>;

export const INDEXED_DIRECTORY_STATUSES = [
  "ok",
  "missing",
  "not-a-directory",
  "unreadable",
  "unsafe",
] as const;

export type IndexedDirectoryStatus = (typeof INDEXED_DIRECTORY_STATUSES)[number];

export interface IndexedDirectoryView {
  path: string;
  resolved: string | null;
  status: IndexedDirectoryStatus;
  repoCount: number | null;
  isDefault: boolean;
}

export interface RepoIndexView {
  directories: IndexedDirectoryView[];
  managedBy: "config" | "environment";
  environmentVariable: string | null;
  environmentValue: string | null;
  /** Stored rows that remain intact but do not participate while the environment wins. */
  savedDirectories: IndexedDirectoryView[];
  defaultsMissing: string[];
  repoCount: number;
  scannedAt: number;
}
