import { readFile, appendFile, writeFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  REPOSITORY_OPERATION_IDS,
  RepositoryOperationSchemas,
  RepositoryViewDescriptorSchema,
  RepositoryBudgetsSchema,
} from "../shared/repository-access.ts";
import { createRepositoryReader } from "../server/workflows/persona-workload/reader.ts";

const LaunchSchema = z.strictObject({
  view: RepositoryViewDescriptorSchema,
  objectDirectory: z.string(),
  gitBinary: z.string(),
  workloadId: z.string(),
  attemptId: z.string(),
  budgets: RepositoryBudgetsSchema,
  auditPath: z.string(),
  deadline: z.number().int().positive(),
});
const launch = LaunchSchema.parse(
  JSON.parse(await readFile(process.env.REPOSITORY_MCP_DESCRIPTOR!, "utf8")),
);
if (launch.deadline <= Date.now()) throw Error("Expired repository workload");
const controller = new AbortController();
const timer = setTimeout(() => {
  shutdown();
}, launch.deadline - Date.now());
let auditHealthy = true,
  auditCount = 0;
const auditHash = createHash("sha256");
const reader = createRepositoryReader({
  ...launch,
  signal: controller.signal,
  audit: async (metadata) => {
    const line = JSON.stringify(metadata) + "\n";
    try {
      await appendFile(launch.auditPath, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      auditHash.update(line);
      auditCount++;
    } catch (error) {
      auditHealthy = false;
      throw error;
    }
  },
});
const server = new Server(
  { name: "repository", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: REPOSITORY_OPERATION_IDS.map((operation) => ({
    name: operation,
    description: `Read-only captured repository operation: ${operation}`,
    inputSchema: z.toJSONSchema(RepositoryOperationSchemas[operation], {
      io: "input",
    }) as Tool["inputSchema"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const operation = z
    .enum(REPOSITORY_OPERATION_IDS)
    .safeParse(request.params.name);
  if (!operation.success)
    return {
      isError: true,
      content: [{ type: "text", text: "Unknown repository operation" }],
    };
  const result = await reader.query(
    operation.data,
    request.params.arguments ?? {},
    extra.signal,
  );
  if (auditCount >= launch.budgets.attemptCalls || !auditHealthy)
    setImmediate(shutdown);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  controller.abort();
  clearTimeout(timer);
  await reader.drain();
  await server.close();
  if (auditHealthy)
    await writeFile(
      launch.auditPath + ".seal",
      JSON.stringify({
        workloadId: launch.workloadId,
        attemptId: launch.attemptId,
        count: auditCount,
        sha256: auditHash.digest("hex"),
      }),
      { mode: 0o600 },
    );
}
const shutdown = () => {
  void close().catch(() => {
    process.exitCode = 1;
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.stdin.once("end", shutdown);
await server.connect(new StdioServerTransport());
