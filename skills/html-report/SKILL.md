---
name: html-report
description: Deliver the answer to any investigation, scout, audit, or research request as a self-contained HTML report written into the checkout, and log its checkout-relative path so it opens rendered in the Mission Control Files tab. Use whenever you are asked to investigate, scout, research, audit, trace, profile, compare, or gather data about something, including when subagents did the searching and you are only relaying what came back.
metadata:
  mission:
    category: research
    enforcement: triggered
---

# HTML reports

An investigation that lands as a wall of chat text is read once, by whoever was watching
the pane, and is gone by the next turn. The number that decided it is three scrolls up,
the file it came from is unclickable, and nobody can send it to anyone. A finding is worth
more than the turn that produced it: write it as a page, put the page in the checkout, and
hand back a path that opens it rendered.

## When this applies

Whenever the ask is to find something out rather than to change something: investigate,
scout, research, audit, trace, profile, survey, compare, "look into", "dig into", "how does
X work", "where does Y come from", "how much does Z cost". It applies just as much when
subagents did the searching - what they returned is the report's content, not the answer to
paste into chat.

The threshold is the size of the answer, not the size of the question. If it fits in a
sentence, say the sentence. If it cites more than a couple of files, carries a table, a
count, a measurement, or a comparison, it is a report.

**That one-sentence exception never applies to a Mission Control scout task.** A scout's
report is archived: the page and the evidence beside it outlive the session, the checkout and
the task card, and the conversation is not kept at all - so a one-sentence answer given in
chat is an answer nobody can find tomorrow. A scout writes the page whatever the answer's
size, submits it with `submit_scout_artifacts`, and cannot be marked done until Mission
Control has captured and verified it. The task's own prompt says so; this skill is how to
write a good one, not whether to.

Not for: a plan for work you are about to do - that is `html-plans`, which has its own
decisions contract. Not for a code review. If the investigation ends in a proposal, write
the report for the findings and the plan for the proposal.

## Always: write the report as HTML

1. One file, at `docs/reports/<slug>/report.html`, where `<slug>` is a kebab-case name for
   the question (`sse-reconnect-audit`, `codex-rollout-scan-cost`). Its own directory so a
   captured CSV or screenshot can sit beside it and be linked from it.
2. Self-contained. Inline the CSS in a single `<style>`, embed images as `data:` URIs, and
   make no external request of any kind. It must open correctly from `file://` with no
   network, forever. No CDN - not for fonts, not for CSS, not for a charting library.
3. **No JavaScript.** Mission Control renders the report in a sandboxed iframe whose CSP
   allows exactly two hashed bridge scripts and nothing else, so the report's own `<script>`
   never runs - a page that builds itself at runtime renders blank in the one place it is
   most likely to be read. Charts are inline SVG. Tables are `<table>`. Disclosure is a
   heading, not a toggle.
4. Answer first. A title, the question as asked, and the finding in the first screen -
   before the evidence, not after it. Then the evidence, then the limits.
5. Show the work. Every claim carries what it rests on: the file, the count, the command,
   the quote, the measurement and how it was taken. A number with no provenance is an
   opinion in a monospace font.
6. Say what you did not establish. The unchecked path, the sample that was too small, the
   thing that would take a run you did not do. A report that reads as complete when it is
   not is worse than a short one.
7. Style it for both schemes with `prefers-color-scheme`, and let wide content - tables,
   code blocks, diagrams - scroll inside its own container so the page body never scrolls
   sideways.

   **The preview is always dark. Author dark first and check it.** Mission Control renders
   the report with `prefers-color-scheme: dark` whatever the operator's OS says, because the
   dashboard sets `color-scheme: dark` on `:root` and Chromium propagates an embedder's used
   colour scheme into a nested browsing context. Writing the report light-first, opening it
   in a browser on a light-mode machine and shipping it means the only scheme anyone will
   read it in is the one scheme nobody looked at.

   **A token is a foreground or a surface, never both.** This is the rule that the dark path
   punishes. `--ink` is a text colour; flipping it light for dark mode is correct. A rule
   that borrowed it for `background` gets its surface repainted light while the hard-coded
   light text on top of it stays put, and the panel becomes invisible at 1.07:1. Same for a
   `--green` chip under a hard-coded `color: #fff`. If a rule pairs a literal colour with a
   token, the token cannot be flipped by scheme without flipping its partner - so give the
   surface its own token and move them together.

   **Then run the check on your report before you hand it over.**

   ```sh
   node scripts/check-report-contrast.mjs docs/reports/<slug>/report.html
   ```

   It renders the file at both schemes and fails on text below 3:1. Two stages: the declared
   CSS colours propose candidates, then the pixels actually painted confirm or discard each
   one. Neither half is trustworthy alone - reading CSS cannot see SVG (text is
   painted with `fill`, over a sibling `<rect>`, so a correct diagram scored 1.11:1 against
   the wrong surface), and sampling pixels alone cannot tell invisible text from text that is
   merely absent - inside a closed `<details>`, or below the fold. Text that is *meant* to be
   unreadable, such as a specimen in a report about a contrast defect, opts out with
   `data-contrast-exempt="<reason>"`, and the run prints how many texts it skipped.

   It takes a path on purpose: it gates the report you just wrote. `--all` sweeps
   `docs/reports/` when that is what you want, and does not come back clean - reports written
   before this check existed carry their own findings.

