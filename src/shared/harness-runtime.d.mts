// Hand-written types for harness-runtime.mjs so the TypeScript consumers
// (src/server/config.ts, src/mcp/server.ts, vite.config.ts) can import it.

export function envVar(suffix: string): string | undefined;

export const PORT: number;
export const HOST: string;
export const BASE_URL: string;

export const STATE_DIRS: readonly string[];
export function stateDir(): string;
export function migrateStateDir(): { from: string; to: string } | null;
export function tokenPath(): string;
export function readToken(): string;
export function ensureToken(): string;
export const SCOUT_SUBMISSION_CREDENTIAL_HEADER: string;
export const MISSION_SESSION_ID_ENV: string;
export function scoutSubmissionCredentialPath(cwd: string): string;
export function readScoutSubmissionCredential(cwd: string): string;

export interface TerminalEnv {
  tmuxPane: string | undefined;
  weztermPane: string | undefined;
  termProgram: string | undefined;
}

export function captureTerminalEnv(): TerminalEnv;
