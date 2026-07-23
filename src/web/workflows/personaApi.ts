import type { PersonaView } from "@shared/workflow.ts";

interface PersonaErrorBody {
  error?: string;
  code?: string;
  current?: PersonaView | null;
}

export async function personaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & PersonaErrorBody;
  if (!response.ok) {
    const error = new Error(body.error ?? `Persona request failed (${response.status})`) as Error & {
      status: number;
      body: PersonaErrorBody;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function deriveImportedPersonaName(filename: string, markdown: string): string {
  const heading = /^#\s+(.+?)\r?$/m.exec(markdown)?.[1]?.trim();
  if (heading) return heading;
  return filename.replace(/\.md$/i, "").trim() || "Imported Persona";
}

export function personaMarkdownBlob(markdown: string): Blob {
  return new Blob([markdown], { type: "text/markdown;charset=utf-8" });
}