Two reports already in this repository were written this way and are the reference for
layout, typography and inline-SVG charting: `docs/sqlite-database.html` and
`docs/foreman-inspector-token-usage.html`. Read one before inventing a look.

Copy their layout, not their colours - neither of them passes the contrast check today.
`docs/sqlite-database.html` pins `color-scheme: light` with no dark block, and 13 of its
texts sit below 3:1 in both schemes: nine section eyebrows at 1.54:1, three SVG labels
painted at 1:1, and one inline `code` at 1.19:1. `docs/foreman-inspector-token-usage.html`
is much closer - it is authored dark-first with a `prefers-color-scheme: light` override and
is clean in dark - but one `.pill.on` reads 2.64:1 in light. Take the structure and the
typographic scale from them; get your colour pairs from rule 7.

Leave the file untracked unless the investigation is itself the deliverable being shipped.
`docs/reports/` is not ignored, so an untracked report still lists in the Files tab; a
report written under an ignored path does not, and that is the one placement mistake that
silently costs the reader the file.

## Always: log the report as a checkout-relative path

End the final message with the path on its own line:

```
Report: docs/reports/sse-reconnect-audit/report.html
```

Mission Control turns a checkout-relative path in the conversation into a link that opens
that file in the session's Files tab, and an `.html` file opens as the rendered page rather
than as source. So the exact form matters:

- **Checkout-relative.** No leading `/`, no `file://`, no `/Users/...` absolute path, no
  `docs/reports/../` detour. An absolute path or a URL scheme is not claimed and renders as
  dead text.
- **The real path, spelled once.** Not "the report in docs/reports", not a renamed link
  label with no path in it. Either the bare path or a Markdown link whose href is that path.
- **Volunteered, not extracted.** Say where it is in the message that finishes the work,
  every time. A page nobody can find is a page nobody reads.

Then stop. A one-sentence answer plus the path is the whole message - do not also paste the
report's contents into the conversation. If it was worth a page, it is worth opening.

## Linking from inside the report to the files it cites

The report's own hrefs resolve against **the report's directory**, not the checkout root,
and that is the one thing easy to get backwards:

- In the conversation: `src/server/registry.ts`.
- Inside `docs/reports/<slug>/report.html`: `../../../src/server/registry.ts`.

Drop any `:line` suffix from the href - `src/server/registry.ts:42` names no file on disk,
so the link does nothing at all. Keep the line in the text the reader sees:

```html
<a href="../../../src/server/registry.ts"><code>src/server/registry.ts:42</code></a>
```

**On a scout task, drop the href too.** An archived report is read after its checkout is
gone, so a link out of the report directory points at nothing - and Mission Control refuses a
relative link that leaves that directory, so a report carrying one is not captured at all.
Cite the file as visible text with no link:

```html
<code>src/server/registry.ts:42</code>
```

The exception is a file you deliberately copied into the report's own directory. That one is
captured with the report and stays linkable.

Fragment links (`#findings`) work natively, so a long report should have a contents list.

## When the finding is about a flow: draw it

If what you found is about how data or requests move **between major components or to an
external service** - where the latency is, which path is taken, what calls what - show it.
A flow described only in prose is a flow nobody traces.

- **Inline SVG, never a diagram library**, for the same reason as every other CDN and
  because scripts do not run in the preview. A labelled box per component, arrows for the
  flow, and a clear before/after when the change is the point.
- **Only the most relevant, and at most five.** A page of diagrams is read like a page of
  none.

## What not to do

- Don't report what you did not establish. "Probably", inferred from a file you did not
  open, or a subagent's claim you did not check is a gap to name in the limits section, not
  a finding to state.
- Don't reach for a CDN or a script tag. The page has to work offline from a file path, and
  in the preview it has to work with no JavaScript at all.
- Don't write the report and then dump it into chat as well. That is the failure mode this
  skill exists to fix, restated in two places.
- Don't hand back an absolute path, a `file://` URL, or a description of where the file is
  instead of the path itself.
- Don't put the report anywhere but `docs/reports/<slug>/`, and never under an ignored path.
- Don't use this for a plan. A plan is `html-plans`, and it owes the human decisions.
