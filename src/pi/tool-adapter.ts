import type { McpClient, McpTool } from "./mcp-client.ts";
import type { PiTool } from "./api.ts";

export function adaptTool(tool: McpTool, client: () => McpClient | null): PiTool {
  return {
    name: tool.name, label: tool.name,
    description: tool.description ?? tool.name,
    promptSnippet: `Mission Control: ${tool.name}`,
    parameters: tool.inputSchema,
    async execute(_id, args, signal) {
      const connection = client();
      if (!connection) throw new Error("Mission Control tools are unavailable in this session");
      const result = await connection.call(tool.name, args, signal);
      if (result.isError) throw new Error(result.content.map((block) => block.text).join("\n"));
      return { content: result.content, details: {} };
    },
  };
}
