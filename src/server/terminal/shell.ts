export function shellCommand(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
}

/**
 * The exact inverse of `shellCommand`, for reading a command back into the words it encodes.
 *
 * Here rather than in a test helper because there are two callers that cannot import each
 * other - `test/helpers/isolated-launch.ts` and `e2e/fixtures/isolated-launch.ts`, which live
 * on opposite sides of the `test/` and `e2e/` line - and the decoding is subtle enough that
 * two spellings would drift. `shellCommand` renders an apostrophe as `'"'"'`, so a naive
 * `/'([^']*)'/` reads a word containing one as the fragment after it, which is a truncated
 * path rather than a failed match.
 *
 * Only the encoding above is understood: single-quoted words separated by spaces. Anything
 * this file did not write - a bare word, a double-quoted string, a variable - comes back as
 * the whitespace-separated token it appears to be, which is enough for a caller that is
 * inspecting a command it also produced.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < command.length) {
    if (/\s/.test(command[index]!)) {
      index += 1;
      continue;
    }
    let word = "";
    while (index < command.length && !/\s/.test(command[index]!)) {
      if (command[index] === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) {
          word += command.slice(index + 1);
          index = command.length;
          break;
        }
        word += command.slice(index + 1, close);
        index = close + 1;
        continue;
      }
      if (command[index] === '"') {
        const close = command.indexOf('"', index + 1);
        if (close === -1) {
          word += command.slice(index + 1);
          index = command.length;
          break;
        }
        word += command.slice(index + 1, close);
        index = close + 1;
        continue;
      }
      word += command[index];
      index += 1;
    }
    words.push(word);
  }
  return words;
}
