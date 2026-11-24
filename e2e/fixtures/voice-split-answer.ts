/** Classify the named occurrence in the scripted address pattern used by the browser fixtures. */
export function fixtureSplitAnswer(instructions: string, speech: string, input: string, question: string): "split" | "mention" | "not sure" {
  const prefix = `Roster for ${question}: `;
  const roster = input.split("\n").find(line => line.startsWith(prefix));
  const name: string | undefined = roster && JSON.parse(roster.slice(prefix.length)).later;
  const offset = /^Judge only the name at offset (\d+)\./mu.exec(instructions)?.[1];
  if (!name || offset === undefined) return "not sure";

  const at = Number(offset);
  const end = at + name.length;
  if (speech.slice(at, end).toLowerCase() !== name.toLowerCase()) return "not sure";
  const startsCommand = /[,.;]\s*(?:(?:and(?:\s+then)?|then)\s+)?$/iu.test(speech.slice(0, at));
  return startsCommand && speech[end] === "," ? "split" : "mention";
}
