# Keep Awake - runtime evidence

The fleet pulse's live segment as the Keep Awake control, captured ACTIVE from a running
dashboard rather than from static markup: the mode is on, the segment reads `live · awake`
with the purple dot, and the dropdown is open beside the pulse.

## How it was produced

An isolated daemon on its own `MISSION_HOME` and its own port, serving the BUILT dashboard
from `dist/` - not the shared `:5173` vite server, which serves the main checkout and would
have photographed unmodified code. `MISSION_KEEP_AWAKE_BIN` points the daemon at the fake
`caffeinate` from `e2e/fixtures/fake-agents.ts`, so the capture run placed no real power
assertion on the machine that produced it - while still driving the real manager, the real
`PUT /api/keep-awake`, a real spawned child, and the `keep_awake_status` SSE frame that
turned the indicator purple. The same spec proves the child received exactly
`-i -w <daemon PID>` before this frame was taken.

## `keep-awake-active-dropdown.png`

The open, active dropdown anchored under the live segment. What a reviewer should check
against the approved plan:

- The segment still LEADS with the connection fact and reads `live · awake` - the word
  carries the mode, never the color alone.
- The dropdown reuses the pulse's dark surface and typography, with the active border and
  switch in the same purple as the active dot.
- The three commitments are stated in the open: the screen can dim and lock normally while
  idle sleep is prevented; lid close and manual Sleep still work, at a battery cost; and
  the mode lasts only **until Mission Control quits or restarts**.

Regenerate it with:

```sh
npm run build
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/keep-awake.spec.ts \
  -g 'drives caffeinate' \
  --workers=1 --reporter=list
```
