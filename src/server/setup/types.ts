import type { AgentType } from "@shared/types.ts";
import type { EnvironmentCheckView } from "@shared/environment-checks.ts";
import type { PipelineProbe } from "@shared/pipeline.ts";
import type { TerminalBackendId, TerminalTargetView } from "@shared/terminal.ts";
import type { SetupBannerDismissal, SetupRemedy, SetupStatus } from "@shared/setup-catalog.ts";
import type { ExecutableId } from "@shared/executables.ts";

import type { EnvironmentDeps } from "../environment/types.ts";
import type { CmuxControl } from "../terminal/cmux.ts";
import type { HerdrProbe } from "../terminal/herdr-client.ts";
import type { InstalledPluginsRead } from "../plugins/installed-plugins.ts";
import type { RunResult } from "../util/exec.ts";

/**
 * What one probe established, and the repair that reading specifically needs.
 *
 * `remedy` is an override for this observation only, and it exists because a row can be
 * unsatisfied in more than one way: Herdr not installed wants the install guide, Herdr
 * installed with its server down wants a button that starts the server. Absent - which is
 * every probe but one - the row keeps its catalog remedy, so the catalog stays the single
 * place a dependency's ordinary repair is written.
 */
export interface SetupProbeResult {
  status: SetupStatus;
  remedy?: SetupRemedy;
}

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
  /** An adapter-level host refusal that must win before installation probing. */
  backendUnsupported?(id: TerminalBackendId): string | null;
  /** Whether Herdr's default server is up, which installation alone does not answer. */
  herdrServer(): Promise<HerdrProbe>;
  /** Whether the cmux app is open AND admitting the daemon, neither of which installation answers. */
  cmuxControl(): Promise<CmuxControl>;
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
