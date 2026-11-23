// Session-control helpers shared by the delegated-control specs: dispatch a faked agent, and
// speak to Mission Control's MCP server exactly as that session's own agent does.
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect } from "@playwright/test";
import type { Session } from "../../src/shared/types.ts";
import { argvValue, recordsIn } from "./records.ts";
import type { DaemonHandle } from "./daemon.ts";

export async function api(daemon: DaemonHandle, path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return response.json();
}

export async function dispatch(daemon: DaemonHandle, name: string, repoRoot = daemon.repo): Promise<Session> {
  const before: Session[] = await api(daemon, "/api/sessions");
  await api(daemon, "/api/tasks", { repoRoot, intent: `write a haiku about ${name}`, title: name, kind: "ship", agent: "claude", workflowId: null });
  let session: Session | undefined;
  await expect.poll(async () => {
    const all: Session[] = await api(daemon, "/api/sessions");
    session = all.find((s) => !before.some((previous) => previous.id === s.id) && s.agentSessionId && s.state === "idle");
    return !!session;
  }).toBe(true);
  await api(daemon, `/api/sessions/${encodeURIComponent(session!.id)}/rename`, { name });
  return session!;
}

/** Use the actual MCP descriptor the fake agent received, including its private locator. */
export async function connect(daemon: DaemonHandle, session: Session): Promise<Client> {
  let descriptor: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => {
    const records = recordsIn<{ cwd: string; argv: string[] }>(join(daemon.recordDir, "claude"));
    for (const record of records.filter((r) => r.cwd === session.cwd)) {
      const raw = argvValue(record.argv, "--mcp-config");
      if (raw) descriptor = JSON.parse(raw).mcpServers?.["mission-control"];
      if (descriptor) break;
    }
    return !!descriptor;
  }).toBe(true);
  const client = new Client({ name: "session-control-e2e", version: "1" });
  await client.connect(new StdioClientTransport({
    command: descriptor!.command, args: descriptor!.args,
    cwd: session.cwd!, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...descriptor!.env },
    stderr: "pipe",
  }));
  return client;
}
