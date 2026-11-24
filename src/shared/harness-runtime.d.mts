// Hand-written types for harness-runtime.mjs so the TypeScript consumers
// (src/server/config.ts, src/mcp/server.ts, vite.config.ts) can import it.

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export function envVar(suffix: string, env?: RuntimeEnvironment): string | undefined;
export function runtimePort(env?: RuntimeEnvironment): number;

export const PORT: number;
export const HOST: string;
export const BASE_URL: string;

export const STATE_DIRS: readonly string[];
export function stateDir(env?: RuntimeEnvironment): string;
export function migrateStateDir(): { from: string; to: string } | null;
export function desktopVoiceEndpointPath(home?: string, port?: number): string;
export function tokenPath(env?: RuntimeEnvironment): string;
export const MISSION_API_TOKEN_ENV: string;
export const MISSION_API_TOKEN_FILE_ENV: string;
export function readToken(env?: RuntimeEnvironment): string;
export function readClientToken(env?: RuntimeEnvironment): string;
export function ensureToken(): string;
export const SCOUT_SUBMISSION_CREDENTIAL_HEADER: string;
export const SCOUT_SUBMISSION_CREDENTIAL_ENV: string;
export const SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV: string;
export const SCOUT_SESSION_LOCATOR_ENV: string;
export const MISSION_SESSION_ID_ENV: string;
export const MISSION_AGENT_SESSION_ID_ENV: string;
export function scoutSubmissionCredentialPath(cwd: string): string;
export function isolatedScoutSubmissionCredentialPath(cwd: string): string;
export function readScoutSubmissionCredential(cwd: string): string;
export function sessionScoutCredentialDirectory(): string;
export function sessionScoutCredentialPath(identity: string): string;
export function readSessionScoutSubmissionCredential(cwd: string): string;

export interface TerminalEnv {
  tmuxPane: string | undefined;
  weztermPane: string | undefined;
  itermSession: string | undefined;
  termProgram: string | undefined;
}

export function captureTerminalEnv(): TerminalEnv;
