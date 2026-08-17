# Phase 1: Secure Files Mermaid preview

## Outcome and value

Markdown files opened in Files Preview automatically render fenced `mermaid` blocks as accessible,
Mission Control-themed diagrams. Editor mode preserves the exact source, ordinary code fences remain
code, and a bad or hostile diagram fails only inside its own bounded host.

This phase delivers the complete approved feature in one reviewable pull request. It does not create
a general diagram service or change Markdown behavior outside Files.

## Entry criteria and dependencies

- The planning pull request containing `plan.md`, `phased-plan.md`, and this file is merged to the
  default branch.
- There are no direct implementation-phase dependencies.
- Work is confined to this repository.

Before editing, read the source plan, this file, `AGENTS.md`, `.agents/memory/MEMORY.md`,
`docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, and `e2e/README.md`.

## Scope

- Add Mermaid as a pinned direct browser dependency, starting with 11.16.x or newer after verifying
  the selected release's current security and license metadata.
- Add a lazily reached, isolated renderer document to the Vite build and packaged application.
- Add one stable, explicit fenced-diagram capability to the shared Markdown renderer and enable it
  only from Files Preview.
- Render exact `mermaid` fences with approved resource limits, independent async state, readable
  errors, accessible labels, and the existing Mission Control palette.
- Add focused tests, a Playwright specification, build and package proof, and UI documentation.

## Non-goals

- No Graphviz DOT or other diagram engines, remote rendering service, settings switch, custom
  Mermaid configuration, zoom, pan, export, copy-as-image, or active diagram links.
- No rendering in conversations, shared plans, Foreman briefs, Personas, workflow actions, Scouts,
  or any other existing `Markdown` caller.
- No daemon route, shared wire contract, database, migration, persistence, or SSE change.
- No change to `htmlPreview.ts` security semantics, `electron-builder.yml`, production/release/CI
  configuration, or generated `dist/` files.

## Repository findings and inherited contracts

- `src/web/components/FileWorkspace.tsx` already switches Markdown files between Preview and Editor
  and passes Preview content to `Markdown.tsx`. Preserve that ownership and the existing 180 ms
  prepared-preview behavior.
- `src/web/components/Markdown.tsx` is memoized and builds stable custom components for link routing.
  Any new capability must have stable identity and be compared explicitly so source, file paths,
  links, and diagram support cannot become stale.
- `src/server/session-files.ts` already classifies Markdown extensions and supplies the full source.
  It permits a 5 MiB preview, which is why the web layer needs smaller per-diagram limits.
- The daemon already serves built web files generically and Electron already packages `dist/**/*`.
  A new stable Vite entry needs build configuration and verification, not a new server or builder
  path.
- Checkout content is untrusted. Preserve the source plan's opaque-origin, no-network boundary:
  `sandbox="allow-scripts"` only, restrictive Content Security Policy before controlled bytes, no
  SVG injection into the parent, no interaction binding, and source/token validation for every
  message.
- Preserve the source plan's 50,000-character per-diagram and 32-diagram per-document ceilings,
  visibility-based loading, bounded height, timeout, and stale-result rules.

## Implementation steps

### 1. Prove the isolated build shape first

Add the Mermaid dependency and a dedicated renderer HTML/script entry owned by the web build. Extend
`vite.config.ts` with an explicit stable input and confirm its output is a real renderer document in
development, `npm run build`, the built daemon, and the packaged Electron resources.

Attempt the normal Vite entry first. If an opaque sandbox origin prevents its module script from
loading, configure a single classic renderer asset for this entry. That adaptation is allowed; adding
`allow-same-origin`, weakening Content Security Policy, enabling network access, or moving Mermaid
execution into the dashboard is not. Keep Mermaid and its transitive code out of the dashboard's
initial entry when no diagram is viewed.

Add a smoke assertion in the build verification path, likely `scripts/smoke-bundles.mjs` or a
focused companion, that checks the stable renderer document and its referenced asset exist and are
not the SPA fallback. Do not hand-edit generated output.

### 2. Define a small browser-safe bridge contract

Create a focused web helper for renderer URLs, message shapes, limits, instance tokens, and palette
normalization. Prefer pure functions for validation so Node tests can pin the contract without a DOM.
The parent sends only bounded source, a fixed palette, an accessible ordinal, and an instance token.
The child returns only ready, success-height, or failure state with that token.

Validate `event.source`, message shape, token, current file/source generation, and expected renderer
origin semantics before accepting a result. Ignore late results after edits, file switches, mode
switches, unmounts, or a superseding request. Clamp reported height and time out a renderer that
never settles.

### 3. Implement the sandboxed Mermaid document

Initialize Mermaid with `startOnLoad: false`, strict security, a fixed base theme, and locked
security-sensitive configuration. Do not honor diagram-provided theme, security, font-loading,
external asset, or interaction configuration. Do not call returned interaction binders.

Put Content Security Policy in the renderer document before executable or diagram-controlled bytes.
Use `default-src 'none'` and `connect-src 'none'`; allow only the built script and the minimum inline
style capability needed by generated SVG. Block remote images, styles, fonts, forms, framing, and
navigation. Render SVG only inside the sandbox document. Catch import, parse, render, and layout
errors and return a bounded failure without sending source or generated markup back to the parent.

### 4. Add an opt-in diagram host to Markdown

Add a small fence-to-renderer registry with `mermaid` as its only entry. Extend `Markdown` with an
explicit stable capability or registry prop that is disabled by default. Recognize only the fenced
block language class already supplied by `react-markdown`; do not guess from content. Preserve inline,
untagged, unknown, excessive, and ordinary tagged code through the existing highlighted code path.

The Mermaid host should render a labelled `figure` and lazy sandbox iframe only as it approaches the
viewport. Enforce 50,000 source characters and 32 diagram hosts per document before any iframe work.
Each block owns loading, success, syntax/import/timeout error, too-large, and over-limit states.
Failures retain readable source and must not reject the parent Markdown tree. Multiple blocks settle
independently.

Extend the `Markdown` memo comparator and stable component construction for the new input. Explicitly
test the default behavior so all non-Files callers remain code-only.

### 5. Integrate Files, visual design, and source recovery

Enable the Mermaid registry only for the Markdown Preview branch in `FileWorkspace.tsx`. Preserve
the Preview and Editor toggle, saving behavior, preview debounce, file identity, and existing scroll
container. Returning from Editor to Preview must render the newest prepared buffer, and late results
from the previous buffer must be ignored.

Read computed parent CSS tokens and pass an allowlisted palette into the sandbox because an opaque
iframe cannot inherit them. Add host, loading, error, source fallback, and responsive iframe styles
to the existing Markdown section of `src/web/styles.css`. Use accessible names such as `Mermaid
diagram 2`; express loading and failure in text rather than color. Clamp pathological dimensions and
keep wide content scrollable inside its frame without widening the Files pane.

Update `docs/ui.md` with the exact `mermaid` fence, Files-only automatic rendering, Editor recovery,
invalid and bounded behavior, local-only execution, and the fact that other tags remain source.

### 6. Verify the complete boundary

Add or extend focused server-render tests around `Markdown` and the pure bridge helpers. Cover
opt-in versus default behavior, exact fence matching, inline/unknown/untagged fallback, limits,
sandbox attributes, Content Security Policy, message source/token validation, stale results, height
clamping, and per-block failure. Include a regression assertion for the memo comparator's new input.

Add `e2e/specs/file-mermaid-preview.spec.ts` using the existing Files fixture pattern. Its Markdown
fixture should contain two valid diagrams, ordinary tagged code, a malformed diagram followed by
prose, and controlled content that attempts an external image or link to a sentinel origin. Assert:

- the file opens in Preview and valid blocks become separately labelled graphics;
- normal code stays source and the malformed block reports locally without hiding later content;
- no request reaches the sentinel and no active link or dashboard-origin access is exposed;
- Editor contains the exact original fences;
- an edited label wins after returning to Preview and any stale result is ignored;
- the behavior works in the integrated Files workspace and, where the existing harness supports it,
  the extracted Files window.

## Data, API, migration, and compatibility

There is no persistent-data, API, event, migration, or server compatibility work. The compatibility
contract is browser-facing: existing Markdown calls omit the capability and render exactly as before;
unknown fence languages degrade to code; Files Editor retains source; old builds and databases need
no upgrade step.

The new Vite entry is a packaged static artifact. Keep its URL stable within the web base path and
make build verification fail if it is absent. Do not rely on a CDN or a public rendering server.

## Verification commands

Run focused tests with the required preload, adjusting the new focused filename if the repository
suggests a better owner:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/markdown-render.test.ts test/transcript-path-links.test.ts test/diagram-preview.test.ts
npm run build
npm run test:e2e -- e2e/specs/file-mermaid-preview.spec.ts
```

