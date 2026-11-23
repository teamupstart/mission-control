import { z } from "zod";
export const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !/[:\\]/.test(path) &&
      [...path].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) &&
      !path.startsWith("/") &&
      !path.startsWith("-") &&
      [...path].every(
        (c) => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff,
      ) &&
      path
        .split("/")
        .every(
          (segment) =>
            segment !== "" &&
            segment !== "." &&
            segment !== ".." &&
            new TextEncoder().encode(segment).length <= 255,
        ),
    "Expected a canonical repository-relative POSIX path",
  );
export const RepositoryGlobSchema = RepositoryPathSchema.max(256).refine(
  (path) => ![...path].some((c) => "[]{}!".includes(c)),
  "Only * and ? glob syntax is supported",
);
/** Inspector's historical grant stays byte-identical; the sparse view has a stricter policy. */
export const INSPECTOR_DENY_PATHS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.git/config",
  "**/.npmrc",
  "**/.netrc",
  "**/credentials*",
  "//Users/*/.aws/**",
  "//Users/*/.ssh/**",
  "//Users/*/.claude/**",
  "//Users/*/.mission-control/**",
];
export function approvedPath(path: string): boolean {
  if (!RepositoryPathSchema.safeParse(path).success) return false;
  return path.split("/").every((part) => {
    const p = part.toLowerCase();
    return (
      !p.startsWith(".env") &&
      !p.startsWith("credentials") &&
      !/^id_(rsa|ed25519|ecdsa|dsa)/.test(p) &&
      !/\.(pem|key|p12|pfx|crt|cer|keystore)$/.test(p) &&
      ![
        ".git",
        ".npmrc",
        ".netrc",
        ".aws",
        ".ssh",
        ".claude",
        ".codex",
        ".mission-control",
        ".harness",
        ".fleet",
        "secrets.json",
        "secrets.yaml",
        "secrets.yml",
        "auth.json",
      ].includes(p)
    );
  });
}
/** Dynamic programming, not a backtracking regular expression over model-controlled patterns. */
export function matchesGlob(path: string, glob: string): boolean {
  RepositoryGlobSchema.parse(glob);
  const text = [...path],
    pattern = [...glob];
  let previous = new Uint8Array(text.length + 1);
  previous[0] = 1;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    let token = char;
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      token = "**";
      if (pattern[i + 1] === "/") {
        i++;
        token = "**/";
      }
    }
    const next = new Uint8Array(text.length + 1);
    if (token.startsWith("*")) next[0] = previous[0]!;
    let prefix = false;
    for (let j = 1; j <= text.length; j++) {
      prefix ||= previous[j - 1] === 1;
      if (token === "**/")
        next[j] = previous[j] || Number(prefix && text[j - 1] === "/");
      else if (token === "*" || token === "**")
        next[j] =
          previous[j] ||
          Number(next[j - 1] === 1 && (token === "**" || text[j - 1] !== "/"));
      else
        next[j] = Number(
          previous[j - 1] === 1 &&
            (token === "?" ? text[j - 1] !== "/" : text[j - 1] === token),
        );
    }
    previous = next;
  }
  return previous[text.length] === 1;
}
