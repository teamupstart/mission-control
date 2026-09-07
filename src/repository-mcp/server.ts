import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  REPOSITORY_MCP_SERVER_NAME,
  RepositoryBudgetsSchema,
  RepositoryToolInputSchemas,
  RepositoryViewDescriptorSchema,
} from "@shared/repository-access.ts";
import type { RepositoryOperationId, RepositoryQueryAuditMetadata } from "@shared/repository-access.ts";
import { RepositoryReader } from "../server/repository/reader.ts";
import { REPOSITORY_MCP_CONFIG_ENV } from "./config.ts";

const RuntimeConfigSchema = z.object({
  schemaVersion: z.literal(1),
  descriptor: RepositoryViewDescriptorSchema,
  workloadId: z.string().min(1).max(256),
  workflowAttemptId: z.string().min(1).max(256),
  budgets: RepositoryBudgetsSchema,
  cursorSecret: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),
  auditPath: z.string().min(1).max(4_096),
}).strict();

const configPath = process.env[REPOSITORY_MCP_CONFIG_ENV];
if (!configPath) throw new Error(`${REPOSITORY_MCP_CONFIG_ENV} is required`);
const configHandle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let configText: string;
try {
  const configStat = await configHandle.stat();
  if (!configStat.isFile() || (configStat.mode & 0o077) !== 0) {
    throw new Error("repository MCP config must be a private regular file");
  }
  configText = await configHandle.readFile("utf8");
} finally {
  await configHandle.close();
}
const config = RuntimeConfigSchema.parse(JSON.parse(configText));

const reader = new RepositoryReader({
  descriptor: config.descriptor,
  identity: { workloadId: config.workloadId, workflowAttemptId: config.workflowAttemptId },
  budgets: config.budgets,
  cursorSecret: Buffer.from(config.cursorSecret, "base64url"),
  audit: {
    async append(metadata: RepositoryQueryAuditMetadata, signal: AbortSignal) {
      await writeFile(config.auditPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600, flag: "a", signal });
    },
  },
});

const descriptions: Record<RepositoryOperationId, string> = {
  read: "Read one approved repository file or symlink target through a bounded line or raw-byte window.",
  search: "Search approved repository text for one literal string.",
  glob: "List approved manifest paths matching one repository-relative glob.",
  git_status: "List the exact captured status from the immutable repository manifest.",
  git_diff: "Read a bounded diff across one approved pair of captured repository layers.",
  git_show: "Read fixed commit metadata and an optional bounded retained-history patch.",
  git_log: "List fixed metadata for revisions in the descriptor-retained history only.",
  git_blame: "Read bounded blame metadata for an approved file in retained history.",
};

const server = new McpServer({ name: REPOSITORY_MCP_SERVER_NAME, version: "1.0.0" });
for (const operation of Object.keys(RepositoryToolInputSchemas) as RepositoryOperationId[]) {
  server.registerTool(
    operation,
    { title: operation, description: descriptions[operation], inputSchema: RepositoryToolInputSchemas[operation].shape },
    async (input: Record<string, unknown>, extra: { signal: AbortSignal }) => {
      const result = await reader.execute({ operation, ...input }, extra.signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: result.status !== "ok",
      };
    },
  );
}

await server.connect(new StdioServerTransport());
