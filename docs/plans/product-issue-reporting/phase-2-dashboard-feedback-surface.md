# Phase 2: dashboard Feedback surface

## Outcome

Every Mission Control user can reach **Report product feedback** from a compact topbar tool glyph or
the command palette, complete the approved five-type form, review its public content and create a
text-only GitHub issue through Phase 1's daemon service. The draft survives modal close/reopen until
the user deliberately clears it or a confirmed submission succeeds.

The screenshot area looks and reads like the future Dispatch-style affordance but is disabled in
production, explains the upstream dependency and cannot upload through paste, drop, selection or a
fabricated request. Success, retry-safe refusal, preflight failure and unknown outcome are distinct
user states.

## Entry criteria and dependencies

- Phase 1 is merged and its shared contract, preflight, preview, and dashboard mutation routes are
  available.
- Direct phase dependency: Phase 1.
- The public target repository and labels are available for manual verification; automated tests use
  the shared fake `gh` only.

## Scope

### In scope

- One App-owned Feedback draft, opener and last-result state.
- A focused Feedback modal consuming Phase 1 contracts and routes.
- Five-type form, bounded title/details, public preview and generated-environment display.
- Disabled screenshot dropzone built with existing image-drop components and production capability.
- Topbar tool-group and command-palette entry points sharing one opener.
- Success, refusal, invalid-configuration and unknown-outcome recovery behavior.
- Static render, source guard, topbar geometry and Playwright coverage against built bundles.
- UI, security and task-source rollout documentation.

### Non-goals

- No change to Phase 1 labels, body construction, target selection, MCP confirmation or result
  semantics.
- No enabled screenshot upload and no browser-side attempt to form `--attach` paths.
- No GitHub web-composer handoff or third-party image hosting.
- No task-source creation, public-repository creation or recurring-scheduler code.
- No second modal for the palette and no Feedback route/page.

## Repository findings and inherited contracts

- `App.tsx` owns long-lived modal drafts such as Dispatch and all topbar/palette openers. Keeping the
  Feedback draft there preserves it across close/reopen without persistence or global state.
- `useImageDrop({ disabled: true })` already refuses file selection handlers, paste and drop.
  `AttachmentStrip` owns thumbnails and removal. Reuse both so the later release task flips one
  capability rather than replacing a placeholder component.
- Palette fixed commands belong in `commandProvider` in `src/web/lib/palette-index.ts` and dispatch
  through the typed target union. Add one target and handle it in the existing App palette action
  switch.
- The topbar's last `tb-tools` group contains persistent glyph actions. A new glyph must retain its
  accessible name at every rung and participate in the measured ladder, source guards,
  `topbar-one-row.spec.ts` and Electron geometry checks.
- Overlay ownership and Escape behavior are centralized. Register one focused modal id and follow the
  existing Overlay conventions; do not add document-level Escape or click-away listeners.
- Every visible UI change requires Playwright coverage. `e2e/fixtures/fake-agents.ts` is also the
  required blast shield for `gh issue create` and its recorded argv is the end-to-end assertion
  surface.

## Implementation steps

### 1. Add the focused Feedback component

Create a component such as `src/web/components/ProductIssueModal.tsx` that receives an App-owned
draft, result and callbacks. Keep network calls behind a small hook or API methods, not inline in
markup.

The form contains:

1. a required five-option Type control in the approved order;
2. a required bounded Title field;
3. a required bounded Details field with type-specific guidance but one shared value;
4. a disabled Screenshots region using `useImageDrop` and `AttachmentStrip`, labelled
   **Screenshot upload is waiting for first-party GitHub CLI support** with issue #13256 linked;
5. the permanent public-content warning;
6. a final preview of reporter text, fixed labels, target and Phase 1's allowlisted environment.

The component reads preflight on opening and requests the trusted dashboard preview after the draft
validates and again immediately before submit. Loading and failure states remain in the modal rather
than hiding it. A failed preflight or preview disables submit and names the missing CLI auth,
repository, label, or validation problem. Never render a home path, username, hostname, repository
path, environment variable, transcript, prompt or token.

### 2. Preserve the draft and model each terminal result

Add App-owned state and one memoized `openFeedback` callback shared by every entry point.

- Closing the modal preserves type, title, details and any future completed attachment entries.
- **Clear** deliberately resets the draft and result.
- Submission is disabled while invalid, preflight-blocked, busy or upload-in-progress.
- Success shows **View GitHub issue**, preserves the URL after close and starts the next opening with
  a clean draft.
- Retry-safe refusal keeps the draft and submit action.
- Unknown outcome keeps the draft but disables blind retry for that opening and makes checking the
  target repository the primary recovery.
- A client request id and busy guard prevent double-click submission. The server remains the final
  duplicate guard.

The browser sends only the Phase 1 draft shape to `/api/product-issues`. It never sends source,
repository, labels, generated environment or a local path.

### 3. Add both discoverable entry points

Add a compact Feedback glyph to the existing `tb-tools` group beside Settings and Alerts. Its
tooltip and accessible name are **Report product feedback**; its visible label may collapse at every
measured rung, but the button itself remains.

Extend the palette target union and `commandProvider` with one fixed command using search terms bug,
issue, feature request, docs, documentation, usability and feedback. App's palette handler calls the
same `openFeedback` callback as the topbar button. There is one modal instance and one draft.

