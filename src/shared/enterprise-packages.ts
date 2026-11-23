import type { SetupStatus } from "./setup-catalog.ts";

export const ENTERPRISE_PACKAGES_FLAG = "enterprise-packages" as const;

export interface RecommendedPackageView {
  label: string;
  source: string;
  description: string;
  guide: string;
  /** Only present when a read-only installation check is configured. */
  status?: SetupStatus;
}
