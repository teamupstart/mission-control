# Phase 3: Scout prompt context reader

## Outcome

The Scouts reader leads with the concise archived title and exposes the original request plus later
human prompts in a clear, bounded Prompt context section. Search copy and snippets describe prompt
matches honestly. Older archives keep their current reader behavior.

## Entry criteria and dependencies

- **Direct phase dependencies:** Phase 2.
- Requires ordered `ArchiveDetail.prompts` and `prompt` search snippets from
  `phase-2-portable-scout-title-and-prompts.md`.

## Scope

- Change the selected scout heading to the short archive title.
- Add the Prompt context reader section and truncation state.
- Update search placeholder and snippet labeling.
- Add static-render and Playwright coverage.
- Finish user-facing archive documentation where screenshots or behavior wording require it.

### Non-goals

- No database, capture, manifest or transcript changes.
- No editing, copying back into a live session or post-publication append.
- No Markdown or HTML rendering for prompts.
- No report, evidence spine, delete or sandbox redesign.

## Repository findings

- `ScoutReader.tsx` currently renders `detail.question` as its `h1`, while rail rows render
  `detail.title` through `scoutLabel`. That is why a title fix alone would still leave the full
  clipped prompt as the reader heading.
- The report is rendered in a sandboxed iframe and artifact text has its own preview rules. Prompt
  context is metadata and must remain ordinary React text outside the iframe.
- `ScoutsPage.tsx` labels search as `Search questions, findings, reports, files...` and renders the
  daemon's snippet source. Both must learn the new `prompt` vocabulary.
- Every visible UI change requires Playwright coverage and no `data-testid` attributes.

## Implementation steps

### 1. Lead with the archive title

In `ScoutReader`, render `scoutLabel(detail)` as the main heading. For an older readable archive
with no prompt trail, render its existing `question` immediately below as the request context so the
change does not hide information.

The rail already uses the same helper. Do not create a second fallback or clip in React.

### 2. Add Prompt context

Render a labelled section between provenance/missing evidence and the report document:

- heading **Prompt context**;
- first entry labelled **Original request**;
- each later entry labelled **Follow-up**, with a semantic `<time>` when `at` is present;
- escaped plain text preserving line breaks and wrapping long tokens;
- an explicit notice when `truncated` is true;
- no empty section when an older archive has no trail.

Use native headings, lists and disclosure behavior only if the content length warrants it. If a
collapse is added, the original request remains visible by default and the control has an accessible
name. Do not place prompts inside the sandboxed report iframe.

### 3. Search language

Change the placeholder to **Search titles, prompts, findings, reports, files...**. Render a `prompt`
snippet label as **prompt** using the existing safe text path. Search must not replace the selected
title with the matching prompt.

### 4. Styles and responsive behavior

Add styles beside the existing `.scouts-*` block in `src/web/styles.css`:

- readable prompt line length;
- preserved whitespace with wrapping for long paths and tokens;
- clear but quiet separation between initial and follow-up entries;
- light and dark token reuse;
- no horizontal page overflow at narrow widths.

The report and evidence spine keep their current sizing and scroll behavior.

### 5. Documentation

Ensure `docs/archives.md`'s Scouts page description matches the final title, prompt section, search
and truncation behavior. Do not duplicate the full manifest specification from Phase 2.

## Tests

Add a `renderToStaticMarkup` test that pins:

- concise title as `h1`;
- original and follow-up labels and text;
- semantic timestamp;
- truncation notice;
- older archive fallback;
- prompt text escaped rather than interpreted as markup.

Extend `e2e/specs/scout-archive.spec.ts` to drive the complete behavior:

1. create a scout whose task title is long and whose live session card has a short generated name;
2. submit a human follow-up through the real composer;
3. send an attributed non-human instruction through the fake-agent path;
4. complete and archive the scout;
5. remove or navigate away from the live session;
6. assert the rail and reader heading equal the old session-card name;
7. assert Original request and the human Follow-up render, while the non-human text does not;
8. search a phrase unique to the follow-up and assert a `prompt` snippet returns the archive;
9. exercise a seeded old bundle with no prompt trail and assert its report remains readable.

Use fake agents, isolated `MISSION_HOME`, role/label/placeholder locators and no model spend.

## Verification

```sh
node --test --import ./test/setup-state.mjs --import tsx test/scouts-catalog.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/scout-archive.spec.ts
```

Perform one visual review at desktop and narrow widths in both light and dark mode. Confirm prompt
text wraps, report scrolling remains usable and no page-level horizontal scrollbar appears.

## Merge and exit criteria

- Rail and reader show the same concise archive title that the live card showed.
- Original request and human follow-ups are readable in order outside the report iframe.
- Non-human, assistant and tool content is absent.
- Truncation and older-bundle absence are honest and legible.
- Prompt search returns a labelled snippet without changing title semantics.
- Static-render, Playwright and full repository gates are green.

## Downstream handoff

There are no later phases. Future work must preserve the separation between the scout's authored
report and the server-captured prompt context, and must not mutate a published bundle to append a
late conversation turn.

## Cross-phase audit record

- This phase owns every final reader, copy, style and browser acceptance requirement.
- It consumes only Phase 2's shared read model and search snippet vocabulary.
- No unfinished server or compatibility work is deferred past this phase.
