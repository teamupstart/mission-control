import {
  SETUP_DEPENDENCY_INFO,
  type SetupDependencyId,
  type SetupDependencyInfo,
} from "@shared/setup-catalog.ts";
import type { SetupTerminalInstallerLaunchBody } from "@shared/protocol.ts";
import type {
  PipelineInstallerCandidatesResult,
  PipelineProviderId,
} from "@shared/pipeline.ts";
import type { PipelineInstallerPreparation } from "../pipelines/index.ts";
import { shellCommand } from "../terminal/shell.ts";
import type {
  TerminalLaunchOutcome,
  TerminalLaunchSpec,
} from "../terminal/targets.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";

const NPM_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const BREW_PACKAGE = /^[a-z0-9][a-z0-9+._@-]*$/;
const FORBIDDEN_TOKEN_CONTENT = /[|&;<>`$()\r\n'"]/;

/**
 * The complete invocation grammar this route will hand to a terminal.
 *
 * Closed deliberately. Adding a program, verb, or flag here changes the execution boundary
 * and requires design review rather than an ordinary catalog edit.
 */
const INSTALL_GRAMMAR = [
  {
    program: "brew",
    subcommand: "install",
    allowedFlags: ["--cask"],
    minFlags: 0,
    maxFlags: 1,
    operands: 1,
    operand: BREW_PACKAGE,
  },
  {
    program: "npm",
    subcommand: "install",
    allowedFlags: ["-g", "--global"],
    // A local npm install would write a project-shaped node_modules tree into the operator's
    // home. Every catalog remedy is machine-wide, so exactly one spelling of the global flag
    // is part of the grammar rather than a browser or catalog convention.
    minFlags: 1,
    maxFlags: 1,
    operands: 1,
    operand: NPM_PACKAGE,
  },
] as const;

/** True only for one complete, fixed package-manager install invocation. */
export function isSetupInstallArgv(argv: readonly unknown[]): argv is readonly string[] {
  if (!Array.isArray(argv) || argv.length < 3 || !argv.every((word) => typeof word === "string")) {
    return false;
  }
  if (
    argv.some(
      (word) =>
        word.length === 0 ||
        FORBIDDEN_TOKEN_CONTENT.test(word) ||
        word.toLowerCase().includes("sudo") ||
        word.includes("://"),
    )
  ) {
    return false;
  }

  const grammar = INSTALL_GRAMMAR.find((entry) => entry.program === argv[0]);
  if (!grammar || argv[1] !== grammar.subcommand) return false;
  const operand = argv.at(-1)!;
  if (operand.startsWith("-")) return false;
  const flags = argv.slice(2, -grammar.operands);
  if (flags.length < grammar.minFlags || flags.length > grammar.maxFlags) return false;

  const seen = new Set<string>();
  for (const flag of flags) {
    if (!(grammar.allowedFlags as readonly string[]).includes(flag) || seen.has(flag)) return false;
    seen.add(flag);
  }
  return grammar.operand.test(operand);
}

export type SetupInstallOutcome = "opened" | "maybe-opening" | "refused";

export interface SetupInstallResult {
  ok: boolean;
  id: SetupDependencyId;
  outcome: SetupInstallOutcome;
  label: string;
  detail: string;
}

export interface SetupInstallExecutionDeps {
  catalog: Readonly<Record<SetupDependencyId, SetupDependencyInfo>>;
  homeDir: string;
  listRepoRoots(): Promise<string[]>;
  listProviderInstallers(
    provider: PipelineProviderId,
    repoRoots: readonly string[],
  ): Promise<PipelineInstallerCandidatesResult>;
  prepareProviderInstaller(
    provider: PipelineProviderId,
    checkout: string,
    repoRoots: readonly string[],
  ): Promise<PipelineInstallerPreparation>;
  launchTerminal(backend: SetupTerminalInstallerLaunchBody["backend"], spec: TerminalLaunchSpec): Promise<TerminalLaunchOutcome>;
}

/** Dependencies routes may override without moving command ownership into a caller. */
export type SetupInstallRouteDeps = Partial<Omit<SetupInstallExecutionDeps, "launchTerminal">> & {
  installPiExtension?: typeof import("./pi-extension.ts").installPiExtensionFromSetup;
};

export interface SetupInstallResponse {
  status: 200 | 404 | 409 | 502 | 504;
  body: SetupInstallResult;
}

function refused(
  id: SetupDependencyId,
  label: string,
  detail: string,
  status: SetupInstallResponse["status"] = 409,
): SetupInstallResponse {
  return { status, body: { ok: false, id, outcome: "refused", label, detail } };
}

/** The daemon-owned shell that keeps the visible terminal open on the install's exit code. */
export function setupInstallerShell(argv: readonly string[]): string {
  return (
    `${shellCommand(argv)}\n` +
    `status=$?\n` +
    `printf '\\n[installer exited %s] press enter to close ' "$status"\n` +
    `read -r _\n`
  );
}

/** Resolve one browser selection into a daemon-owned visible-terminal launch. */
export async function executeSetupInstall(
  body: SetupTerminalInstallerLaunchBody,
  deps: SetupInstallExecutionDeps,
): Promise<SetupInstallResponse> {
  const info = deps.catalog[body.id];
  const remedy = info.remedy;

  let launch: TerminalLaunchSpec;
  switch (remedy.kind) {
    case "link":
      return refused(body.id, info.label, "This setup remedy opens a link and has no command to run.");
    case "skill":
      return refused(body.id, info.label, "This setup remedy is a skill command and must run inside a session.");
    case "service":
      // A service starts in the daemon, not in a window. `POST /api/setup/service` owns it,
      // and this route will not open a terminal that has nothing to show.
      return refused(body.id, info.label, "This setup remedy starts a background service and opens no terminal.");
    case "provider-installer": {
      const repoRoots = await deps.listRepoRoots();
      const installers = await deps.listProviderInstallers(remedy.provider, repoRoots);
      if (!installers.supported || !installers.runtime) {
        return refused(body.id, info.label, installers.detail);
      }
      if (!installers.runtime.supported) {
        return refused(body.id, info.label, installers.runtime.detail);
      }
      if (installers.candidates.length === 0) {
        return refused(body.id, info.label, installers.detail);
      }
      if (installers.candidates.length > 1) {
        return refused(
          body.id,
          info.label,
          "Multiple verified installer checkouts were found. Open Conductor settings to choose and run one explicitly.",
        );
      }
      const checkout = installers.candidates[0]!.checkout;
      const prepared = await deps.prepareProviderInstaller(
        remedy.provider,
        checkout,
        repoRoots,
      );
      if (!prepared.ok) return refused(body.id, info.label, prepared.error);
      const argv = [
        FIXED_OS_EXECUTABLES.env,
        ...Object.entries(prepared.terminalEnv).map(([name, value]) => `${name}=${value}`),
        ...prepared.argv,
      ];
      launch = {
        name: prepared.title,
        cwd: prepared.cwd,
        argv: [FIXED_OS_EXECUTABLES.sh, "-c", setupInstallerShell(argv)],
      };
      break;
    }
    case "command":
      if (!isSetupInstallArgv(remedy.argv)) {
        return refused(
          body.id,
          info.label,
          "This catalog command is outside Mission Control's approved install grammar.",
        );
      }
      launch = {
        name: `Install ${info.label}`,
        cwd: deps.homeDir,
        argv: [FIXED_OS_EXECUTABLES.sh, "-c", setupInstallerShell(remedy.argv)],
      };
      break;
  }

  const result = await deps.launchTerminal(body.backend, launch);
  if (result.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        id: body.id,
        outcome: "opened",
        label: result.label,
        detail: `${result.label} opened the installer. Watch it finish and read its exit code in that window.`,
      },
    };
  }
  const status = result.status as 404 | 409 | 502 | 504;
  return {
    status,
    body: {
      ok: false,
      id: body.id,
      outcome: status === 504 ? "maybe-opening" : "refused",
      label: result.label,
      detail: result.error ?? `${result.label} could not open the installer terminal.`,
    },
  };
}

export const DEFAULT_SETUP_INSTALL_CATALOG = SETUP_DEPENDENCY_INFO;
