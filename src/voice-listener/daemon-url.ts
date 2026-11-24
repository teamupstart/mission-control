/** The standalone development listener talks to a local HTTP daemon. */
export function loopbackDaemonUrl(url: string): URL {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("Expected a loopback daemon URL");
  }
  return origin;
}
