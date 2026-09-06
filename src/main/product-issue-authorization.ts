// The desktop shell's one-click authorization for public product issue publishing.
//
// The renderer can arm an exact report only through the preload bridge. The daemon can consume
// that arm only through the private utility-process port. No loopback HTTP caller participates
// in either half, so calling preview and confirm cannot mint publishing authority by itself.

import type { UtilityProcess } from "electron";
import type {
  ProductIssueAuthorizationMessage,
  ProductIssueAuthorizationReply,
} from "../server/product-issue-authorization.ts";

const AUTHORIZATION_TTL_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY = /^[0-9a-f]{64}$/;

interface ArmedAuthorization {
  requestId: string;
  draftIdentity: string;
  expiresAt: number;
}

const armed = new Map<string, ArmedAuthorization>();

function key(requestId: string, draftIdentity: string): string {
  return `${requestId}:${draftIdentity}`;
}

function purgeExpired(now: number): void {
  for (const [entryKey, entry] of armed) {
    if (entry.expiresAt <= now) armed.delete(entryKey);
  }
}

/** Arm the exact preview named by a real renderer Report click. */
export function armProductIssueAuthorization(value: unknown, now = Date.now()): boolean {
  if (typeof value !== "object" || value === null) return false;
  const input = value as { requestId?: unknown; draftIdentity?: unknown };
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return false;
  if (typeof input.draftIdentity !== "string" || !IDENTITY.test(input.draftIdentity)) return false;
  purgeExpired(now);
  const authorization = {
    requestId: input.requestId,
    draftIdentity: input.draftIdentity,
    expiresAt: now + AUTHORIZATION_TTL_MS,
  };
  armed.set(key(authorization.requestId, authorization.draftIdentity), authorization);
  return true;
}

export function clearProductIssueAuthorizations(): void {
  armed.clear();
}

function consumeProductIssueAuthorization(
  requestId: string,
  draftIdentity: string,
  now = Date.now(),
): boolean {
  purgeExpired(now);
  const entryKey = key(requestId, draftIdentity);
  const authorization = armed.get(entryKey);
  if (!authorization) return false;
  armed.delete(entryKey);
  return true;
}

function isAuthorizationAsk(value: unknown): value is ProductIssueAuthorizationMessage {
  if (typeof value !== "object" || value === null) return false;
  const ask = value as Partial<ProductIssueAuthorizationMessage>;
  return (
    ask.type === "mission:product-issue-authorization" &&
    typeof ask.id === "string" &&
    typeof ask.requestId === "string" &&
    typeof ask.draftIdentity === "string" &&
    typeof ask.target === "string" &&
    typeof ask.title === "string"
  );
}

/** Answer daemon authorization requests without displaying another modal. */
export function serveProductIssueAuthorization(child: UtilityProcess): void {
  clearProductIssueAuthorizations();
  child.on("message", (message: unknown) => {
    if (!isAuthorizationAsk(message)) return;
    const granted = consumeProductIssueAuthorization(
      message.requestId,
      message.draftIdentity,
    );
    child.postMessage({
      type: "mission:product-issue-authorization-reply",
      id: message.id,
      granted,
    } satisfies ProductIssueAuthorizationReply);
  });
}
