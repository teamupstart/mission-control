export function shellCommand(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
}
