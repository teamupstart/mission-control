// Hand-written types for harness-runtime.mjs so the TypeScript consumers
// (src/server/config.ts, src/mcp/server.ts, vite.config.ts) can import it.

export function envVar(suffix: string): string | undefined;

export const PORT: number;
export const HOST: string;
export const BASE_URL: string;
export const LEASE_HOLDER: string;

export function stateDir(): string;
export function tokenPath(): string;
export function readToken(): string;

export interface TerminalEnv {
  tmuxPane: string | undefined;
  weztermPane: string | undefined;
  termProgram: string | undefined;
}

export function captureTerminalEnv(): TerminalEnv;
