# Phase 9: Residents and chat routes (WP16)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.23, 7.24.

**1. Outcome.** The daemon lists residents, runs, pauses and resumes them, and serves a task's transcript and a send route for chat, all under the home-session rules, so the pane can chat without touching `/api/*`.

**2. Entry and dependencies.** Direct prerequisites: P3 (home-session rules) and P4 (inbox shapes). Gate: S16 and its `chat_first` fallback recorded in Commonroom before merge. Quote the recorded answer in the pull request; if S16 and the fallback both fail, stop and wait for the owner.

**3. Scope.** `src/server/home-dispatch/residents.ts`, `chat.ts`; `test/home-dispatch-residents-http.test.ts`, `test/home-dispatch-chat-http.test.ts`. Routes: `GET /dispatch/residents`, `POST /dispatch/residents/{runId}/{run-now|pause|resume}`, `GET /dispatch/tasks/{id}/transcript`, `GET .../transcript/stream` (read only, for `mctl logs -f`), `POST .../send`. Non-goals: restart and cancel-run-now (Q22), the pane (P12).

**4. Findings.** `GET /api/sessions/:id/transcript` returns the last 60 messages in 5 to 12 ms and accepts `since` (L38); `/api/*` checks only a loopback host, which is why the mod must use wrappers. The existing resident routes are in `src/server/residents/routes.ts`; call the same code in process. Residents with no repository are shown in every home session (D51). `mctl` may read and stream but never send.

**5. Steps.** Read spec 7.2, 7.23, 7.24. Wrap the existing session transcript, stream and send handlers and the resident run actions in process. Enforce 403 for workers and out-of-repository tasks, 409 when there is no live session or the session cannot take a message, 400 over 8,000 characters. Write no receipt for send.

**6. Data and API.** Fill P1's stubs; shapes unchanged.

**7. Tests.** Each route, each refusal, `cli` caller read limits, resident with no repository, a Codex SDK session transcript read (L43).

**8. Merge and exit.** Routes real behind the flag; no `/api/*` route changed; S16 answer quoted.

**9. Handoff.** P12 reads transcripts every 1.5 s and sends through these routes; P10 uses the read and stream routes for `mctl logs`.

**10. Cross-phase audit.** Reuses P3's predicate and P4's inbox item; no overlap with P4's answers. S28b runs after this phase and P4.
