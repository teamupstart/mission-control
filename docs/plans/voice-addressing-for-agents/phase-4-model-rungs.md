# Phase 4: the model step

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V13, V15 and V44. Mock-ups: `mockup-voice-settings.html`,
`mockup-routing-exceptions.html`.

## 1. Outcome

An ambiguous utterance is settled by a model: a decision model when a provider has been selected
and has a key, otherwise Haiku or Luna. One sentence can be split across two agents. The key is
entered in Voice settings. A key in the environment selects nothing by itself.

## 2. Entry criteria

Phases 0 and 3 are merged.

## 3. Scope and non-goals

In scope: contract E, the two provider adapters, key storage and its settings rows, the
`voice-routing` job, split or mention, docs and tests. Not in scope: the card that shows the result
(Phase 6), option mapping for cards (Phase 13 calls contract E).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- Background jobs are declared in `LLM_JOB_SPECS` (`src/shared/llm-jobs.ts:71`), an append-only
  list, and run through `runJobStructured` (`src/server/llm/jobs.ts:126`). `src/server/task-title.ts`
  is the precedent: a limiter, a schema and a deterministic fallback.
- Each call starts one `claude` or `codex` process (`src/server/llm/claude-sdk.ts`,
  `src/server/llm/codex.ts`). Thinking is on by default, which is most of the delay.
- The app stores no provider key. Secret shapes are listed in `src/shared/secret-shapes.ts`.
- Inherited: `needs-model` decisions and cards (contract D), `SpokenName.agent` (contract C),
  `decisionProvider` (contract A), and the spike's S7 values.

## 5. Implementation steps

1. **Decider.** `src/server/voice/decide.ts` with contract E's `ask`. A `who` question carries the
   candidates with their roles; `split` asks whether a second name starts a second message;
   `option` carries a card's options. An answer below the spike's confidence threshold counts as
   not sure.
2. **Decision providers.** Two adapters over HTTPS: the OpenAI Decisions API (`POST
   /v1/decisions`, choice and predicate questions) and Jev (`POST /v1/systemone`, with the model
   version pinned). One request carries the questions an utterance needs. Each call has the
   spike's time limit. Neither API can abstain, so "not sure" is the confidence threshold.
3. **Provider and key.** No text leaves the machine for a decision provider unless a provider
   has been selected. `effectiveDecisionProvider(config, env)` decides, in this order:
   - `decisionProvider` is `openai` or `jev`: that provider, selected in Voice settings;
   - `decisionProvider` is `off`: none, whatever the environment says;
   - `decisionProvider` is null, the default: the provider named by
     `MISSION_VOICE_DECISION_PROVIDER` in the daemon's environment (`openai` or `jev`, read
     through `envVar`), which is how an organization selects one for each machine; any other
     value, or no value, is none.
   A key is looked up for the effective provider and for no other: the saved key for that
   provider, and otherwise that provider's variable in the daemon's environment
   (`OPENAI_API_KEY` for OpenAI Decisions, `TYPESAFE_API_KEY` for Jev). A saved key overrides
   the environment on that machine. A key in the environment is a source of credentials for a
   selected provider and nothing more: with `OPENAI_API_KEY` set and no provider selected, no
   adapter is built and no HTTPS call is made. Contract E's key routes store a key per
   provider in `<state home>/voice/decision-key.json` with mode 0600; it is not in SQLite or
   settings backups, and is not returned or logged.
4. **Haiku or Luna.** A new job id `voice-routing`. The call sets thinking off and its own short
   system prompt. It runs on Claude when the candidates are Claude sessions, on Codex when they
   are Codex sessions, and otherwise on the provider chosen for background jobs. If S7 found a
   process started ahead of time to be sound, keep one ready and use each for one question.
5. **Ladder.** No effective provider, or one with no key: go straight to the job, with no
   warning and no HTTPS call. A provider error or timeout: fall to the job. A job error or
   timeout: `unsure`.
6. **Router.** For `needs-model` the router opens the card as `resolving` when a call passes one
   second, then resolves it: `pending` for one target, `pending` with two parts for a split,
   `unsure` with candidates otherwise. A mention sends the whole text to the first agent.
7. **Settings.** In Voice settings, a "Faster routing" group: provider (None, OpenAI Decisions,
   Jev), a key field, and a line saying where the key comes from ("From the environment", "Saved
   on this Mac", or "Not set: routing uses Haiku or Luna"), with Remove. The key field and its
   line are drawn for the effective provider and are absent while it is none, so an unused key
   in the environment is never reported as in use. When the environment names a provider, the
   control gains a first choice, "From the environment: <provider>", which is the null value,
   and choosing None stores `off`. The group states that ambiguous sentences and the roster's
   names and roles are sent to the selected provider.
8. **Docs.** `docs/voice.md`, `docs/models.md` (the job), `docs/configuration.md` (the three
   environment variables), `docs/security.md` (what text leaves the machine, and that it does
   so only for a selected provider).

## 6. Data and compatibility

One private file. `LLM_JOB_IDS` gains one id at the end. With no key and no reachable provider,
routing still ends in the roster rows. `decisionProvider` takes null, `off`, `openai` or `jev`;
Phase 1 stores null.

## 7. Tests and verification

- `test/voice-decide.test.ts` with fake providers: each rung, a timeout falling through, a low
  confidence, a split, a mention, no key, environment and saved key precedence. With
  `OPENAI_API_KEY` in the environment and no provider selected, an ambiguous utterance makes no
  HTTPS call and resolves through the job; the same with `TYPESAFE_API_KEY`. With the provider
  selected in settings, the environment key is used. With `MISSION_VOICE_DECISION_PROVIDER`
  naming a provider and its key in the environment, the provider is called; with
  `decisionProvider` `off` it is not. A key for the provider that is not selected is not sent.
- `test/voice-decision-key-http.test.ts`: the key is not echoed, the file mode, removal.
- Provider adapters are tested against recorded responses; no test calls a real provider.
- `e2e/specs/voice-decision-key.spec.ts`: choose OpenAI Decisions, save a key, see "Saved on this
  Mac", remove it. With `OPENAI_API_KEY` in the daemon's environment and the provider None, the
  group shows no key line; choose OpenAI Decisions and the line reads "From the environment".
  The e2e fake agent answers the job path.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

"Steve, check the build, and Alice, review the PR" becomes one card with two parts. With no key
the same utterance resolves through the job. A saved key cannot be read back. A key in the
environment with no provider selected sends nothing to a provider.

## 9. Downstream handoff

Phase 13 calls `ask` with `option` questions. Phase 6 draws `resolving` and two-part cards.

## 10. Cross-phase audit record

- If S7 is no-go for both providers' accuracy, steps 2 and 7 ship behind the setting defaulting to
  none, and the job is the model step.
- After Phase 13: `option` questions reuse the ladder unchanged.
- Pull request review, fourth round: step 3 used an environment key whenever one was present,
  so a developer with `OPENAI_API_KEY` set for other tools would have sent ambiguous sentences
  and roster names to OpenAI without choosing to. A provider must now be selected, in Voice
  settings or by `MISSION_VOICE_DECISION_PROVIDER`, and an environment key is credentials for
  that provider only. The second variable keeps the organization-wide path the operator asked
  for: an organization sets both and no person configures anything.
