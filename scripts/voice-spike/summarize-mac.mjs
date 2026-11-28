// Summarize saved operator measurements without reopening hardware or model providers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.tmp/voice-spike');
const dir = process.argv[2] ?? readFileSync(`${root}/followup-latest.txt`, 'utf8').trim();
const rows = name => readFileSync(`${dir}/${name}.log`, 'utf8').split('\n').flatMap(line => {
  const start = line.indexOf('{');
  if (start < 0) return [];
  return [JSON.parse(line.slice(start))];
});
const median = values => {
  const a = [...values].sort((a, b) => a - b);
  return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null;
};
const range = values => values.length ? [Math.min(...values), Math.max(...values)] : null;
const emit = value => console.log(JSON.stringify(value));
for (const mode of ['allowed', 'denied']) {
  emit({ question: 'S4', mode, records: rows(`permission-${mode}`) });
}
const keys = rows('hotkey');
for (const id of [1, 2]) {
  let pressed; const holds = []; let unmatched = 0;
  const events = keys.filter(x => x.id === id && x.event);
  for (const row of events) {
    if (row.event === 'press') {
      if (pressed !== undefined) unmatched++;
      pressed = row.uptime;
    } else if (pressed === undefined) unmatched++;
    else { holds.push((row.uptime - pressed) * 1000); pressed = undefined; }
  }
  if (pressed !== undefined) unmatched++;
  emit({ question: 'S5', id, registration: keys.find(x => x.id === id && 'registerStatus' in x),
    presses: events.filter(x => x.event === 'press').length,
    releases: events.filter(x => x.event === 'release').length, matchedHoldMs: holds, unmatched });
}
for (const stage of ['unmuted', 'muted', 'left', 'own']) {
  const all = rows(`calls-${stage}`); const polls = all.filter(x => x.pollMs !== undefined);
  emit({ question: 'S6', stage, polls: polls.length,
    zoomActive: polls.filter(x => x.inputProcesses.some(p => p.bundle === 'us.zoom.xos' && !p.ignored)).length,
    ownIgnored: polls.filter(x => x.inputProcesses.some(p => p.ignored)).length,
    nonIgnoredActive: polls.filter(x => x.inputProcesses.some(p => !p.ignored)).length,
    medianMs: median(polls.map(x => x.pollMs)), maxMs: range(polls.map(x => x.pollMs))?.[1],
    staleObjects: polls.reduce((n, x) => n + x.staleObjects, 0), errors: all.filter(x => x.error) });
}
const feedback = rows('feedback');
for (const mode of ['quiet', 'listening', 'paused-0ms', 'paused-250ms']) {
  const matches = id => id === mode || id?.startsWith(mode + '-');
  const metrics = feedback.filter(x => matches(x.feedback));
  const transcripts = feedback.filter(x => matches(x.feedbackTranscript));
  emit({ question: 'S9', mode, trials: metrics.length, transcripts: transcripts.map(x => x.text),
    recognized: transcripts.filter(x => x.text.trim()).length,
    restartAfterSayMs: range(metrics.map(x => x.restartAfterSayMs).filter(x => x !== undefined)),
    rms: range(metrics.map(x => x.rms)), frames: metrics.map(x => x.frames) });
}
for (const note of ['denial', 'hotkey', 'calls', 'feedback']) {
  emit({ note, text: readFileSync(`${dir}/${note}-operator.txt`, 'utf8').trim() });
}
