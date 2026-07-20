// The last thing that touches any text on its way to a public GitHub comment.
//
// This is layer 5 of the leak defence, and it is the one written on the assumption
// that the other four failed. The reviewer runs with Read/Grep/Glob against a diff
// that anyone who can open a pull request controls, and its output is published where
// the whole internet can read it. The tool allowlist, the deny rules, the cwd scope
// and the requirement that a finding name a changed file are all meant to stop a
// crafted diff from turning the reviewer into an exfiltration channel. This is what
// stands there when one of them has a hole.
//
// So it is deliberately blunt: it redacts SHAPES, not context. It will occasionally
// redact a token-shaped string in a code sample, and that is the correct trade - a
// mangled example is a nuisance, a published credential is an incident.

interface Rule {
  re: RegExp;
  /** What replaces the match; `$1`-style captures are honoured. */
  with: string;
}

const REDACTED = "[redacted]";

const RULES: Rule[] = [
  // PEM blocks. First, and matched whole: a later rule chopping a key into pieces
  // would leave most of it on the page.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    with: `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  },
  // GitHub tokens, all current prefixes. Especially worth catching: the credential
  // the Inspector itself is posting with is one of these.
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, with: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, with: REDACTED },
  // Anthropic, OpenAI.
  { re: /\bsk-ant-[A-Za-z0-9\-_]{16,}/g, with: REDACTED },
  { re: /\bsk-[A-Za-z0-9]{32,}/g, with: REDACTED },
  // AWS access key ids, and the secret that usually sits beside one.
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, with: REDACTED },
  { re: /\baws_secret_access_key\s*[=:]\s*\S+/gi, with: `aws_secret_access_key = ${REDACTED}` },
  // Google / Slack.
  { re: /\bAIza[A-Za-z0-9\-_]{30,}/g, with: REDACTED },
  { re: /\bxox[abposr]-[A-Za-z0-9\-]{10,}/g, with: REDACTED },
  // JWTs - three base64url segments. The middle one carries the claims.
  { re: /\beyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}/g, with: REDACTED },
  // Assignments. The value must be QUOTED or unbroken-and-long: `const token = value`
  // in a code sample is ordinary prose about code, and redacting it would make the
  // reviewer useless at discussing exactly the code most worth discussing.
  {
    re: /\b(password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret)\b(\s*[:=]\s*)(["'][^"'\n]{8,}["']|[A-Za-z0-9+/=_\-]{20,})/gi,
    with: `$1$2${REDACTED}`,
  },
  // Basic-auth credentials embedded in a URL.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, with: `$1${REDACTED}@` },
];

/**
 * Redact credential-shaped strings from text bound for GitHub.
 *
 * Applied to every outbound body without exception - inline comments, the review
 * summary, and follow-up replies. The summary matters most and is the least obvious:
 * it is the one output that is NOT anchored to a changed file, so layer 4 doesn't
 * constrain it and this is the only thing between it and the page.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, rule.with);
  return out;
}
