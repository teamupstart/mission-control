# Phase 1: multimodal runner foundation

## Outcome

Give Mission Control's headless Claude and Codex runners one safe, provider-neutral way to receive immutable raster images. This phase creates no workflow or dashboard surface yet. Its value is a reviewed transport contract that Phase 2 can use without mixing provider protocol work into storage and workflow state changes.

## Entry criteria and direct dependencies

- The approved source plan and phased index are present on the default branch.
- Direct dependency: the planning session that publishes these documents.
- No implementation-phase dependency.

## Scope

- Add an optional image descriptor list to `LlmRunOptions` in `src/shared/llm.ts`.
- Validate local image descriptors before provider invocation.
- Encode repeated image arguments for Codex headless execution.
- Encode image blocks for Claude SDK one-shots and Claude print one-shots.
- Count attached bytes alongside prompt bytes where a call site records its own request size.
- Establish conservative provider-compatible workflow image limits through focused compatibility checks.
- Add focused unit and adapter tests, including exact text-only regressions.

## Explicit non-goals

- No workflow evidence schema, SQLite table, capture path, fingerprint change, or Persona citation kind.
- No dashboard upload, workflow route, run-detail UI, MCP tool, retention behavior, or documentation for end users.
- No filesystem tools or other tool grants for reviewers.

## Repository findings and inherited contracts

- `LlmRunner.run(prompt, opts)` is the only provider-neutral fresh-context entry point. `LlmRunOptions` is browser-safe shared TypeScript and cannot import `node:` modules.
- Codex headless argv is owned by `src/server/llm/codex.ts`. The installed CLI supports repeatable `codex exec --image <FILE>` arguments.
- `src/server/llm/claude.ts` owns both transport selection and the print one-shot path. There is no separate `claude-cli.ts` file.
- `src/server/llm/claude-sdk.ts` builds the SDK one-shot input. Existing embedded interactive adapters already demonstrate valid provider image block shapes, but this phase must not couple headless calls to session state.
- Every run starts from empty context, inherits no terminal identity, uses no tools unless explicitly granted, and must continue to honor structured output, budgets, timeout, and spend reporting.

## Implementation steps

1. Define the smallest immutable image descriptor in `src/shared/llm.ts`. Include stable evidence id, absolute local path, sniffed MIME type, byte count, and SHA-256. Keep `images` optional and readonly so all existing callers remain unchanged.
2. Add a server-side validator shared by the headless adapters. Open each path as a regular file without following a swapped symlink where the platform permits, verify size and digest against the descriptor, confirm the MIME signature through the existing image sniffer, and fail with a bounded diagnostic before spawning a provider.
3. In `src/server/llm/codex.ts`, append one `--image` argument per validated descriptor in input order. Preserve the current sandbox, approval, schema, model, timeout, output parsing, and environment behavior.
4. In `src/server/llm/claude-sdk.ts`, emit a single user message whose ordered content contains each validated base64 image block followed by the existing text prompt. Keep the fresh process/session and max-turn contract.
5. In the print branch in `src/server/llm/claude.ts`, use one `stream-json` user message carrying the same image blocks and text. Do not add resume or continuation flags and do not weaken structured-output parsing.
6. Keep provider-neutral code responsible for validation and ordering, while each adapter owns only its provider encoding. Avoid a second image MIME registry.
7. Run a bounded compatibility probe against the installed Claude and Codex transports. Record the chosen supported MIME set, maximum image count, per-image limit, aggregate-byte limit, and any base64 overhead assumption in a shared constant module or contract test that Phase 2 can import. Do not spend production model tokens in automated tests.
8. Extend request-byte accounting helpers so callers can add validated image bytes without embedding base64 or file paths in persisted prompt text. Preserve provider-reported token and cost data as authoritative.

## Data, API, and compatibility details

- The descriptor is an internal runner option, not a browser wire schema and not durable workflow state.
- An omitted or empty image list must produce the exact previous provider input shape.
- Unsupported MIME, missing file, changed bytes, size mismatch, digest mismatch, and aggregate overflow are infrastructure errors. No adapter may ignore one image and continue.
- Diagnostics may name the stable evidence id and bounded basename but must not log base64, image bytes, or sensitive absolute paths.
- Keep the list order stable across validation, provider encoding, and any observer accounting.

## Tests and verification

Add or extend focused tests covering:

- `test/llm-runner-contract.test.ts` for optional descriptor shape and text-only compatibility.
- `test/codex-usage.test.ts` or the closest Codex adapter contract test for repeated ordered `--image` arguments and pre-spawn refusal.
- `test/claude-sdk-oneshot.test.ts` for ordered image blocks followed by text, bounded base64, and unchanged text-only messages.
- `test/claude-cli-headless-env.test.ts` or a focused Claude print transport test for one fresh `stream-json` message, no resume identity, and unchanged environment isolation.
- MIME, regular-file, size, digest, symlink, and aggregate-limit failures in the shared validator.

Run at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/llm-runner-contract.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/claude-sdk-oneshot.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/claude-cli-headless-env.test.ts
npm run typecheck
npm run lint
npm run build
npm run smoke
```

Add the closest focused Codex test command selected during implementation. If runtime provider compatibility is checked manually, report only counts, formats, and verdicts in the pull request, never credentials or image contents.

## Merge and exit criteria

- Both configured providers accept the same validated descriptor contract.
- Image-bearing calls fail closed before provider launch on bad input.
- Text-only callers produce their former argv and message shapes.
- Focused tests, typecheck, lint, build, and smoke pass.
- The pull request documents the final conservative image limits that Phase 2 must enforce.

## Downstream handoff

Phase 2 may rely on the optional runner image list, ordered transport, validator, and final limits. It must not fork provider-specific descriptor shapes or bypass the validator. Phase 2 owns durable workflow metadata and can name additional display fields without changing the runner contract.

## Cross-phase audit record

- 2026-08-15: Corrected the source plan's nonexistent `src/server/llm/claude-cli.ts` path to the live print branch in `src/server/llm/claude.ts`.
- 2026-08-15: Kept image limits in this phase because provider transport compatibility must be known before Phase 2 exposes durable intake.
- 2026-08-15: Confirmed this foundation can merge unused without changing any current workflow or text-only model call.
