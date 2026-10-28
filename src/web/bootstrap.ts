import { showStartupFailure } from "./lib/startup-failure.ts";

// Keep this small and independent of the application: static imports in main.tsx can fail
// before React or its root error handler exists (missing assets, module evaluation errors).
void import("./main.tsx").catch((error: unknown) => {
  console.error("[dashboard] JavaScript startup failed", error);
  const root = document.getElementById("root");
  if (root) showStartupFailure(root, "load");
});
