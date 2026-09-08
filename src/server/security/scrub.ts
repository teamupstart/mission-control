// This is the final defense for text leaving a trusted server boundary. It is
// deliberately shape-based: mangling a token-shaped example is safer than publishing
// an actual credential. Callers retain ownership of their separate path and tool grants.
interface Rule {
  re: RegExp;
  with: string;
}

const REDACTED = "[redacted]";
const CONTENT_RULES: readonly Rule[] = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    with: `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, with: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, with: REDACTED },
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, with: REDACTED },
  { re: /\bsk-[A-Za-z0-9]{32,}/g, with: REDACTED },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, with: REDACTED },
  { re: /\baws_secret_access_key\s*[=:]\s*\S+/gi, with: `aws_secret_access_key = ${REDACTED}` },
  { re: /\bAIza[A-Za-z0-9\-_]{30,}/g, with: REDACTED },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, with: REDACTED },
  { re: /\beyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}/g, with: REDACTED },
  {
    re: /\b(password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret)\b(\s*[:=]\s*)(["'][^"'\n]{8,}["']|[A-Za-z0-9+/=_-]{20,})/gi,
    with: `$1$2${REDACTED}`,
  },
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, with: `$1${REDACTED}@` },
];

/** Provider-neutral defense-in-depth scrubbing for text leaving a trusted server boundary. */
export function scrubSecrets(text: string): string {
  let output = text;
  for (const rule of CONTENT_RULES) output = output.replace(rule.re, rule.with);
  return output;
}
