import { PersonaWorkloadRequestSchema, parseRepositoryWorkloadVerdict, type PersonaWorkloadResult } from "@shared/repository-access.ts";
import { ProviderFailure } from "../server/llm/provider-failure.ts";
import { REPOSITORY_PROVIDERS, RepositoryCapabilityError, type RepositoryProviderLaunch } from "../server/workflows/persona-workload/providers.ts";

// The daemon sends one request through the supervisor's private stdin after recording its identity.
let result: PersonaWorkloadResult;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input: Pick<RepositoryProviderLaunch, "request" | "binary" | "mcp"> = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const request = PersonaWorkloadRequestSchema.parse(input.request);
  const output = await REPOSITORY_PROVIDERS[request.execution.provider]({
    ...input, request, cwd: process.cwd(), env: process.env as Record<string, string>,
    signal: AbortSignal.timeout(Math.max(1, request.deadline - Date.now())),
  });
  const verdict = parseRepositoryWorkloadVerdict(request.accounting.purpose, output.verdict);
  const accounting = { usage: output.usage, ...(output.providerRunId ? { providerRunId: output.providerRunId } : {}) };
  result = verdict.success ? { status: "completed", result: verdict.data, ...accounting }
    : { status: "failed", code: "invalid_verdict", ...accounting };
} catch (error) {
  result = error instanceof ProviderFailure ? { status: "failed", code: "provider_unavailable", providerFailure: error.kind }
    : error instanceof RepositoryCapabilityError ? { status: "failed", code: "capability_mismatch", capabilityReason: error.reason }
    : { status: "failed", code: "provider_unavailable" };
}
process.stdout.write(JSON.stringify(result));
