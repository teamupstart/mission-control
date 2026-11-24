/**
 * One line for a notice. The engine draws a notice as a single line and shows a newline in it as a
 * replacement character, so a multi-line text (the draft summary is one) is joined: lines are
 * trimmed, blanks dropped, and each is separated from the last by a middle dot, except that a line
 * ending in a colon runs straight into the next (`Description: add retries`).
 */
export function noticeLine(text: string): string {
  let out = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (out === "") out = line;
    else out += (out.endsWith(":") ? " " : " · ") + line;
  }
  return out;
}
