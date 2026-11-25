import { bodyLimit } from "hono/body-limit";
import type { Context, Hono } from "hono";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { SESSION_SETTINGS_FLAG_ID, FEATURE_FLAGS } from "@shared/feature-flag-registry.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import {
  SessionSettingsAccessSchema, SETTINGS_BODY_MAX_BYTES, SettingsRequestSchema, settingsFailure,
} from "@shared/settings-mcp.ts";
import { SESSION_SETTINGS_ACCESS } from "@shared/session-settings-metadata.ts";
import { checkToken } from "./auth.ts";
import { getAppConfig, setAppConfig } from "./db.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { parseBody } from "./http-body.ts";
import type { Registry } from "./registry.ts";
import { sessionControlCaller, sessionControlCallerRefusal } from "./session-control.ts";
import { dispatchSetting, type SettingDescriptor } from "./settings-dispatcher.ts";
import { uiSkinSetting } from "./ui-config.ts";

const accessEntry = APP_CONFIG_ENTRIES.sessionSettingsAccess;

function sessionSettingsAccess(): boolean {
  const stored = getAppConfig(accessEntry);
  return stored === undefined || stored === true;
}

const rollout = FEATURE_FLAGS.find(flag => flag.id === SESSION_SETTINGS_FLAG_ID);
const catalog: readonly SettingDescriptor[] = [
  uiSkinSetting,
  { ...SESSION_SETTINGS_ACCESS, access: "protected", destination: "Settings > Trust" },
  ...(rollout ? [{
    key: `featureFlags.${rollout.id}`, label: rollout.label, keywords: rollout.keywords,
    access: "protected", destination: "Settings > Feature flags",
  } as const] : []),
];

export function registerSessionSettingsRoutes(app: Hono, registry: Registry): void {
  function authorize(c: Context) {
    try {
      if (!sessionControlCaller(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER))) {
        return settingsFailure("unauthorized");
      }
      if (!featureEnabled(SESSION_SETTINGS_FLAG_ID) || !sessionSettingsAccess()) {
        return settingsFailure("access_disabled");
      }
      return null;
    } catch {
      return settingsFailure("unavailable");
    }
  }

  app.post("/mcp/settings", async (c, next) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json(settingsFailure("unauthorized"), 401);
    const refusal = authorize(c);
    if (refusal) return c.json(refusal, refusal.error === "unavailable" ? 503 : 403);
    await next();
  }, bodyLimit({
    maxSize: SETTINGS_BODY_MAX_BYTES,
    onError: c => c.json(settingsFailure("value_too_large"), 413),
  }), async c => {
    const parsed = await parseBody(c, SettingsRequestSchema, { strict: true });
    if (!parsed.ok) return c.json(settingsFailure("invalid_request"), 400);
    // Recheck past body intake. Owner preparation and mutation then run synchronously.
    const result = dispatchSetting(parsed.data, catalog, () => authorize(c));
    if (result.ok) return c.json(result);
    if (result.error === "unauthorized" || result.error === "access_disabled") return c.json(result, 403);
    if (result.error === "unavailable") return c.json(result, 503);
    return c.json(result, 400);
  });

  app.get("/api/session-settings-access", c => c.json({ enabled: sessionSettingsAccess() }));
  app.put("/api/session-settings-access", bodyLimit({
    maxSize: 256,
    onError: c => c.json({ error: "Settings access request is too large." }, 413),
  }), async c => {
    if (sessionControlCallerRefusal(c) !== null) return c.json({ error: "Only the operator can change session settings access." }, 403);
    const parsed = await parseBody(c, SessionSettingsAccessSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    setAppConfig(accessEntry, parsed.data.enabled);
    return c.json(parsed.data);
  });
}
