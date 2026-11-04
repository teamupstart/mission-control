import type {
  CreateResidentMcpServer,
  ResidentMcpCatalog,
  ResidentMcpCustomServerView,
  UpdateResidentMcpServer,
} from "@shared/resident-mcp.ts";
import type { ResidentSkillIndex, ResidentSkillSources } from "@shared/resident-skills.ts";
import { actionFetch } from "../lib/experience.ts";
import type { ResidentProfile, ResidentProfileRevision } from "@shared/residents.ts";

/** A refused profile write, carrying the current profile when the daemon sent one. */
export class ResidentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly profile: ResidentProfile | null,
  ) {
    super(message);
  }
}

async function residentRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await actionFetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    profile?: ResidentProfile;
  };
  if (!response.ok) {
    throw new ResidentRequestError(
      body.error ?? `Resident request failed (${response.status})`,
      response.status,
      body.profile ?? null,
    );
  }
  return body;
}

export function createResidentProfile(settings: ResidentProfileRevision): Promise<ResidentProfile> {
  return residentRequest<ResidentProfile>("/api/residents/profiles", {
    method: "POST",
    body: JSON.stringify({ settings }),
  });
}

export function updateResidentProfile(
  id: string,
  expectedRevision: number,
  settings: ResidentProfileRevision,
): Promise<ResidentProfile> {
  return residentRequest<ResidentProfile>(`/api/residents/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision, settings }),
  });
}

export function archiveResidentProfile(id: string, expectedRevision: number): Promise<ResidentProfile> {
  return residentRequest<ResidentProfile>(`/api/residents/profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
  });
}

export function controlResident(id: string, action: "pause" | "resume" | "run-now" | "restart"): Promise<unknown> {
  return residentRequest(`/api/residents/runs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}
export function fetchResidentSkills(): Promise<ResidentSkillIndex> {
  return residentRequest("/api/residents/skills", { method: "GET" });
}
export function rescanResidentSkills(): Promise<ResidentSkillIndex> {
  return residentRequest("/api/residents/skills/rescan", { method: "POST", body: "{}" });
}
export function saveResidentSkillSources(config: ResidentSkillSources, expectedRevision: string): Promise<ResidentSkillIndex> {
  return residentRequest("/api/residents/skill-sources", { method: "PUT", body: JSON.stringify({ config, expectedRevision }) });
}

export function fetchResidentMcpCatalog(): Promise<ResidentMcpCatalog> {
  return residentRequest("/api/residents/mcp-catalog", { method: "GET" });
}
export function refreshResidentMcpCatalog(): Promise<ResidentMcpCatalog> {
  return residentRequest("/api/residents/mcp-catalog/refresh", { method: "POST", body: "{}" });
}
export function createResidentMcpServer(input: CreateResidentMcpServer): Promise<ResidentMcpCustomServerView> {
  return residentRequest("/api/residents/mcp-servers", { method: "POST", body: JSON.stringify(input) });
}
export function updateResidentMcpServer(id: string, input: UpdateResidentMcpServer): Promise<ResidentMcpCustomServerView> {
  return residentRequest(`/api/residents/mcp-servers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}
export function deleteResidentMcpServer(id: string, expectedRevision: number): Promise<{ ok: true }> {
  return residentRequest(`/api/residents/mcp-servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
  });
}
