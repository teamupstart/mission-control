// The shapes of well-known credentials, in one place for every caller that needs them: the
// Inspector's outbound scrubber redacts them, and the task-shaping schema refuses a command
// argument that holds one. Browser-safe: no `node:` imports.
//
// These are SHAPES, not context. A match is a credential with high confidence whatever surrounds
// it, which is why a caller may act on one without asking what the text means.

/** A private key's armour header. A body without its header is not recognisable as a key. */
export const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Token prefixes and formats, each matched from a word boundary. */
export const SECRET_TOKEN_SHAPES: readonly RegExp[] = [
  // GitHub tokens, all current prefixes.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // Anthropic, OpenAI.
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  // OpenAI project, service-account and admin keys, whose prefix carries its own hyphen.
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  // Google, Slack.
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  // GitLab personal access tokens, npm tokens.
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  // JWTs: three base64url segments. The middle one carries the claims.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

/** Whether `text` holds a well-known credential: a token shape or a private key header. */
export function holdsSecretShape(text: string): boolean {
  return PRIVATE_KEY_HEADER.test(text) || SECRET_TOKEN_SHAPES.some((shape) => shape.test(text));
}
