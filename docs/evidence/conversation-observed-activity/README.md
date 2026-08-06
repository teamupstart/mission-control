# Observed activity sideband

Three frames from the passing browser regression
`e2e/specs/conversation-observed-activity.spec.ts`, taken between its own assertions
against the built dashboard and the fake Claude agent. Each capture happens only after
the assertions it illustrates have already held on the same run.

- `01-wide-rail.png` - an expanded card at desktop width with the **Observed activity**
  rail beside the transcript: the count, the "Tool calls observed in the loaded
  transcript." note, and the two rows the fake's `E2E_OBSERVED_TOOLS` turn left
  (`read src/web/styles.css` from a turn that also carried prose, `bash ls` from a
  tool-only turn). The inline chips are still in the log beneath - the rail supplements
  them, it does not replace them.
- `02-find-owns-rail.png` - the same card with find open: the Results rail holds the
  secondary column and Observed activity is gone from it entirely. Exclusive ownership
  is checkable in the DOM as a count; that the swap does not move the conversation is
  legible only here.
- `03-narrow-disclosure-open.png` - the card after the viewport narrows to 600px and
  the **Observed activity** disclosure is opened: the section stacks under the log,
  stays bounded, and the composer is still on screen beneath it.

Regenerate all three with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/conversation-observed-activity.spec.ts \
  --workers=1 --reporter=list
```

The captures carry a relative timestamp and a fresh worktree uuid, which is why they are
behind `MC_E2E_EVIDENCE` rather than taken on every run.
