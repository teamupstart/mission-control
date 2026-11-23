import { createHash } from 'node:crypto';

/** The check lease's existing macOS start-time + command digest format. */
export function darwinCheckIdentity(raw) {
  let printable = '';
  for (const ch of String(raw ?? '')) {
    const code = ch.codePointAt(0);
    printable += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const line = printable.replace(/\s+/g, ' ').trim();
  const tokens = line.split(' ');
  if (tokens.length < 6) return null;
  const start = tokens.slice(0, 5).join(' ');
  const command = tokens.slice(5).join(' ');
  const digest = createHash('sha256').update(command).digest('hex').slice(0, 32);
  return ['darwin', start, digest].join(String.fromCharCode(0x1f));
}
