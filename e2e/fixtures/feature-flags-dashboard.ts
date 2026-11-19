import { build } from "vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Check the stream and resolved hook independently of Settings controls. In a PRIVATE
 * dashboard build, supply a fixture registry and expose App's state plus a real useFeatureFlag
 * consumer. The probes own no state, handle no events and perform no fetches.
 */
export async function buildFeatureFlagsDashboard(outDir: string): Promise<void> {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const nodeEnv = process.env.NODE_ENV;
  try { await build({
    configFile: join(root, "vite.config.ts"),
    logLevel: "error",
    build: { outDir, emptyOutDir: true },
    plugins: [{
      name: "feature-flags-state-probe",
      enforce: "pre",
      transform(source, id) {
        if (id === join(root, "src/shared/feature-flag-registry.ts")) {
          return `export { FEATURE_FLAGS, RETIRED_FEATURE_FLAG_IDS } from ${JSON.stringify(join(root, "test/fixtures/feature-flag-registry.ts"))};`;
        }
        if (id === join(root, "src/web/App.tsx")) {
          const anchor = "<FeatureFlagsContext.Provider value={featureFlags}>";
          if (!source.includes(anchor)) throw new Error("App no longer provides its SSE flag state");
          const probeImport = `import { FeatureFlagProbe } from ${JSON.stringify(join(root, "e2e/fixtures/feature-flag-probe.tsx"))};\n`;
          return probeImport + source.replace(anchor, `${anchor}
            <FeatureFlagProbe />
            <output aria-label="Feature flag stream state"
              style={{ position: "fixed", bottom: 8, left: 8, zIndex: 100000, padding: 12,
                background: "white", color: "black", fontFamily: "monospace" }}>
              {JSON.stringify({ featureFlags, connected, hasSnapshot })}
            </output>`);
        }
        if (id === join(root, "src/web/useFeatureFlag.ts") && process.env.MC_E2E_FEATURE_FLAGS_DROP === "hook") {
          const statement = "return resolveFeatureFlag(id, useContext(FeatureFlagsContext));";
          if (!source.includes(statement)) throw new Error("Missing hook answer for negative control");
          return source.replace(statement, "return false; /* negative control: ignore context */");
        }
        // Optional negative controls: mutate only a private build, never checkout source.
        // Each must fail the corresponding assertion in feature-flags-stream.spec.ts.
        if (id === join(root, "src/web/useEventStream.ts")) {
          const drop = process.env.MC_E2E_FEATURE_FLAGS_DROP;
          const statement = drop === "snapshot"
            ? "setFeatureFlags(msg.featureFlags ?? FEATURE_FLAGS_DEFAULTS);"
            : drop === "live" ? "setFeatureFlags(msg.config);" : null;
          if (statement) {
            if (!source.includes(statement)) throw new Error(`Missing ${drop} handler for negative control`);
            return source.replace(statement, "/* negative control: flag state update omitted */");
          }
        }
        return undefined;
      },
    }],
  });
  } finally {
    // A private production build must not turn later dev-dashboard specs into production.
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}
