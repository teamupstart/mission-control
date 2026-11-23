# Phase 4: the model step

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V13, V15 and V44. Mock-ups: `mockup-voice-settings.html`,
`mockup-routing-exceptions.html`.

## 1. Outcome

An ambiguous utterance is settled by a model: a decision model when a key is configured, otherwise
Haiku or Luna. One sentence can be split across two agents. The key is entered in Voice settings
or found in the environment, and a key alone switches the decision model on.

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
3. **Provider and key.** A key alone switches the decision model on. The operator decided this
   on 2026-11-23, so that an organization enables it with one variable and no person
   configures anything. `effectiveDecisionProvider(config, env)` decides, in this order:
   - `decisionProvider` is `off`: none, whatever keys exist. This is a person's opt-out;
   - `decisionProvider` is `openai` or `jev`: that provider, when it has a key;
   - `decisionProvider` is null, the default, which means automatic: the first of these four
     that exists decides, in this fixed order: a saved OpenAI Decisions key; a saved Jev key;
     `OPENAI_API_KEY` in the daemon's environment (OpenAI Decisions); `TYPESAFE_API_KEY` in
     it (Jev). With none of them the provider is none. So a saved key beats any environment
     key, and within each source OpenAI Decisions comes before Jev. Saving a second key
     replaces nothing: both stay stored, and the order picks. A person who wants the other
     provider chooses it in Voice settings.
   A provider's key is its saved key, and otherwise its variable in the daemon's environment.
   A saved key overrides the environment on that machine. So with `OPENAI_API_KEY` set for
   other tools and nothing chosen in Voice settings, ambiguous sentences and the roster's
   names and roles are sent to OpenAI. That is the accepted cost of the one-variable path;
   step 7 keeps it visible and one click from off. Contract E's key routes store a key per
   provider in `<state home>/voice/decision-key.json` with mode 0600; it is not in SQLite or
   settings backups, and is not returned or logged.
4. **Haiku or Luna.** A new job id `voice-routing`. The call sets thinking off and its own short
   system prompt. It runs on Claude when the candidates are Claude sessions, on Codex when they
   are Codex sessions, and otherwise on the provider chosen for background jobs. If S7 found a
   process started ahead of time to be sound, keep one ready and use each for one question.
5. **Ladder.** No effective provider: go straight to the job, with no warning and no HTTPS
   call. A provider error or timeout: fall to the job. A job error or timeout: `unsure`.
6. **Router.** For `needs-model` the router opens the card as `resolving` when a call passes one
   second, then resolves it: `pending` for one target, `pending` with two parts for a split,
   `unsure` with candidates otherwise. A mention sends the whole text to the first agent.
7. **Settings.** In Voice settings, a "Faster routing" group: provider (Automatic, Off, OpenAI
   Decisions, Jev) and one key row for each provider, since a key belongs to a provider. A row
   has a key field, a line saying where that provider's key comes from ("From the
   environment", "Saved on this Mac" or "Not set") and Remove for a saved key. With no
   provider in use the group reads "Not set: routing uses Haiku or Luna".
   Automatic is the null value and Off stores `off`. While a provider is in use the group
   names it and says that ambiguous sentences and the roster's names and roles are sent to
   it, so a key picked up from the environment is shown as in use and not hidden.
8. **Docs.** `docs/voice.md`, `docs/models.md` (the job), `docs/configuration.md` (the two
   environment variables), `docs/security.md` (what text leaves the machine, that a key in the
   environment is enough to cause it, and how to turn it off).

## 6. Data and compatibility

One private file. `LLM_JOB_IDS` gains one id at the end. With no key and no reachable provider,
routing still ends in the roster rows. `decisionProvider` takes null (automatic), `off`, `openai`
or `jev`; Phase 1 stores null.

## 7. Tests and verification

- `test/voice-decide.test.ts` with fake providers: each rung, a timeout falling through, a low
  confidence, a split, a mention, no key, environment and saved key precedence. With
  `OPENAI_API_KEY` in the environment and `decisionProvider` null, OpenAI Decisions is called;
  the same for `TYPESAFE_API_KEY` and Jev; with both, OpenAI Decisions. With keys saved for both
  providers and `decisionProvider` null, OpenAI Decisions is called; with only a Jev key saved
  and `OPENAI_API_KEY` in the environment, Jev is called, because a saved key comes first;
  with both saved and `decisionProvider` `jev`, Jev is called. With `decisionProvider`
  `off` and a key in the environment, no HTTPS call is made and the job answers. With
  `decisionProvider` `jev` and only `OPENAI_API_KEY` present, no HTTPS call is made and that
  key is not sent to Jev.
- `test/voice-decision-key-http.test.ts`: the key is not echoed, the file mode, a key saved and
  removed for one provider leaves the other's, and the report of each provider's source.
- Provider adapters are tested against recorded responses; no test calls a real provider.
- `e2e/specs/voice-decision-key.spec.ts`: save an OpenAI Decisions key, see "Saved on this Mac"
  on its row and the group naming OpenAI Decisions, remove it. Save keys on both rows with the
  provider on Automatic: the group names OpenAI Decisions; choose Jev and it names Jev. With
  `OPENAI_API_KEY` in the daemon's environment and the provider on Automatic, the group names
  OpenAI Decisions, the line reads "From the environment" and the sentence about what is sent
  is shown; choose Off and the group reads "Not set: routing uses Haiku or Luna". The e2e
  fake agent answers the job path.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

"Steve, check the build, and Alice, review the PR" becomes one card with two parts. With no key
the same utterance resolves through the job. A saved key cannot be read back. A key in the
environment switches the decision model on, the settings group shows it, and Off stops it.

## 9. Downstream handoff

Phase 13 calls `ask` with `option` questions. Phase 6 draws `resolving` and two-part cards.

## 10. Cross-phase audit record

- If S7 is no-go for both providers' accuracy, steps 2 and 7 ship behind the setting defaulting to
  none, and the job is the model step.
- After Phase 13: `option` questions reuse the ladder unchanged.
- Pull request review, fourth round: the reviewer noted that a developer with `OPENAI_API_KEY`
  set for other tools sends ambiguous sentences and roster names to OpenAI without choosing
  to. Revision 10 required a selected provider. The operator reversed that on 2026-11-23: a
  key alone switches the decision model on, as first decided, so one variable enables it for
  an organization. Do not reintroduce a required selection. What the review did change: step
  3 now says outright what null means and which key wins, `off` is a person's opt-out, the
  settings group names the provider in use and what is sent, and the security doc says so.
- Pull request review, ninth round: "the provider of a saved key" named no winner when keys
  are saved for both providers. Automatic now follows one fixed order of four sources, saved
  before environment and OpenAI Decisions before Jev, and the both-saved case is tested.
