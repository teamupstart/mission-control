/**
 * How a dropped image reaches an agent: as a path in the prompt.
 *
 * This mirrors what a terminal does when you drag a file onto it - the path
 * appears as text, and the agent reads it with its own file tools. There is no
 * richer channel available (the last hop is keystrokes into a pty), and there
 * doesn't need to be: a path is exactly what each shipped harness can act on with its
 * own file tools.
 */

/** An uploaded image, as the UI carries it and the prompt cites it. */
export interface Attachment {
  /** Absolute path on the daemon's host - the agent reads this. */
  path: string;
  /** Stored basename, shown on the chip. */
  name: string;
}

/**
 * Render one path as a prompt-safe token, quoting only when it must.
 *
 * Uploads are stored under names that can't need quoting (see `uploadFileName`),
 * but the state dir they hang off is the user's - and a home directory with a
 * space in it would otherwise paste as two half-paths.
 */
export function formatAttachmentPath(path: string): string {
  return /^[A-Za-z0-9._\-/]+$/.test(path) ? path : `"${path.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Append attachment paths to a message, each on its own line.
 *
 * Bare paths, with no "attached:" preamble - the prompt belongs to the human, and
 * a path is already the whole instruction as far as the agent is concerned.
 * Paths go on their own lines rather than trailing the prose so a long message
 * stays readable in the pane, which means the result MUST be delivered as one
 * bracketed paste (`injectPrompt`), never `sendText`, whose literal newlines each
 * submit.
 */
export function withAttachments(text: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return text;
  const paths = attachments.map((a) => formatAttachmentPath(a.path)).join("\n");
  const body = text.trim();
  return body ? `${body}\n\n${paths}` : paths;
}
