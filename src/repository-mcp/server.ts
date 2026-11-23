import { readFile, appendFile, writeFile, rename } from "node:fs/promises";
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
  type RepositoryOperation,
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
const descriptions: Record<RepositoryOperation, string> = {
  read: "Read lines or base64-encoded bytes from a worktree or index path, starting at a zero-based offset.",
  search: "Find literal text in worktree files matching a glob and return matching lines with optional surrounding context.",
  glob: "List worktree paths matching a glob, including each entry's kind and binary flag.",
  git_status: "List captured status classifications such as staged, unstaged, or untracked for paths matching a glob.",
  git_diff: "Compare a captured pair of layers and return patch hunks or change metadata, optionally limited to specific paths.",
  git_show: "Show a retained commit's message, tree, and parents. Request a patch to include its changes against its first parent, or an empty tree for a root commit.",
  git_log: "List retained commits reachable from the selected revision, optionally filtered by path.",
  git_blame: "Show which commit last changed each requested line of a file at a retained revision. Line numbers start at one and the end is exclusive.",
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: REPOSITORY_OPERATION_IDS.map((operation) => ({
    name: operation,
    description: descriptions[operation],
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
  if (auditHealthy) {
    const seal = launch.auditPath + ".seal";
    // The supervisor may already be polling. Only publish the complete seal.
    await writeFile(
      seal + ".tmp",
      JSON.stringify({
        workloadId: launch.workloadId,
        attemptId: launch.attemptId,
        count: auditCount,
        sha256: auditHash.digest("hex"),
      }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(seal + ".tmp", seal);
  }
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
