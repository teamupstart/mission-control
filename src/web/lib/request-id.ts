/** An idempotency key accepted by UUID-validated routes, including on plain HTTP. */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Only reachable in a non-secure context, where `randomUUID` is absent. The id is a
  // duplicate guard, not a secret, so a v4-shaped fallback is sufficient and the daemon
  // validates its shape either way.
  const hex = "0123456789abcdef";
  const pick = (): string => hex[Math.floor(Math.random() * 16)]!;
  const block = (n: number): string => Array.from({ length: n }, pick).join("");
  return `${block(8)}-${block(4)}-4${block(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${block(3)}-${block(12)}`;
}