Then run the repository gates:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

On macOS, run `npm run package` or the repository's equivalent packaged-resource inspection and
prove the renderer document and its assets load in packaged Electron. Audit the production bundle to
confirm Mermaid is not in the initial dashboard path. Do not commit screenshots, traces, package
outputs, or other evidence artifacts.

## Merge and exit criteria

- One pull request contains the dependency and lockfile, isolated renderer, Files-only opt-in,
  styles, tests, smoke proof, and documentation.
- All source-plan acceptance criteria have a focused or browser proof, including exact-source
  recovery, independent failures, stale-result rejection, limits, and blocked network attempts.
- The renderer works through Vite development, built-daemon static serving, and packaged Electron
  without `allow-same-origin` or a relaxed network policy.
- Existing HTML preview and all non-Files Markdown surfaces retain their behavior.
- Focused tests and all required repository gates pass. Generated output and evidence are absent
  from the commit.

The phase is complete only when its pull request is green, review feedback has been resolved, and it
is merged.

## Downstream handoff

There is no scheduled later phase. A future diagram-engine proposal may rely on the capability being
opt-in, the tag registry being the only dispatch point, and unrecognized fences degrading to source.
It must not weaken the iframe isolation, reuse the dashboard DOM for generated markup, or assume that
Mermaid's dependency and resource policy automatically applies to another engine.

## Cross-phase audit record

- **2026-08-17:** Reconciled with the approved source plan and current Vite, Markdown, Files,
  server-static, Electron packaging, and E2E contracts. Kept the renderer and its only consumer in
  one phase because neither is independently operable or security-testable.
- **2026-08-17:** Confirmed every user-visible, security, resource-limit, documentation, build, and
  verification requirement is owned here exactly once. No API, migration, or later cleanup phase is
  required.
