# Inspector review prompt: the cost of a symlinked standards doc

Captured evidence for the fix in `fix(standards): load a symlinked repo doc once, not once
per name`. `docs/foreman-inspector-token-usage.html` ("Waste and defects found", defect 1)
measured that every Inspector review and every Foreman verify prompt on this repo carried
24,576 bytes of byte-identical duplicate content. This is that claim, measured.

`AGENTS.md` and `CLAUDE.md` are both in `ROOT_NAMES`, and this repo ships the second as a
symlink to the first - visible below as git mode `120000` against `100644`. De-duplicating
on the REQUESTED path emitted one file as two documents.

Reproduce with the command shown. It reads the pre-fix source out of git (locating the
revision itself, so it keeps working as commits land on top) and never touches the working
tree, so both arms run in one invocation on any checkout state:

```console
$ npx tsx scripts/measure-inspector-prompt.ts
checkout:    /Users/jordanmance/.treehouse/ai-harness-c7356c/11/ai-harness
root docs:   100644 a60044c26e13c2ee8380b8011ee7cbfc82d84d48 0	AGENTS.md
120000 47dc3e3d863cfb5727b87d785d09abf9743c0a72 0	CLAUDE.md
pre-fix rev: 63f556893bbdebee7156874a15c8152c96de1e1d^ (6453445a7c89335bad5d04025fa6fef046910d9d)

  BEFORE - de-dup keyed on the REQUESTED path
    doc: AGENTS.md     24576 bytes
    doc: CLAUDE.md     24576 bytes
    docs loaded:         2
    standards bytes:     49152
    REVIEW PROMPT BYTES: 52091

  AFTER  - de-dup keyed on the RESOLVED path
    doc: AGENTS.md     24576 bytes
    docs loaded:         1
    standards bytes:     24576
    REVIEW PROMPT BYTES: 27486

  SAVED: 24605 bytes (47.2% of the prompt)
```

Both arms call the same `buildReviewPrompt` and size it with `Buffer.byteLength`; only
`readStandards` differs between them, which is what isolates the duplicate. The pre-fix arm
runs the real pre-fix code read out of git at `6453445`, not a reconstruction of it.

The saving is 24,605 bytes - the 24,576-byte document plus its `### CLAUDE.md (truncated)`
heading - or 47.2% of this prompt, at roughly 6.6k tokens per Inspector review and per
Foreman verify.

`test/standards-prompt-bytes.test.ts` is the CI regression guard for the same property. It
builds its own temp repository rather than reading this checkout, so it cannot speak for
these numbers; that is what this artifact is for. The two are complements.
