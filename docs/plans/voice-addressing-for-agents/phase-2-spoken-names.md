# Phase 2: spoken names

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V1, V2, V3 and V32. Mock-ups: `mockup-call-sign-field.html`,
`mockup-voice-settings.html`.

## 1. Outcome

A session can be given a call sign when it is dispatched, a resident can be given a reference
name, both are checked for distinctiveness, and Voice settings lists who can be addressed.

## 2. Entry criteria

Phase 1 is merged. (Inbox Phase 1, which supplies `agentDisplayName`, is already behind Phase 1.)

## 3. Scope and non-goals

In scope: contract C, the dispatch field, the profile field, validation, the registry, the roster
section, docs and specs. Not in scope: hearing or routing anything.

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- The Advanced box is `src/web/components/DispatchModal.tsx:3377-3441`; its draft is `DispatchDraft`
  (`src/web/lib/task-draft.ts:25`, with `draftFromTask`, `draftsEqual` and `taskUpdatePatch`).
- Create and update schemas: `DispatchSchema` (`src/shared/protocol.ts:1311`),
  `UpdateTaskFieldsSchema` (`:1721`), and the MCP shapes at `:1790-1820` used by `create_task` and
  `update_task` in `src/mcp/server.ts`.
- A task column is added with `addColumn` (`src/server/db.ts:5406`) inside `migrate()`; the schema
  version is 42 (`:299`). `taskSummaryFor` (`src/server/registry.ts:8209`) builds what a session
  carries.
- A resident's identity section is `ResidentIdentitySectionSchema`
  (`src/shared/residents.ts:81-84`); it is stored as revision JSON, and its editor is
  `IdentitySection` (`src/web/residents/editor-sections.tsx:87-116`).
- A session finds its resident run by task id (`residentRunForTask`,
  `src/server/residents/store.ts:658`). Registry events are read through `subscribe`
  (`src/server/registry.ts:1951`).
- Inherited: contracts A and B, and `agentDisplayName`, whose inputs `callSign` and
  `referenceName` are unset until this phase.

## 5. Implementation steps

1. **Validation.** `src/shared/voice-names.ts` with contract C's functions. `phoneticKey` is a
   Double Metaphone style key. `validateSpokenName` returns any of `common-word` (a bundled list
   of common English words and names that are words), `sounds-like` (same key as another roster
   name, or one edit away), `short` (one syllable and four letters or fewer) and `control-word`.
2. **Call sign.** `tasks.call_sign` with its migration and version bump; `Task.callSign`,
   `TaskSummary.callSign`; optional `callSign` (trimmed, 1 to 40 characters) on the create, update
   and MCP schemas and tool descriptions.
3. **Dispatch field.** A Call sign field in the Advanced box for each task kind, in the adopted
   heard-as design: the sentence "<name>, check the build", a four-step meter (four minus the
   number of warnings) and one line per warning. Dispatch stays enabled whatever the warnings.
   The collapsed summary names the call sign.
4. **Reference name.** Optional `identity.referenceName` on the resident schema and a field in the
   identity section with the same preview.
5. **Registry.** A server `VoiceNameRegistry` subscribed to session, task and resident events. It
   holds one `SpokenName` per live resident profile (reference name, else profile name; role from
   `identity.description`; `running` while it has an open run, else `not-running`) and one per
   task with a call sign (role from the task title; `running` while its session is live,
   `hibernated` while the task is hibernated, else `not-running`). A task that is no longer
   running leaves the roster after 24 hours, or at once when another agent takes its name. It
   fills `VoiceState.roster` and emits `voice_roster`.
6. **Display name.** Pass `callSign` and `referenceName` into `agentDisplayName` wherever the inbox
   plan builds its input.
7. **Roster panel.** At the top of Voice settings: a table of agent, kind, spoken name, state and
   warning, then a line counting sessions that have no call sign and saying they are answered with
   "reply".
8. **Docs.** `docs/voice.md`, `docs/dispatch-and-backlog.md`, `docs/residents.md`.

## 6. Data and compatibility

One migration: a nullable column, so an existing database opens unchanged. A resident revision
without `referenceName` parses as before. The field is saved while the flag is off but is drawn
when the flag is on.

## 7. Tests and verification

- `test/voice-names.test.ts`: each warning, Steve against Stevie and Steven, control words.
- `test/voice-registry.test.ts`: a resident launch and stop, a call sign set by update, an exit,
  a hibernated task, the 24 hour and name-reuse removals.
- A database upgrade test from version 42.
- `e2e/specs/voice-call-sign.spec.ts`, after `e2e/specs/dispatch-persona.spec.ts`: type "Will" and
  see the common-word warning with Dispatch enabled; dispatch with "Alice"; the roster lists
  Alice; the question card names the session Alice.
- `e2e/specs/voice-reference-name.spec.ts`: set a resident's reference name; the roster shows it.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the two specs.

## 8. Merge and exit criteria

A call sign and a reference name survive a daemon restart, appear in the roster and in the display
name, and draw their warnings without blocking.

## 9. Downstream handoff

Phase 3 reads the roster and `phoneticKey`. Phase 5 reads `SpokenName.state`. Phase 9 primes the
recognizer from the roster's names.

## 10. Cross-phase audit record

- After Phase 3: routing compares `phoneticKey` values, so validation and routing agree on what
  "sounds like" means.
- After Phase 4: `SpokenName.agent` is what chooses Haiku or Luna.
- After Phase 5: the roster keeps agents that are not running so "<name> isn't running" can be
  said; that is why state is a field and not a filter.
