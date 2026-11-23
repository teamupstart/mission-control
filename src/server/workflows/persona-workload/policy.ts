import { scrubSecrets } from "../../inspector/scrub.ts";
export {
  approvedPath,
  matchesGlob,
  INSPECTOR_DENY_PATHS,
} from "@shared/repository-policy.ts";

/** Scrubbing must not shift repository line coordinates (notably multi-line PEM blocks). */
export function scrubRepositoryText(text: string): string {
  const scrubbed = scrubSecrets(text);
  if (text.split("\n").length === scrubbed.split("\n").length) return scrubbed;
  return text
    .split("\n")
    .map((line) => (line.length ? "[redacted]" : ""))
    .join("\n");
}
