# Phase 1 verification evidence

Committed alongside the plan (the same pattern `plan.html`/`phased-plan.html` already use)
so the review process can see actual output and actual rendered content as part of the diff,
not narration referencing it. Every command below was re-run fresh, live, immediately before
this file was written, and every screenshot has a matching `.txt` file next to it under
`verification/` - the real text `page.locator("body").innerText()` returned at that exact
moment, so the rendered content is inspectable as plain text, not only as an opaque PNG.

## 1. `npm run demo -- --check`

```
$ node scripts/demo/launch.mjs --check --fresh
[demo] --fresh: removing /Users/jordan.mance/.mission-control-demo
[demo] state root: /Users/jordan.mance/.mission-control-demo
[demo] booting the daemon on port 7417...
[demo] daemon is up (pid 5116), isolated under /Users/jordan.mance/.mission-control-demo
[demo] --check: identity and isolation assertions passed
[demo] --check: ok
$ echo $?
0
```

## 2. `fake-pi.mjs` standalone, verified against pi's own product parser

```
$ MISSION_DEMO_SCENARIO_DIR=scripts/demo/scenarios \
    node scripts/demo/fake-pi.mjs --session-id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
    "Fix the flaky retry test - it seems to race with abort"
$ echo $?
0
```

The real edit it made, diffed against the original file:

```diff
--- src/retry.ts (before)
+++ src/retry.ts (after the scenario ran)
@@ -4,16 +4,27 @@
   signal?: AbortSignal;
 }

-/** Retry an async operation with a fixed delay between attempts. */
+/** Retry an async operation with a fixed delay between attempts, honoring `signal`. */
 export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
   let attempt = 0;
   for (;;) {
+    if (opts.signal?.aborted) throw new Error("retry aborted");
     try {
       return await fn();
     } catch (err) {
       attempt += 1;
       if (attempt >= opts.retries) throw err;
-      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
+      await new Promise<void>((resolve, reject) => {
+        const timer = setTimeout(resolve, opts.delayMs);
+        opts.signal?.addEventListener(
+          "abort",
+          () => {
+            clearTimeout(timer);
+            reject(new Error("retry aborted"));
+          },
+          { once: true },
+        );
+      });
     }
   }
 }
```

Parsed by pi's own real product code (`piToMessage`, `computePiSessionActivity`, imported
read-only from `src/server/harness/pi/{transcript,meta}.ts`):

```
=== piToMessage (conversation renderer) ===
user | Fix the flaky retry test - it seems to race with a |
assistant | Let's look at the retry helper first - that's the  |
assistant |  | Bash
assistant | Found it: the backoff timer keeps running after th |
assistant |  | Edit
assistant |  | Edit
assistant |  | Bash
assistant | Both tests pass now. The retry loop no longer fire |
assistant |  | TodoWrite
=== computePiSessionActivity (idle/working signal) ===
{ state: 'idle', lastActivity: 1785880309245 }
```

## 3. The Foreman orphan-process fix

Committed regression test:

```
$ node --test scripts/demo/launch.test.mjs
✔ stop runs the cleanup (0.676834ms)
✔ two concurrent callers race for the SAME stop: exactly one runs cleanup, exactly one is told it lost (22.216625ms)
✔ a stop claimed after cleanup already finished is told it lost, and does not re-run cleanup (0.145208ms)
✔ a caller that loses the race never sees onStop's return value or throws on its behalf (32.972875ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 114.784375
```

Both real failure modes, re-verified end to end against the actual launcher (a throwaway
copy with Foreman's spawn replaced by a command that fails immediately, or after an 8s
delay so a signal can land mid-wait):

```
=== Foreman crashes on start ===
[demo] --fresh: removing /Users/jordan.mance/.mission-control-demo
[demo] state root: /Users/jordan.mance/.mission-control-demo
[demo] booting the daemon on port 7417...
[demo] daemon is up (pid 15328), isolated under /Users/jordan.mance/.mission-control-demo
[demo] starting the real Foreman against the demo daemon...
[demo] Foreman exited before acquiring its lease (code 1, signal null):

[demo] foreman-failed: stopping (state root kept at /Users/jordan.mance/.mission-control-demo)
$ echo $?
1
$ lsof -i :7417
port 7417 is free - no leak

=== SIGINT sent mid-lease-wait ===
[demo] state root: /Users/jordan.mance/.mission-control-demo
[demo] booting the daemon on port 7417...
[demo] daemon is up (pid 16778), isolated under /Users/jordan.mance/.mission-control-demo
[demo] starting the real Foreman against the demo daemon...
(SIGINT sent to the launcher here)
[demo] SIGINT: stopping (state root kept at /Users/jordan.mance/.mission-control-demo)
[demo] Foreman exited before acquiring its lease (code null, signal SIGTERM):

$ lsof -i :7417
port 7417 is free - no leak
$ wait $LAUNCH_PID; echo $?
0
```

