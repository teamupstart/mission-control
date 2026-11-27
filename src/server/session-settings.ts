import { bodyLimit } from "hono/body-limit";
import type { Context, Hono } from "hono";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { SESSION_SETTINGS_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import {
  SETTINGS_BODY_MAX_BYTES, SettingsRequestSchema, settingsFailure,
} from "@shared/settings-mcp.ts";
import { SESSION_SETTINGS_ACCESS } from "@shared/session-settings-metadata.ts";
import { SESSION_SETTINGS_DESKTOP_REQUIRED, SessionSettingsAuthorizationSchema } from "@shared/session-control-authorization.ts";
import { checkToken } from "./auth.ts";
import { getAppConfig, setAppConfig } from "./db.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { parseBody } from "./http-body.ts";
import type { Registry } from "./registry.ts";
import { sessionControlCaller, sessionControlCallerRefusal } from "./session-control.ts";
import { sessionSettingsAuthorization, type AuthorizeSessionSettings } from "./session-control-authorization.ts";
import { dispatchSetting, type SettingDescriptor } from "./settings-dispatcher.ts";
import { protectedSettings } from "./session-settings-protected.ts";
import { flagSettings } from "./session-settings-specialized.ts";
import { uiSkinSetting } from "./ui-config.ts";

const accessEntry = APP_CONFIG_ENTRIES.sessionSettingsAccess;
const accessWriteSchema = SessionSettingsAuthorizationSchema.partial({ requestId: true });

function sessionSettingsAccess(): boolean {
  return getAppConfig(accessEntry) === true;
}

export const baseSessionSettings: readonly SettingDescriptor[] = [
  uiSkinSetting,
  { ...SESSION_SETTINGS_ACCESS, control: "session-settings-access", access: "protected",
    destination: "Settings > Trust", reason: "Requires explicit desktop operator consent." },
  ...flagSettings(), ...protectedSettings,
];

export function registerSessionSettingsRoutes(
  app: Hono, registry: Registry, authorizeWrite: AuthorizeSessionSettings = sessionSettingsAuthorization(),
  typedSettings: () => readonly SettingDescriptor[] = () => [],
): void {
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
    const refusal = authorize(c);
    if (refusal) return c.json(refusal, refusal.error === "unavailable" ? 503 : 403);
    let result;
    try {
      result = dispatchSetting(parsed.data, [...baseSessionSettings, ...typedSettings()], () => authorize(c));
    } catch {
      // Dynamic owners may fail to enumerate their settings. Their diagnostics are private.
      result = settingsFailure("unavailable");
    }
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
    const parsed = await parseBody(c, accessWriteSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    const { enabled, requestId } = parsed.data;
    if (!requestId || !await authorizeWrite({ enabled, requestId })) {
      return c.json({ error: SESSION_SETTINGS_DESKTOP_REQUIRED }, 403);
    }
    if (sessionSettingsAccess() !== enabled) {
      setAppConfig(accessEntry, enabled);
      registry.emitSessionSettingsAccessChanged();
    }
    return c.json({ enabled });
  });
}
