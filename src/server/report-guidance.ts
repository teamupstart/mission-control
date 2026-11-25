import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { ReportsSettingsSchema, type ReportGuidanceView } from "@shared/protocol.ts";
import { DEFAULT_REPORT_GUIDANCE, REPORT_GUIDANCE_LIMIT, effectiveReportGuidance } from "@shared/reports.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// Settings > Reports' guidance (`inbox` flag): the operator's own words for when an agent posts
// a report, stored in the `reports` settings entry. Null means the default. The MCP child reads
// the guidance in force once, when it starts, through `GET /mcp/reports/guidance`, so an edit
// reaches the sessions started after it and a running session keeps what it started with.

const ENTRY = APP_CONFIG_ENTRIES.reports;

function view(guidance: string | null): ReportGuidanceView {
  return {
    guidance,
    effective: effectiveReportGuidance(guidance),
    defaultGuidance: DEFAULT_REPORT_GUIDANCE,
    limit: REPORT_GUIDANCE_LIMIT,
  };
}

/** The saved guidance, the guidance in force and the default. An unreadable row reads as none. */
export function readReportGuidance(): ReportGuidanceView {
  return view(ReportsSettingsSchema.parse(getAppConfig(ENTRY) ?? {}).guidance);
}

/** Save the operator's guidance, or null to go back to the default. Already trimmed and bounded. */
export function writeReportGuidance(guidance: string | null): ReportGuidanceView {
  setAppConfig(ENTRY, { ...getAppConfig(ENTRY), guidance });
  return view(guidance);
}