## 4. The dashboard, driven live - screenshot AND the real text content next to it

Captured with a throwaway Playwright script (Chromium already installed locally; not
committed, not under `e2e/`) against the real built dashboard and daemon at
`127.0.0.1:7417`, dispatching the `waiting-on-you` scenario end to end. Every step below has
a `.png` under `verification/` for a human to look at, and a `.txt` right next to it - the
exact `page.locator("body").innerText()` at that moment - so the actual rendered content is
plain, diffable text, not only pixels in a binary file.

### Step 1 - dispatch lands, the question is already waiting

[`verification/01-fleet-waiting-on-you.png`](verification/01-fleet-waiting-on-you.png) /
[`.txt`](verification/01-fleet-waiting-on-you.txt) - relevant excerpt of the real text
content:

```
WORKING
1
1 needs you
Surface rate limits on the dashboard
◈
Agent SDK
＋ workflow
needs an answer
...
There are two reasonable designs here and I don't want to guess wrong on the one that's user-facing.
...
WAITING ON YOU
answer each, then submit

Claude has some questions.

Rate limit UX
How should a rate limit show up in the summary?

1
Inline suffix
append "- rate limited (retry in Ns)" to the existing summary line
2
Separate banner
a distinct warning line above the summary

Countdown
Should the retry countdown be shown?

1
Yes
show the seconds remaining until retry
2
No
just say it's rate limited
Submit answers
```

The card's title (`Surface rate limits on the dashboard`) is the scenario player's answer
to the real task-titler call, not the fallback heuristic; both scripted questions and their
options render as real, literal page text.

### Step 2 - answering through the real form resumes the turn

[`verification/02-answered-resumed.png`](verification/02-answered-resumed.png) /
[`.txt`](verification/02-answered-resumed.txt) - captured immediately after clicking
"Inline suffix", "Yes", and the real **Submit answers** button:

```
WORKING
1
1 working
Surface rate limits on the dashboard
◈
Agent SDK
＋ workflow
working
...
Got it - an inline suffix with the countdown. Wiring that up now.
```

The "needs an answer"/"WAITING ON YOU" text from step 1 is gone; the card is `working`
again with the scenario's next line of narration - a real `POST
/api/sessions/:id/submit-options` resumed the turn.

### Step 3 - idle once the scenario finishes

[`verification/03-idle-after-scenario.png`](verification/03-idle-after-scenario.png) /
[`.txt`](verification/03-idle-after-scenario.txt):

```
WORKING
1
1 idle
Surface rate limits on the dashboard
◈
Agent SDK
＋ workflow
idle
```

### Step 4 - the Diff view shows the actual edit

[`verification/04-diff-view.png`](verification/04-diff-view.png) /
[`.txt`](verification/04-diff-view.txt) - the real text content of the opened diff modal:

```
Surface rate limits on the dashboard
harness/surface-rate-limits-on-the-dashb-68ae91 vs main
1 file +11 −3
✕
M
dashboard.ts
src
+11
−3
MODIFIED
src/dashboard.ts
+11
−3
Open in Files
↗
			@@ -4,7 +4,15 @@ export interface FleetCounts {
4	4		  idle: number;
5	5		}
6	6		 
7		−	/** A one-line summary of the fleet's current state. */
8		−	export function summarize(counts: FleetCounts): string {
9		−	  return `${counts.active} active, ${counts.waiting} waiting, ${counts.idle} idle`;
	7	+	export interface RateLimitState {
	8	+	  limited: boolean;
	9	+	  retryAfterMs: number | null;
	10	+	}
	11	+	 
	12	+	/** A one-line summary of the fleet's current state, including rate-limit backpressure. */
	13	+	export function summarize(counts: FleetCounts, rateLimit?: RateLimitState): string {
	14	+	  const base = `${counts.active} active, ${counts.waiting} waiting, ${counts.idle} idle`;
	15	+	  if (!rateLimit?.limited) return base;
	16	+	  const wait = rateLimit.retryAfterMs != null ? ` (retry in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s)` : "";
	17	+	  return `${base} - rate limited${wait}`;
10	18		}
```

`+11 −3` against `src/dashboard.ts`, rendered by the product's own diff view against a real
merge base - this is the literal text the browser had on screen, not a description of it.
