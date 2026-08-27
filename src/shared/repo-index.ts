import { z } from "zod";

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
  directories: z.array(IndexedDirectorySchema).default(
    DEFAULT_INDEXED_DIRECTORIES.map((path) => ({ path })),
  ),
});

export const RepoIndexConfigPatchSchema = RepoIndexConfigSchema.partial();

export type RepoIndexConfig = z.infer<typeof RepoIndexConfigSchema>;
export type RepoIndexConfigPatch = z.infer<typeof RepoIndexConfigPatchSchema>;

export const INDEXED_DIRECTORY_STATUSES = [
  "ok",
  "missing",
  "not-a-directory",
  "unreadable",
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
