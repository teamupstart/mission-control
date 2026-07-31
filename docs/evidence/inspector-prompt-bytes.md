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
root docs:   100644 b4497748936a36e898488fe729078bcd5a0d5bfa 0	AGENTS.md
120000 47dc3e3d863cfb5727b87d785d09abf9743c0a72 0	CLAUDE.md
pre-fix rev: 00ce4a43c72dbf23eef23de9dfb52233a3c84f3b^ (a702c2a89326498955e11d001d395383f8cb62a3)

  BEFORE - de-dup keyed on the REQUESTED path
    doc: AGENTS.md      6076 bytes
    doc: CLAUDE.md      6076 bytes
    docs loaded:         2
    standards bytes:     12152
    REVIEW PROMPT BYTES: 15067

  AFTER  - de-dup keyed on the RESOLVED path
    doc: AGENTS.md      6076 bytes
    docs loaded:         1
    standards bytes:     6076
    REVIEW PROMPT BYTES: 8974

  SAVED: 6093 bytes (40.4% of the prompt)
```

Both arms call the same `buildReviewPrompt` and size it with `Buffer.byteLength`; only
`readStandards` differs between them, which is what isolates the duplicate. The pre-fix arm
runs the real pre-fix code, read out of git at `a702c2a`, not a reconstruction of it.

## Why this number is smaller than the one the analysis reported

The analysis measured 24,576 bytes, and so did this script when the fix was written. The
difference is not the fix: `docs(agents): streamline project guidance` (`b6ea3e7`) landed on
main mid-review and cut `AGENTS.md` from 80,918 bytes to 6,076.

The waste is `min(fileSize, MAX_FILE_BYTES)` per duplicated doc, so it tracks whatever the
root doc currently weighs:

| root doc | AGENTS.md on disk | doc in prompt | prompt before | prompt after | saved |
|---|---|---|---|---|---|
| at `6453445`, as analysed | 80,918 B | 24,576 B (capped) | 52,091 B | 27,486 B | 24,605 B (47.2%) |
| at `a702c2a`, current main | 6,076 B | 6,076 B | 15,067 B | 8,974 B | 6,093 B (40.4%) |

Both rows are real runs of this script; the first is preserved because it is the number the
analysis reported and a reviewer comparing the two documents will otherwise think one of
them is wrong. The duplicate is still ~40% of a small-PR review prompt, still paid on every
Inspector review and every Foreman verify, and grows again the moment the root doc does.

`test/standards-prompt-bytes.test.ts` is the CI regression guard for the same property. It
builds its own temp repository at `MAX_FILE_BYTES` rather than reading this checkout, so it
cannot speak for these numbers - and, as the streamlining above demonstrates, that is the
point: a guard pinned to the live `AGENTS.md` would have broken for a reason unrelated to
the defect. The two are complements.
