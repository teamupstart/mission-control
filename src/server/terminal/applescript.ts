/** Quote AppleScript literal source. Use appleScriptText when CR or LF must survive evaluation. */
export function appleScriptString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

/** Build an AppleScript text expression that preserves embedded control characters. */
export function appleScriptText(value: string): string {
  const expressions: string[] = [];
  let literalStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const characterId = value.charCodeAt(index);
    if (characterId !== 10 && characterId !== 13) continue;

    if (literalStart < index) expressions.push(appleScriptString(value.slice(literalStart, index)));
    expressions.push(`(character id ${characterId})`);
    literalStart = index + 1;
  }

  if (literalStart < value.length) expressions.push(appleScriptString(value.slice(literalStart)));
  return expressions.length > 0 ? expressions.join(" & ") : appleScriptString(value);
}
