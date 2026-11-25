import type { IncomingHttpHeaders } from "node:http";

export interface FakeOAuthRequest {
  server: "resource" | "issuer" | "elsewhere";
  method: string;
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeOAuthModes {
  refresh: "ok" | "invalid_grant" | "invalid_client" | "503" | "close";
  registration: "ok" | "secret" | "refuse" | "auth-method";
  metadata: "ok" | "wrong-issuer" | "foreign-endpoint" | "no-s256" | "no-registration" | "no-code";
  resourceMetadata: "ok" | "none" | "foreign-issuer" | "wrong-resource";
  shape: "ok" | "echo" | "error" | "unauthorized";
  stall: string | null;
  oversize: string | null;
  redirect: string | null;
  iss: boolean | string;
  tokens: "full" | "no-refresh" | "no-expiry" | "no-scope";
  revoke: "ok" | "400" | "429" | "503" | "close";
}

export interface FakeOAuthServer {
  resourceUrl: string;
  shapeUrl: string;
  issuer: string;
  elsewhereUrl: string;
  requests: FakeOAuthRequest[];
  setMode(patch: Partial<FakeOAuthModes>): void;
  resetModes(): void;
  /** Holds every request to `path` until the returned function is called. */
  hold(path: string): () => void;
  close(): Promise<void>;
}

export function startFakeOAuthServer(options?: { separateIssuer?: boolean }): Promise<FakeOAuthServer>;
