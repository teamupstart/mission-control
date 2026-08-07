import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The records the fake agents have finished writing under `dir`, oldest first.
 *
 * The fakes record their own argv and env, which is how a spec asserts properties of a launch that
 * no amount of DOM inspection could reach - which model flag was passed, whether the pane
 * variables were stripped, what command a terminal was handed. Every caller reads this inside an
 * `expect.poll`, because a card is registered before the child it launched has run far enough to
 * write anything.
 *
 * A file being WRITTEN right now is not a record yet, and that is the whole reason this is shared.
 * Creating the file and filling it are two operations, so a poll can land in between and read
 * nothing or half a line; `JSON.parse` then throws OUT of the poll, and the spec fails on a race
 * rather than on the argv it exists to inspect. Observed as `SyntaxError: Unexpected end of JSON
 * input` in `continue-in-terminal-mode`, and latent in two other specs that had copied the same
 * unguarded read. Skipping an unparseable file lets the next poll see the whole thing, and a
 * record that never arrives still fails the poll on its own terms.
 *
 * Shared rather than copied a fourth time, for the reason `settle.ts` gives about itself: the
 * second copy is how the third gets subtly different behaviour.
 */
export function recordsIn<T>(
  dir: string,
  matches: (file: string) => boolean = (file) => file.endsWith(".json"),
): T[] {
  if (!existsSync(dir)) return [];
  const records: T[] = [];
  for (const file of readdirSync(dir).filter(matches).sort()) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as T);
    } catch {
      // Half-written, or gone since the listing. Either way, not yet a record.
    }
  }
  return records;
}
