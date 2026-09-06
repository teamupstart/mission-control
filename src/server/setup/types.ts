import type { AgentType } from "@shared/types.ts";
import type { EnvironmentCheckView } from "@shared/environment-checks.ts";
import type { PipelineProbe } from "@shared/pipeline.ts";
import type { TerminalBackendId, TerminalTargetView } from "@shared/terminal.ts";
import type { SetupBannerDismissal } from "@shared/setup-catalog.ts";
import type { ExecutableId } from "@shared/executables.ts";

import type { EnvironmentDeps } from "../environment/types.ts";
import type { InstalledPluginsRead } from "../plugins/installed-plugins.ts";
import type { RunResult } from "../util/exec.ts";

export interface SetupSkillsRead {
  enabled: boolean;
  readable: boolean;
  configured: number;
  directories: string[];
  problems: string[];
}

/** Read-only seams used by the uncached Setup snapshot. */
export interface SetupDeps {
  /** One fresh login-shell PATH snapshot for this explicit machine inspection. */
  refreshPath?(): Promise<void>;
  executableDiagnostic?(id: ExecutableId): Promise<{ path: string; source: string } | null>;
  environment: EnvironmentDeps;
  agentBin(agent: AgentType): string;
  installedBackend(id: TerminalBackendId): Promise<string | null>;
  ghBin(): string;
  resolveBinPath(bin: string): Promise<string | null>;
  runCommand(bin: string, argv: string[]): Promise<RunResult>;
  installedPlugins(): Promise<InstalledPluginsRead>;
  skills(): SetupSkillsRead;
  conductorProbe(): Promise<PipelineProbe>;
  terminalTargets(): TerminalTargetView[];
  environmentChecks(deps: EnvironmentDeps): Promise<EnvironmentCheckView[]>;
  readBannerDismissal(): SetupBannerDismissal;
  writeBannerDismissal(dismissal: SetupBannerDismissal): void;
}
