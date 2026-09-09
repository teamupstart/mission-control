#!/usr/bin/env node
/**
 * RPC-only stand-in for Pi model discovery.
 *
 * This fake deliberately does not implement a Pi session. The only accepted invocation is
 * the exact prompt-free, offline, no-session catalog probe owned by Phase 1. Any other argv
 * or command exits non-zero so a future browser spec cannot accidentally turn this fixture
 * into permission to launch Pi or contact a provider.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const EXPECTED_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-tools",
  "--no-approve",
];
const argv = process.argv.slice(2);
const recordDir = process.env.MC_E2E_RECORD_DIR;
const recordPath = recordDir
  ? join(recordDir, "pi", `invocation-${Date.now()}-${process.pid}.json`)
  : null;

function record(request = null) {
  if (!recordPath) return;
  mkdirSync(join(recordDir, "pi"), { recursive: true });
  writeFileSync(
    recordPath,
    JSON.stringify({ argv, cwd: process.cwd(), request }, null, 2),
  );
}

function fail(message, code = 64) {
  record();
  process.stderr.write(`fake-pi: ${message}\n`);
  process.exit(code);
}

if (JSON.stringify(argv) !== JSON.stringify(EXPECTED_ARGS)) {
  fail(`refusing non-catalog invocation: ${JSON.stringify(argv)}`);
}

let handled = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (handled) fail("refusing more than one RPC command");
  handled = true;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail("catalog command was not JSON");
  }
  record(request);
  if (
    !request ||
    typeof request.id !== "string" ||
    request.type !== "get_available_models" ||
    Object.keys(request).sort().join(",") !== "id,type"
  ) {
    fail(`refusing unsupported RPC command: ${JSON.stringify(request)}`);
  }

  let mode = "failure";
  try {
    mode = readFileSync(process.env.MC_E2E_PI_CATALOG_CONTROL, "utf8").trim();
  } catch {
    // Missing control is a loud provider-boundary failure, never an implicit success.
  }
  // A Pi with no provider credentials is not a failed probe: it answers, successfully,
  // with an empty list and exits 0. Measured against pi 0.84.2 by running the real binary
  // with an empty HOME. That is the one outcome the daemon can read as "signed out", so
  // the fake has to be able to produce it exactly rather than as a scripted crash.
  if (mode === "signed-out") {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models: [] },
    })}\n`);
    process.exit(0);
  }
  if (mode !== "success") {
    process.stderr.write("fake-pi: scripted catalog failure\n");
    process.exit(17);
  }

  process.stdout.write(`${JSON.stringify({
    id: request.id,
    type: "response",
    command: "get_available_models",
    success: true,
    data: {
      models: [
        {
          provider: "openai",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          contextWindow: 1_000_000,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          contextWindow: 1_000_000,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          provider: "openai",
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          contextWindow: 272_000,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          provider: "openrouter",
          id: "meta-llama/llama-4-maverick",
          name: "Llama 4 Maverick",
          contextWindow: 1_000_000,
          reasoning: false,
          input: ["text", "image"],
        },
      ],
    },
  })}\n`);
  process.exit(0);
});

input.on("close", () => {
  if (!handled) fail("catalog probe closed without an RPC command");
});
