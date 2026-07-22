import type { ReactNode } from "react";

export function AppPageShell({
  page,
  workflows,
  fleet,
  overlays,
}: {
  page: "fleet" | "workflows";
  workflows: ReactNode;
  fleet: ReactNode;
  overlays: ReactNode;
}): React.JSX.Element {
  return <>{page === "workflows" ? workflows : fleet}{overlays}</>;
}
