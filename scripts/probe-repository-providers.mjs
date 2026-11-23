// Explicit opt-in executable feasibility gate. All model responses come from localhost fixtures.
import { execFileSync } from "node:child_process";
import { providerJsonSchema } from "../src/server/llm/json-schema.ts";
import { assertStrictJsonSchema } from "../test/helpers/strict-json-schema.ts";
import { Codex } from "@openai/codex-sdk";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  initializeExecutableEnvironment,
  locateExecutable,
} from "../src/server/executables/locator.ts";
import { LocalPersonaWorkloadExecutor } from "../src/server/workflows/persona-workload/executor.ts";
import {
  REPOSITORY_PROVIDERS,
  REPOSITORY_TOOL_NAMES,
  runCodexRepositoryWorkload,
} from "../src/server/workflows/persona-workload/providers.ts";
import {
  PersonaWorkloadProviderResultSchema,
  REPOSITORY_HISTORY_POLICY_V1,
  REPOSITORY_DEFAULT_BUDGETS,
  REPOSITORY_OPERATION_IDS,
} from "../src/shared/repository-access.ts";

await initializeExecutableEnvironment();
const binaries = Object.fromEntries(
  await Promise.all(
    ["claude", "codex", "git"].map(async (name) => {
      const binary = await locateExecutable(name);
      assert.ok(binary, `${name} must be installed`);
      return [name, binary.path];
    }),
  ),
);
const verdict = {
  verdict: "pass",
  summary: "Fixture review",
  approvalDetails: { reason: "Fixture tools returned", evidence: [] },
  confidence: 1,
};
const modelResult = { result: { kind: "persona_verdict", verdict } };
const expectedSchema = providerJsonSchema(PersonaWorkloadProviderResultSchema);
assertStrictJsonSchema(expectedSchema, "repository provider result");
const view = {
  version: 1,
  snapshotDigest: "a".repeat(64),
  policyVersion: 1,
  objectView: "fixture",
  head: null,
  base: null,
  indexTree: "0".repeat(40),
  worktreeTree: "0".repeat(40),
  historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
  retainedRevisions: [],
  frontier: [],
  retainedCommitCount: 0,
  retainedBlobBytes: 0,
  worktree: [],
  index: [],
};
function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
}
for (const provider of process.argv.includes("--codex-only")
  ? ["codex"]
  : ["claude", "codex"])
  for (const cancel of process.argv.includes("--cancel-only") ? [true] : [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "repository-provider-proof-"));
    const data = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=",
      "base64",
    );
    const image = join(root, "proof.png");
    await writeFile(image, data);
    const git = (...args) =>
      execFileSync(binaries.git, args, {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
        },
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    git("add", "file.txt");
    git("commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD"),
      tree = git("rev-parse", "HEAD^{tree}"),
      blob = git("rev-parse", "HEAD:file.txt");
    const descriptor = {
      ...view,
      head,
      indexTree: tree,
      worktreeTree: tree,
      retainedRevisions: [{ id: head, tree, parents: [] }],
      retainedCommitCount: 1,
      retainedBlobBytes: 8,
      worktree: [
        {
          path: "file.txt",
          kind: "file",
          blob,
          binary: false,
          classifications: ["committed"],
        },
      ],
      index: [],
    };
    const queries = [
      { name: "read", input: { path: "file.txt", start: 1, length: 1 } },
      {
        name: "read",
        input: { path: "file.txt", unit: "byte", start: 1, length: 3 },
      },
      { name: "git_diff", input: { pair: "base_head" } },
      { name: "read", input: { path: ".env" } },
    ];
    let calls = 0,
      sawImage = false,
      released = false;
    const controller = new AbortController();
    let execution;
    const server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const part of req) raw += part;
        if (!raw) {
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        const body = JSON.parse(raw);
        if (!req.url.includes("responses") && !req.url.includes("messages")) {
          res.end("{}");
          return;
        }
        sawImage ||= JSON.stringify(body).includes(
          provider === "codex" ? '"input_image"' : '"image"',
        );
        if (cancel) {
          controller.abort();
          res.destroy();
          return;
        }
        if (provider === "claude") {
          const resultTool = body.tools.find(
            (tool) => tool.name === "StructuredOutput",
          );
          if (resultTool)
            assertStrictJsonSchema(
              resultTool.input_schema,
              "Claude outgoing result schema",
            );
          const names = body.tools
            .map((t) => t.name)
            .filter(
              (n) =>
                n !== "StructuredOutput" && n !== "DeferredToolPlaceholder",
            );
          assert.deepEqual(
            [...new Set(names)].sort(),
            [...REPOSITORY_TOOL_NAMES].sort(),
          );
          const name = queries[calls]
            ? "mcp__repository__" + queries[calls].name
            : "StructuredOutput";
          const input = queries[calls]?.input ?? modelResult;
          calls++;
          sse(res, [
            {
              type: "message_start",
              message: {
                id: `m${calls}`,
                type: "message",
                role: "assistant",
                model: body.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: `t${calls}`,
                name,
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(input),
              },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]);
        } else {
          assertStrictJsonSchema(
            body.text?.format?.schema,
            "Codex outgoing result schema",
          );
          const item =
            calls++ === 0
              ? {
                  type: "custom_tool_call",
                  id: "ct1",
                  call_id: "c1",
                  name: "exec",
                  namespace: "functions",
                  input: `if(typeof tools.apply_patch!=="undefined"||JSON.stringify(ALL_TOOLS.map(t=>t.name).sort())!==${JSON.stringify(JSON.stringify([...REPOSITORY_TOOL_NAMES].sort()))})throw Error("Capability leak");text({native:typeof tools.apply_patch,inventory:ALL_TOOLS.map(t=>t.name)});${queries.map((q) => `text(await tools.mcp__repository__${q.name}(${JSON.stringify(q.input)}));`).join("")}`,
                }
              : {
                  type: "message",
                  id: "final",
                  role: "assistant",
                  status: "completed",
                  phase: "final_answer",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(modelResult),
                      annotations: [],
                    },
                  ],
                };
          if (calls === 2) {
            const outputs = JSON.stringify(
              body.input.filter((i) => i.type === "custom_tool_call_output"),
            );
            assert.match(outputs, /undefined/);
            for (const name of REPOSITORY_TOOL_NAMES)
              assert.ok(outputs.includes(name), name);
            assert.match(outputs, /denied_path/);
          }
          sse(res, [
            { type: "response.output_item.added", output_index: 0, item },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `r${calls}`,
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]);
        }
      } catch (error) {
        console.error(error);
        controller.abort();
        res.destroy();
      }
    });
    try {
      await new Promise((yes, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", yes);
      });
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      execution = new LocalPersonaWorkloadExecutor({
        materializer: {
          materialize: async (identity) => ({
            identity,
            descriptor,
            objectDirectory: join(root, ".git"),
            release: async () => {
              released = true;
            },
          }),
        },
        repositoryMcpBundle: resolve("dist/repository-mcp/server.mjs"),
        nodeBinary: process.execPath,
        gitBinary: binaries.git,
        providerBinary: async () => binaries[provider],
        providerEnvironment: async () => ({}),
        providers: {
          ...REPOSITORY_PROVIDERS,
          [provider]: (launch) =>
            provider === "codex"
              ? runCodexRepositoryWorkload(launch, {
                  createClient: (options) =>
                    new Codex({
                      ...options,
                      baseUrl: endpoint + "/v1",
                      apiKey: "fixture",
                    }),
                })
              : REPOSITORY_PROVIDERS.claude({
                  ...launch,
                  env: {
                    ...launch.env,
                    ANTHROPIC_BASE_URL: endpoint,
                    ANTHROPIC_API_KEY: "fixture",
                  },
                }),
        },
      });
      const request = {
        version: 1,
        workloadId: "proof",
        attemptId: "attempt",
        submissionId: "submission",
        idempotencyKey: "proof",
        accounting: {
          callId: "call",
          runId: "run",
          purpose: "persona_review",
          attempt: 1,
        },
        persona: {
          sourcePersonaId: "fixture",
          sourceRevision: 1,
          name: "Fixture",
          description: "",
          guidanceMarkdown: "Fixture",
          runner: provider,
          model: null,
        },
        execution: {
          provider,
          model: provider === "codex" ? "gpt-6-sol" : "claude-sonnet-4-6",
        },
        prompt:
          "Use repository glob and read, then give the structured verdict.",
        images: [
          {
            id: "proof",
            path: image,
            mimeType: "image/png",
            bytes: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
        ],
        artifact: { locator: "fixture", digest: view.snapshotDigest },
        policy: { version: 1, operations: REPOSITORY_OPERATION_IDS },
        budgets: REPOSITORY_DEFAULT_BUDGETS,
        deadline: Date.now() + 45000,
        cancellationGeneration: 1,
        requiredCapability: "repository_evidence_v1",
      };
      const events = [];
      for await (const event of execution.dispatch(request, controller.signal))
        events.push(event);
      const terminal = events.at(-1);
      assert.equal(terminal.type, "terminal");
      assert.equal(
        terminal.result.status,
        cancel ? "failed" : "completed",
        JSON.stringify(terminal),
      );
      if (cancel) assert.equal(terminal.result.code, "cancelled");
      else {
        assert.equal(
          events.filter((e) => e.type === "repository_query").length,
          4,
        );
        assert.deepEqual(terminal.result.result.verdict, verdict);
      }
      if (!cancel) {
        const ranges = events
          .filter((e) => e.type === "repository_query")
          .flatMap((e) => e.audit.handles.map((h) => h.range));
        assert.deepEqual(ranges, [
          { kind: "line", startLine: 2, endLineExclusive: 3 },
          { kind: "byte", startByte: 1, endByteExclusive: 4, encoding: "raw" },
          {
            kind: "diff",
            oldStartLine: 1,
            oldEndLineExclusive: 1,
            newStartLine: 1,
            newEndLineExclusive: 3,
          },
        ]);
      }
      assert.ok(sawImage, "native image input reached the fixture provider");
      assert.ok(released);
      console.log(
        JSON.stringify({
          provider,
          cancel,
          imagePreserved: sawImage,
          modelRequests: calls,
          auditQueries: events.filter((e) => e.type === "repository_query")
            .length,
          terminal: terminal.result.status,
          leaseReleased: released,
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    }
  }
