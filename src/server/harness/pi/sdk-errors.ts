/**
 * What went wrong with a managed Pi session, in words an operator can act on.
 *
 * Separate from `sdk.ts` because BOTH halves of the driver raise these: `sdk-deps.ts` is
 * where a model id fails to resolve against Pi's own catalog and where a provider turns
 * out to have no credential, and `sdk.ts` is where a turn comes back with a provider
 * failure. One vocabulary, so the dashboard cannot show two different sentences for the
 * same condition depending on which side of the seam noticed it.
 */
export type PiFailureKind =
  /** The vendor package could not be loaded at all. Terminal Pi is unaffected. */
  | "sdk-unavailable"
  /** Pi knows the provider but holds no credential for it. */
  | "provider-signed-out"
  /** A credential exists and the provider rejected it - an expired SSO or profile. */
  | "credentials-expired"
  /** Authenticated, but this account may not call this model. */
  | "access-denied"
  /** The exact model id is not in Pi's catalog for this configuration. */
  | "model-unavailable"
  /** The model exists but not where this configuration points. */
  | "region-unavailable"
  /** The stored Pi conversation is gone, or Pi refused to reopen it. */
  | "resume-unavailable"
  /** Everything else the provider said. */
  | "provider-error";

/**
 * How much of a provider's own message survives into a card, a log, or a task note.
 *
 * Bounded because an untrusted string ends up in SQLite and on a dashboard, and provider
 * errors carry request echoes that can run to kilobytes.
 */
export const PI_FAILURE_MESSAGE_CAP = 400;

/**
 * Fragments that must never leave this boundary, whatever surrounds them.
 *
 * These are matched on the SHAPE of the secret rather than on the wording around it, so a
 * provider that reformats its error next release does not silently start leaking. Bedrock
 * failures are the reason the list exists: an expired-token error from AWS quotes the
 * request's own `Authorization` header and its `X-Amz-Security-Token` back at the caller,
 * and an SSO refusal can carry the session token inline.
 */
const SECRETS: readonly RegExp[] = [
  // AWS access key ids: AKIA/ASIA/AROA/AIDA + 16 uppercase alphanumerics.
  /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  // `key=value` credential assignments, in either an env or a query-string spelling.
  /\b(?:aws_)?(?:secret_access_key|session_token|security_token|access_key_id|api[_-]?key|client_secret|refresh_token|id_token|access_token|password)\b\s*[=:]\s*\S+/gi,
  // A scheme-and-token pair, BEFORE the `Authorization` rule below rather than after it.
  //
  // The order is the whole of this fix. `Authorization: Bearer <token>` is the commonest
  // header shape there is, and a whitespace-bounded value pattern consumes only the word
  // `Bearer` from it - leaving the token, and destroying the very word this rule needs to
  // find it by. Redacting the pair first means the generic rule below can only ever see an
  // already-redacted value.
  // Case-INSENSITIVE, because a provider that lowercases its echo (`bearer <token>`) is
  // still echoing the token, and this rule is the only one that would have caught it: the
  // `Authorization` rule below needs the header name, which a bare scheme does not carry.
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // Authorization headers, whatever scheme they name, INCLUDING the scheme's own token.
  // `\S+` alone stops at the first space, which on a two-part credential is exactly where
  // the secret begins.
  /\bAuthorization\b\s*[=:]\s*(?:[A-Za-z][\w-]*[ \t]+)?\S+/gi,
  /\bX-Amz-(?:Security-Token|Credential|Signature)\b\s*[=:]\s*\S+/gi,
  // JSON web tokens, which carry an identity whether or not they are still valid.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** The placeholder a removed secret leaves behind, so the redaction is visible. */
export const REDACTED = "[redacted]";

/**
 * Strip credential material from a provider message and bound what is left.
 *
 * Applied to EVERY string this driver puts into an event, a thrown error or a log line -
 * there is no path that formats a provider failure without going through here, which is
 * what makes "Mission Control never stores an AWS secret" a property of the code rather
 * than of the messages we happen to have seen.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRETS) out = out.replace(pattern, REDACTED);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > PI_FAILURE_MESSAGE_CAP
    ? `${out.slice(0, PI_FAILURE_MESSAGE_CAP - 1)}…`
    : out;
}

/** A managed Pi failure, carrying its classification so callers never re-parse prose. */
export class PiSdkError extends Error {
  constructor(
    readonly kind: PiFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(redact(message), options);
    this.name = "PiSdkError";
  }
}

/** The repair sentence for a kind, or `""` when the condition names its own remedy. */
function remedyFor(kind: PiFailureKind, provider: string | null): string {
  const login = provider ? `/login ${provider}` : "/login <provider>";
  switch (kind) {
    case "provider-signed-out":
      return `open a Pi session and run ${login}`;
    case "credentials-expired":
      return `refresh the credential in Pi with ${login} - Mission Control never stores it`;
    case "access-denied":
      return "grant this account access to the model in its provider console";
    case "model-unavailable":
      return "pick a model Pi currently lists, or configure this one in Pi";
    case "region-unavailable":
      return "choose a region that offers this model in Pi's provider configuration";
    case "resume-unavailable":
      return "start a new session - this conversation cannot be reopened";
    case "sdk-unavailable":
      return "run this session in a terminal instead";
    case "provider-error":
      return "";
  }
}

/**
 * Turn a raw provider or SDK failure into one classified, redacted sentence.
 *
 * Matching is on the vocabulary AWS and Pi actually use - `ExpiredToken`,
 * `AccessDeniedException`, `ValidationException ... not supported in region`, Pi's own
 * "Run '/login <provider>'" and "No API key found". Nothing here decides WHETHER a session
 * survives; it decides what the operator is told. An unrecognized message is
 * `provider-error` and is passed through redacted rather than guessed at, because a wrong
 * repair instruction is worse than none.
 */
export function classifyPiFailure(error: unknown, provider: string | null): PiSdkError {
  if (error instanceof PiSdkError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const kind = classifyKind(raw);
  const remedy = remedyFor(kind, provider);
  const detail = redact(raw);
  return new PiSdkError(kind, remedy ? `${detail} - ${remedy}` : detail, { cause: error });
}

function classifyKind(raw: string): PiFailureKind {
  const text = raw.toLowerCase();
  if (/expiredtoken|token.*(has )?expired|expired.*(token|credential|session)|invalidclienttokenid|sso session .*expired/.test(text)) {
    return "credentials-expired";
  }
  if (/accessdenied|not authorized to perform|unrecognizedclient|you don't have access to the model|access to the model.*denied/.test(text)) {
    return "access-denied";
  }
  if (/run '\/login|no api key found|no credential|not signed in|authentication failed for/.test(text)) {
    return "provider-signed-out";
  }
  if (/not supported in .*region|is not available in .*region|could not be found in region|invalid.*region/.test(text)) {
    return "region-unavailable";
  }
  if (/resourcenotfound|model.*(not found|is not available)|unknown model/.test(text)) {
    return "model-unavailable";
  }
  return "provider-error";
}