Update topbar CSS rung declarations and source tests only where the new glyph changes measured
requirements. Do not add a width breakpoint or a sixth rung unless browser measurements prove the
five-rung ladder cannot settle.

### 4. Style for light, dark, narrow and desktop-shell use

Add focused modal styles to `src/web/styles.css` using existing tokens and Overlay structure.

- Keep the form keyboard ordered and every field labelled.
- Give the disabled screenshot region clear non-color copy and an inert cursor.
- Keep the public warning visually prominent without making every form element look dangerous.
- Constrain long target names, errors, issue URLs and Markdown previews without horizontal page
  overflow.
- Preserve Electron's topbar drag/no-drag coverage through the existing blanket button rule.
- Verify narrow widths, reduced motion and both color schemes through existing patterns.

### 5. Extend the fake and browser journey

Teach the shared fake `gh` to distinguish product-report preflight commands and issue creation while
preserving current PR and task-source behavior. It must record cwd and argv, accept body through
stdin where the fixture can capture it safely, and support scripted success, refusal, unknown and
preflight errors. An unfaked path remains impossible in E2E.

Add a Playwright spec, for example `e2e/specs/product-issue-reporting.spec.ts`, that proves:

- topbar and palette open the same retained draft;
- all five types derive the exact type, triage and dashboard source labels;
- caller-defined repository and labels are absent from the request and argv;
- the disabled screenshot region blocks paste/drop/selection and no local path reaches `gh`;
- success shows the URL and clears the next draft;
- refusal permits safe retry, while unknown outcome disables it for the opening;
- missing CLI auth or label produces actionable preflight copy;
- demo mode produces no fake-`gh` record;
- the agent/MCP path carries `source:agent` and cannot create until the review is submitted;
- topbar remains one row at the existing measured widths and the new control stays accessible.

Keep the existing `topbar-one-row.spec.ts` as the whole-bar geometry authority and add feature
assertions to the new spec rather than duplicating its measurement helper.

### 6. Complete user and operator documentation

Update `docs/ui.md` with both entry points, form behavior, retained draft and result recovery.
Update configuration and security docs with the fixed default, override, public warning and disabled
attachment state. Update task-source guidance with the eight labels and recommended
`labelsAny: ["status:needs-triage"]`, `copyLabels: true` setup.

Document the separate recurring monitor as operational follow-up, including its weekly cadence,
stable-release gates, task/PR deduplication and archive-after-successful-merge cleanup. Do not claim
the initial feature creates the public repository, labels, task source or monitor through ordinary
report submission.

## Data, API and compatibility details

- No migration, persisted draft or local-storage key is added. Modal close retention lasts for the
  App process only.
- Phase 1 schemas and result discriminants are consumed directly. UI labels may be humanized, but
  wire values remain append-only.
- The screenshot field stays empty in production. Disabled HTML is not the security boundary; the
  Phase 1 server gate is.
- The topbar gains one tool peer without changing page navigation, Dispatch behavior or keyboard
  bindings.
- Existing Dispatch and compose attachments remain local agent-prompt paths and are never converted
  to public URLs.

## Verification

Run focused tests while iterating, then the complete UI bar:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/product-issue-render.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/palette-index.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/topbar-ladder.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/product-issue-reporting.spec.ts
npm run test:e2e
```

Run the relevant Electron topbar geometry test on macOS with scoped outside-sandbox approval when
the environment requires it. Manually create and close one disposable text-only public issue,
confirm all three labels and the body marker, and confirm the screenshot control remains inert.

## Merge and exit criteria

- A user can reach one Feedback modal from both topbar and palette and file every approved type.
- Draft retention, clear, success, refusal and unknown-outcome behavior match the source plan.
- Screenshots are visibly unavailable and cannot reach the upload or GitHub path in production.
- The browser never chooses repository, source or labels.
- Static render, topbar source guards, Electron geometry where applicable and Playwright journey pass.
- Typecheck, lint, full unit tests, build, smoke and full E2E pass.
- Documentation covers user behavior, configuration, public-data safety and operator rollout.
- The pull request is reviewable and green before merge.

## Downstream handoff

After Phase 2 merges, the initial product-reporting feature is complete. The release monitor may rely
on the direct and MCP surfaces sharing one attachment field, Phase 1's isolated capability adapter,
the screenshot component already existing in disabled state and the fake `gh` recording its argv.

The later enablement task may change disabled copy, capability detection, final CLI argv/response
handling and attachment-specific tests. It must preserve the five types, public warning, dashboard
confirmation, fixed repository and labels, source derivation, result safety and retained draft.

## Cross-phase audit record

- Initial audit: every source-plan dashboard, accessibility, retained-draft, topbar, palette and E2E
  requirement is owned here.
- Phase 1 reconciliation: this phase consumes its schemas and routes directly and adds no duplicate
  label, body, preview, preflight or outcome logic.
- Attachment reconciliation: `useImageDrop` is mounted disabled and the server rejects non-empty
  lists, so browser markup cannot accidentally enable the anticipated CLI path.
- Final audit: Phase 1 plus Phase 2 cover both entry channels and all selected decisions. The future
  release task is isolated, evidence-gated and not required to make either initial merge safe.
