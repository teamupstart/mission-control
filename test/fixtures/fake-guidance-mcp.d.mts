import type { IncomingHttpHeaders } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export function createGuidanceServer(mode?: string, args?: string[]): Server;

export interface GuidanceHttpServer {
  url: string;
  requests: Array<{ method: string; headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}

export function startGuidanceHttp(options?: { mode?: string; args?: string[]; json?: boolean }): Promise<GuidanceHttpServer>;
