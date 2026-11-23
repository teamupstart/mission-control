/**
 * Plain-text helpers for what a worker or the daemon wrote. Task titles, questions and plan
 * summaries come from a model, so nothing here lets them reach the terminal as anything but
 * characters: escape sequences and control codes are removed, never interpreted.
 */

// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\u001b[@-Z\\-_]?/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Text with escape sequences and control characters removed; newlines and tabs become spaces. */
export function plain(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESC, "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(CONTROL, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function plainLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => plain(line.replace(/\t/g, " ")))
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""));
}

export function clip(text: string, columns: number): string {
  const width = Math.max(8, columns);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function wrap(text: string, columns: number): string[] {
  const width = Math.max(12, columns);
  const out: string[] = [];
  for (const paragraph of plainLines(text)) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of paragraph.split(" ")) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = "";
      }
      line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
