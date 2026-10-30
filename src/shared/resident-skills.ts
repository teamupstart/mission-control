import { z } from "zod";

/** Persisted source ids. Append only. Custom sources use a separate UUID namespace. */
export const RESIDENT_SKILL_SOURCE_IDS = [
  "mission", "claude-global", "agents-global", "codex-global", "claude-builtin", "codex-builtin",
] as const;
export type ResidentSkillSourceId = (typeof RESIDENT_SKILL_SOURCE_IDS)[number];

export const ResidentSkillDirectorySchema = z.object({
  id: z.string().regex(/^custom-[0-9a-f-]{36}$/, "A source needs a custom UUID."),
  path: z.string().trim().min(1).max(4096),
}).strict();

export const ResidentSkillSourcesSchema = z.object({
  directories: z.array(ResidentSkillDirectorySchema).max(16).default([]),
}).strict().superRefine(({ directories }, ctx) => {
  if (new Set(directories.map((row) => row.id)).size !== directories.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["directories"], message: "Source ids must be unique." });
  }
});
export type ResidentSkillSources = z.infer<typeof ResidentSkillSourcesSchema>;

export const UpdateResidentSkillSourcesSchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  config: ResidentSkillSourcesSchema,
}).strict();

export interface ResidentSkillSource {
  id: string;
  label: string;
  path: string | null;
  custom: boolean;
  problems: string[];
}

export interface IndexedResidentSkill {
  /** Source id and relative folder, independent of frontmatter or scan order. */
  id: string;
  sourceId: string;
  folder: string;
  path: string;
  name: string;
  description: string;
}

/** On-demand catalog, never an SSE collection. */
export interface ResidentSkillIndex {
  sources: ResidentSkillSource[];
  skills: IndexedResidentSkill[];
  config: ResidentSkillSources;
  configRevision: string;
  /** Invalid stored registrations are preserved until an explicit repair. */
  configurationProblem: string | null;
  /** The aggregate serialized response budget stopped this scan early. */
  truncated: boolean;
  scannedAt: number;
}
