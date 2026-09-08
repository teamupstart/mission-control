import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { CodexPersonaWorkloadAdapter } from "../src/server/workflows/persona-workload/codex.ts";
import { LocalPersonaWorkloadExecutor } from "../src/server/workflows/persona-workload/executor.ts";
import { providerModelDefault } from "../src/shared/model.ts";
import {
  DEFAULT_REPOSITORY_BUDGETS,
  REPOSITORY_EVIDENCE_PROTOCOL,
  REPOSITORY_HISTORY_POLICY_V1,
  type PersonaWorkloadEvent,
  type PersonaWorkloadRequest,
} from "../src/shared/repository-access.ts";
import { repositoryViewFixture } from "./helpers/repository-view.ts";

const PACKAGE_LOCAL_CODEX = /(?:^|[\\/])node_modules[\\/]\.bin[\\/]codex$/;

function installedCodexExecutable(): string {
  const configured = process.env.MISSION_CODEX_BIN?.trim();
  if (configured) return configured;
  const found = execFileSync("which", ["-a", "codex"], { encoding: "utf8" })
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && !PACKAGE_LOCAL_CODEX.test(candidate) && existsSync(candidate));
  if (!found) throw new Error("installed Codex provider not found outside package-local dependencies");
  return found;
}

// npm prepends node_modules/.bin to this test worker. Pin the actual installed provider
// through the daemon's canonical executable override so the live gate exercises the operator's
// authenticated Codex rather than the SDK dependency bundled by this repository.
process.env.MISSION_CODEX_BIN = installedCodexExecutable();

const modelForCodex = (): string => {
  const configured = process.env.MISSION_PERSONA_PARITY_CODEX_MODEL?.trim();
  return configured || providerModelDefault("codex", "cheap");
};

function liveRequest(
  artifactDigest: string,
): PersonaWorkloadRequest {
  const nonce = `${process.pid}-${Date.now()}`;
  return {
    schemaVersion: 1,
    workloadId: `live-parity-codex-${nonce}`,
    workflowAttemptId: `live-attempt-codex-${nonce}`,
    submissionId: `live-submission-codex-${nonce}`,
    idempotencyKey: `live-key-codex-${nonce}`,
    persona: {
      id: "live-provider-parity",
      name: "Provider parity verifier",
      description: "Verifies the isolated repository MCP process boundary.",
      guidance: "Follow the required repository operations exactly.",
    },
    provider: "codex",
    model: modelForCodex(),
    prompt: [
      "This is an integration verification of the isolated repository MCP.",
      "Before returning a verdict, make both of these tool calls in this one session:",
      "1. Call the repository read tool for source.txt, worktree layer, with a line window starting at line 1 and maxLines 2.",
      "2. Call the repository git_status tool.",
      "Do not use hosted search or any provider-native repository, filesystem, shell, write, or network tool.",
      "After both repository calls succeed, return a pass verdict with a concise summary and approval reason.",
    ].join("\n"),
    images: [],
    textEvidence: [],
    artifactLocator: "fixture-artifact",
    artifactDigest,
    historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
    budgets: DEFAULT_REPOSITORY_BUDGETS,
    deadline: Date.now() + 8 * 60_000,
    cancellationGeneration: 0,
    repositoryEvidenceProtocol: REPOSITORY_EVIDENCE_PROTOCOL,
    hostedSearchMaximum: "cached",
    llmCall: { callId: `live-call-codex-${nonce}`, purpose: "persona_review", attempt: 1 },
  };
}

test("installed Codex completes multiple repository MCP calls in one workload session", { timeout: 9 * 60_000 }, async () => {
  const fixture = repositoryViewFixture();
  let releases = 0;
  const executor = new LocalPersonaWorkloadExecutor({
    materializer: {
      async materialize() {
        return {
          descriptor: fixture.descriptor,
          async release() {
            releases += 1;
          },
        };
      },
    },
    providers: {
      claude: {
        id: "claude",
        async run() {
          throw new Error("the blocking live parity gate must not launch Claude");
        },
      },
      codex: new CodexPersonaWorkloadAdapter(),
    },
    repositoryMcpEntrypoint: resolve("dist/repository-mcp/server.mjs"),
  });

  try {
    const events: PersonaWorkloadEvent[] = [];
    for await (const event of executor.dispatch(
      liveRequest(fixture.descriptor.snapshotDigest),
      new AbortController().signal,
    )) {
      events.push(event);
    }

    assert.equal(events.filter((event) => event.kind === "provider_started").length, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.kind, "completed");
    if (terminal?.kind !== "completed") throw new Error("Codex produced no terminal result");
    assert.equal(
      terminal.result.kind,
      "succeeded",
      terminal.result.kind === "failed" ? `codex: ${terminal.result.message}` : undefined,
    );
    if (terminal.result.kind !== "succeeded") return;

    const queries = events.filter((event) => event.kind === "repository_query");
    assert.ok(queries.length >= 2, `Codex completed only ${queries.length} repository MCP calls`);
    assert.ok(queries.some((event) => event.audit.operation === "read"), "Codex did not call repository read");
    assert.ok(queries.some((event) => event.audit.operation === "git_status"), "Codex did not call repository git_status");
    assert.ok(queries.every((event) => event.audit.status === "ok"));
    assert.equal(terminal.result.verdict.verdict, "pass");
    assert.ok(terminal.result.llmCall.inputBytes > 0);
    assert.ok(terminal.result.llmCall.outputBytes > 0);
    assert.ok(terminal.result.llmCall.providerUsage);
    assert.equal(releases, 1);
    console.log(`[live-provider-parity] ${JSON.stringify({
      provider: "codex",
      model: modelForCodex(),
      sessionStarts: 1,
      repositoryCalls: queries.map((event) => event.audit.operation),
      verdict: terminal.result.verdict.verdict,
      usageAccounted: true,
    })}`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
