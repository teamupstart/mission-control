import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResidentProfileRevisionSchema, type ResidentLoopStatus } from "../src/shared/residents.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import type { FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import { ResidentLoopStatusLine } from "../src/web/residents/ResidentLoopControls.tsx";
import { RESIDENT_EDITOR_SECTIONS, residentWeekSpans } from "../src/web/residents/editor-sections.tsx";

const on: FeatureFlagsConfig = { enableAll: false, overrides: { "resident-active-hours": true } };
const off: FeatureFlagsConfig = { enableAll: false, overrides: {} };
const HOUR = 3_600_000;
const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);
/** Every day, a UTC window from `from` to `to` hours away from now (an overnight window wraps). */
function windowFromNow(from: number, to: number) {
  const now = Date.now();
  return ResidentProfileRevisionSchema.parse({
    identity: { name: "Night Watch" }, persona: { personaId: "p" },
    schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(now + from * HOUR), end: hhmm(now + to * HOUR), timeZone: "UTC" },
  });
}

function statusLine(flags: FeatureFlagsConfig, nextWakeAt: number, settings = windowFromNow(3, 4)) {
  const loop: ResidentLoopStatus & { settings: typeof settings } = {
    loopState: "waiting", iteration: 3, lastSeq: 3, nextWakeAt, consumedGeneration: 2, pauseReason: null, wakeReason: null, runRequestedAt: null, settings,
  };
  return renderToStaticMarkup(createElement(FeatureFlagsContext.Provider, { value: flags }, createElement(ResidentLoopStatusLine, { loop })));
}

test("a waiting resident outside its active hours reads as asleep with the time its wake goes out", () => {
  // The window opens three hours from now, so now and a wake due in an hour are both outside it.
  const due = Date.now() + HOUR;
  const html = statusLine(on, due);
  assert.match(html, /asleep · iteration 3 · wakes /);
  assert.doesNotMatch(html, /next in/);
  assert.match(statusLine(off, due), /waiting · iteration 3 · next in/, "the preview off: the ordinary countdown");
});

test("inside its window a resident whose next wake is held reads as waiting, with the held wake's time", () => {
  // Awake now (the window closes in an hour), but the wake due in two hours falls after it closes.
  const html = statusLine(on, Date.now() + 2 * HOUR, windowFromNow(-1, 1));
  assert.match(html, /waiting · iteration 3 · wakes /, "still awake: not asleep before the window closes");
  assert.doesNotMatch(html, /asleep|next in/);
  // A wake due inside the open window is the ordinary countdown.
  assert.match(statusLine(on, Date.now() + 30 * 60_000, windowFromNow(-1, 1)), /waiting · iteration 3 · next in 30m/);
});

test("the Active hours section is a preview section with day toggles, times and a week strip", () => {
  const section = RESIDENT_EDITOR_SECTIONS.find((entry) => entry.id === "schedule");
  assert.ok(section);
  assert.equal(section.featureFlag, "resident-active-hours");
  const workday = ResidentProfileRevisionSchema.parse({ identity: { name: "Day" }, persona: { personaId: "p" }, schedule: { enabled: true } });
  const html = renderToStaticMarkup(createElement(section.Body, { draft: workday, update: () => {}, personas: [], disabled: false }));
  assert.match(html, /Sleep outside active hours/);
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) assert.match(html, new RegExp(`aria-pressed="true" aria-label="${day}"`));
  for (const day of ["Saturday", "Sunday"]) assert.match(html, new RegExp(`aria-pressed="false" aria-label="${day}"`));
  assert.match(html, /type="time"[^>]* value="09:00"/);
  assert.match(html, /type="time"[^>]* value="17:00"/);
  // Every control explains itself on hover, as the shared Tooltip does elsewhere.
  assert.match(html, /class="tt-desc">Wake this resident on Saturdays</);
  assert.match(html, /class="tt-desc">The clock the wake and sleep times are read on</);
  assert.match(html, /aria-label="Weekly active hours: Mon–Fri, 09:00–17:00 \(/);
});

test("the week strip draws a night shift's tail on the following day", () => {
  const spans = residentWeekSpans({ days: [5], start: "22:00", end: "06:00" });
  assert.deepEqual(spans.get(5), [[1320, 1440]]);
  assert.deepEqual(spans.get(6), [[0, 360]]);
  assert.deepEqual(spans.get(1), []);
});
