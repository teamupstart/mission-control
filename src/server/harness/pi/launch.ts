import { randomUUID } from "node:crypto";

export interface PiLaunchPreparation {
  args: string[];
  sessionId: string;
}

/**
 * Give Pi both its durable identity and turn one on the launch argv.
 *
 * Pi keeps a new session entirely in memory until its first assistant record. Waiting for
 * that JSONL file before typing the prompt is therefore a deadlock: the file needs the turn
 * whose delivery is waiting on the file. The CLI's positional-message path feeds the same
 * `session.prompt()` the interactive composer does, after the TUI has initialized, so it is
 * also a stronger delivery boundary than guessing when the pane is ready for keystrokes.
 *
 * Pi has no `--` end-of-options marker. A task beginning with `-` would otherwise be parsed
 * as a flag, and one beginning with `@` as a file operand, so prefix either case with a
 * newline. It is semantically whitespace to the model while making the argument
 * unambiguously positional to Pi's parser.
 */
export function preparePiLaunch(prompt: string): PiLaunchPreparation {
  const sessionId = randomUUID();
  const initialMessage = prompt.startsWith("-") || prompt.startsWith("@") ? `\n${prompt}` : prompt;
  return { args: ["--session-id", sessionId, initialMessage], sessionId };
}
