import { z } from "zod";
import { VoiceUtteranceSchema, type VoiceCard } from "@shared/voice-routing.ts";
import { VoiceRouter, type VoiceDeliverer } from "./router.ts";
import { defaultVoiceDecider, type VoiceDecider } from "./decide.ts";
import { decisionKeyAvailability, decisionKeyRevisions, removeDecisionKey, saveDecisionKey, savedDecisionKeys } from "./decision-key.ts";
import {
  VoiceDecisionKeyProviderSchema,
  VoiceDecisionKeyPutSchema,
  voiceDecisionKeyReport,
  type VoiceKeyAvailability,
  type VoiceKeyProvider,
} from "@shared/voice-decide.ts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import {
  VOICE_FLAG,
  VOICE_BACKENDS,
  VOICE_CAPTURE_END_HEADER,
  VOICE_CAPTURE_START_HEADER,
  VOICE_DRAINING_REVISIONS_HEADER,
  VOICE_HELD_REVISION_HEADER,
  VOICE_LISTENER_ID_HEADER,
  VOICE_RELEASE_REVISION_HEADER,
  VOICE_RELEASE_TIME_HEADER,
  VOICE_SPEECH_START_HEADER,
  VoiceUiConfigPatchSchema,
  VoiceConfigPatchSchema,
  VoiceIndicatorSelectionSchema,
  VoiceListenerHelloSchema,
  VoiceMuteRequestSchema,
  VoiceProviderIntentSchema,
  VoiceRevisionSchema,
  VoiceShellReportSchema,
  type VoiceRevision,
} from "@shared/voice.ts";
import { getTask } from "../db.ts";
import { checkToken } from "../auth.ts";
import { disabledFeatureResponse, featureEnabled, requireFeature } from "../feature-flags/index.ts";
import { parseBody } from "../http-body.ts";
import { setUiConfig, setVoiceIndicator, storedVoiceUi, voiceIndicatorVersion } from "../ui-config.ts";
import { getVoiceConfig, providerIntentReceipt, providerIntentWindow, providerRevision, reserveProviderWrite, setVoiceConfig } from "./config.ts";
import { voiceModelManager, type VoiceModelManager } from "./models.ts";
import { voiceStateStore, type VoiceStateStore } from "./state.ts";

/**
 * A hello lists at most 64 devices of two bounded strings each, and a shell report at most 32
 * capabilities; both fit well inside this. Refused while streaming, after the flag's gate, so a
 * disabled route still answers 404 before any body is read.
 */
const VOICE_BODY_MAX_BYTES = 128 * 1024;

function writeExpired(value?: string): boolean {
  if (value === undefined) return false;
  const expiry = Number(value);
  return !Number.isSafeInteger(expiry) || expiry <= Date.now();
}

function keyWriteConflict(c: Context, provider: VoiceKeyProvider) {
  if (writeExpired(c.req.header("x-voice-key-expires-at"))) {
    return { error: "expired_key_write", reason: "The key change expired. Check its current source and try again." };
  }
  const observed = c.req.header("x-voice-key-revision");
  if (observed !== undefined && observed !== decisionKeyRevisions()[provider]) {
    return { error: "stale_key", reason: "The key changed since this row was read. Check its current source and try again." };
  }
  return null;
}

const limitBody = bodyLimit({
  maxSize: VOICE_BODY_MAX_BYTES,
  onError: (c) => c.json({ error: "request_too_large", reason: "The request body is too large." }, 413),
});

function waitForDirective(store: VoiceStateStore, revision: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      unsubscribe();
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = store.onChange((state) => {
      if (store.directive(state).revision !== revision) finish();
    });
    const timeout = setTimeout(finish, 25_000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * Voice's routes (contracts A, B, D and I), every one behind the `voice` flag: with it off each answers
 * 404 before its handler runs.
 *
 * Dashboard routes live under `/api/voice/`, behind the loopback gate every `/api/*` route has:
 * - `GET /api/voice/config` returns `{ config }`; `PUT` applies a patch and returns `{ config }`.
 * - `POST /api/voice/mute { muted }` mutes or unmutes and returns `{ state }`.
 * - `GET /api/voice/devices` returns `{ devices, listener }`: the input devices the live listener
 *   listed in its hello, which Voice settings offers beside the built-in microphone and the
 *   system default, and whether a listener is live at all.
 * - `GET /api/voice/model` returns the backend, manifest and verified directory for a local
 *   development launch. An optional backend query selects a previously installed alternate.
 * - `POST /api/voice/model/download` starts downloading the speech model (contract H) and answers
 *   202 with `{ model }`, or 409 with the reason when there is no model to download. A download
 *   already running, or a model already verified, is not started again.
 * - `DELETE /api/voice/model/download` cancels a running download, removes what it wrote, and
 *   returns `{ model }` as the disk now reads.
 * - `GET /api/voice/decision-key` (contract E) returns `VoiceDecisionKeyReport`: the decision
 *   provider in use and where each provider's key comes from. Never a key.
 * - `PUT /api/voice/decision-key { provider, key }` saves one provider's key and `DELETE
 *   /api/voice/decision-key?provider=` removes it; each leaves the other provider's key alone and
 *   answers with the report. The key lives in `<state home>/voice/decision-key.json`, mode 0600,
 *   outside SQLite and settings backups.
 *
 * Token routes live under `/voice/` and check `x-harness-token`, as the hook ingest does: a
 * cooperating local process posts to them, and the token is what separates it from any other.
 * - `GET /voice/listener/directive` returns capture settings and holds a matching revision up to 25 seconds.
 * - `POST /voice/listener/hello` takes a listener's hello. One naming a protocol major this
 *   daemon does not speak is refused with 409, and the state's `listener` capability says why.
 * - `POST /voice/shell-report` takes the shell's capabilities, microphone permission, call and
 *   push-to-talk readings and hotkey error, and returns `{ state }`.
 */
export function registerVoiceRoutes(
  app: Hono,
  store: VoiceStateStore = voiceStateStore,
  models: VoiceModelManager = voiceModelManager,
): void {
  const gate = requireFeature(VOICE_FLAG);
  const authed = (header: string | undefined): boolean => checkToken(header);

  let snapshotOrder = 0;
  const dashboardSnapshot = () => ({
    providerRevision: providerRevision(), intentReceipt: providerIntentReceipt(), snapshotOrder: ++snapshotOrder, serverTime: Date.now(),
  });

  const providerConflict = () => ({
    error: "A newer provider choice took effect.", config: getVoiceConfig(), providerRevision: providerRevision(),
  });
  app.get("/api/voice/config", gate, (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "HEAD") {
      c.header("X-Voice-Server-Time-Ms", String(Date.now()));
      return c.body(null);
    }
    return c.json({ config: getVoiceConfig(), ...(c.req.header("x-voice-provider-revision") === "read" && dashboardSnapshot()) });
  });
  app.post("/api/voice/config/provider-intent", gate, limitBody, async (c) => {
    const parsed = await parseBody(c, VoiceProviderIntentSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    if (!featureEnabled(VOICE_FLAG)) return c.json({ error: "This feature is disabled.", feature: VOICE_FLAG }, 404);
    const ticket = reserveProviderWrite(parsed.data);
    return ticket ? c.json({ ticket, intentReceipt: providerIntentReceipt() }) : c.json({ ...providerConflict(), intentWindow: providerIntentWindow() }, 409);
  });
  app.get("/api/voice/tasks/:id/follow-up", gate, c => {
    const task = getTask(c.req.param("id"));
    if (!task) return c.json({ error: "The finished task could not be found." }, 404);
    return c.json({ repoRoot: task.repoRoot });
  });
  let lastPlacementWrite: { id: string; revision: number } | undefined;
  // Older callers omit the version. Capture theirs before even the body limiter can wait for bytes.
  const observePlacement = createMiddleware<{ Variables: { placementVersion: VoiceRevision } }>(async (c, next) => {
    c.set("placementVersion", voiceIndicatorVersion(storedVoiceUi()));
    await next();
  });
  app.put("/api/voice/confirmation", gate, observePlacement, limitBody, async (c) => {
    const parsed = await parseBody(c, VoiceUiConfigPatchSchema.pick({ confirmation: true }).extend({
      expectedVersion: VoiceRevisionSchema.optional(),
      writeId: z.uuid().optional(),
    }));
    if (!parsed.ok) return parsed.res;
    if (!featureEnabled(VOICE_FLAG)) return c.json({ error: "This feature is disabled.", feature: VOICE_FLAG }, 404);
    const current = storedVoiceUi();
    const version = voiceIndicatorVersion(current);
    const expected = parsed.data.expectedVersion ?? c.get("placementVersion");
    if (expected.source !== version.source || expected.revision !== version.revision) {
      const writeId = lastPlacementWrite?.revision === version.revision ? lastPlacementWrite.id : undefined;
      return c.json({ error: "The voice selection changed before this placement was saved.", ...current, voiceIndicatorVersion: version, writeId }, 409);
    }
    const { voice } = setUiConfig({ voice: { ...current, confirmation: parsed.data.confirmation } });
    const saved = voiceIndicatorVersion(voice);
    lastPlacementWrite = parsed.data.writeId ? { id: parsed.data.writeId, revision: saved.revision } : undefined;
    return c.json({ ok: true, ...voice, voiceIndicatorVersion: saved });
  });
  app.put("/api/voice/indicators", gate, limitBody, async (c) => {
    const parsed = await parseBody(c, VoiceIndicatorSelectionSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    const voice = setVoiceIndicator(parsed.data.id, parsed.data.enabled);
    return voice === null
      ? c.json({ error: "The indicator selection is full." }, 409)
      : c.json({ ...voice, voiceIndicatorVersion: voiceIndicatorVersion(voice) });
  });
  app.put("/api/voice/config", gate, limitBody, async (c) => {
    const parsed = await parseBody(c, VoiceConfigPatchSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    if (!featureEnabled(VOICE_FLAG)) return c.json({ error: "This feature is disabled.", feature: VOICE_FLAG }, 404);
    if (writeExpired(c.req.header("x-voice-config-expires-at"))) {
      return c.json({ error: "The settings change expired.", config: getVoiceConfig() }, 409);
    }
    const ticket = c.req.header("x-voice-provider-ticket");
    const config = setVoiceConfig(parsed.data, ticket);
    return config ? c.json({ config, ...(ticket && { providerRevision: providerRevision() }) }) : c.json(providerConflict(), 409);
  });
  app.post("/api/voice/mute", gate, limitBody, async (c) => {
    const parsed = await parseBody(c, VoiceMuteRequestSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    setVoiceConfig({ muted: parsed.data.muted });
    return c.json({ state: store.state() });
  });
  app.get("/api/voice/devices", gate, (c) => {
    const devices = store.listenerDevices();
    return c.json({ devices: devices ?? [], listener: devices !== null });
  });
  app.get("/api/voice/model", gate, async (c) => {
    const backend = z.enum(VOICE_BACKENDS).optional().safeParse(c.req.query("backend"));
    if (!backend.success) return c.json({ error: "Unknown voice backend" }, 400);
    c.header("Cache-Control", "no-store");
    if (backend.data && !store.backendSelected(backend.data)) return c.json({ error: "backend_not_selected" }, 409);
    const model = await models.listenerModel(backend.data, c.req.raw.signal);
    // An alternate install may have been hashing while the selected backend changed.
    if (model && !store.backendSelected(model.backend)) return c.json({ error: "backend_not_selected" }, 409);
    return model ? c.json(model) : c.json({ error: "Select the backend and verify its model in Voice Setup before launching." }, 409);
  });
  app.post("/api/voice/model/download", gate, (c) => {
    const result = models.download();
    if (!result.ok) return c.json({ error: "model_unavailable", reason: result.reason, model: result.model }, 409);
    return c.json({ model: result.model }, 202);
  });
  app.delete("/api/voice/model/download", gate, async (c) => c.json({ model: await models.cancel() }));

  const keyReport = (availability: VoiceKeyAvailability) => voiceDecisionKeyReport(getVoiceConfig(), availability);
  app.get("/api/voice/decision-key", gate, (c) => {
    c.header("Cache-Control", "no-store");
    const saved = savedDecisionKeys();
    const config = getVoiceConfig();
    const report = voiceDecisionKeyReport(config, decisionKeyAvailability(saved ?? {}, process.env));
    return c.json({
      ...report,
      ...(saved === null && { savedKeysUnavailable: true }),
      ...(c.req.header("x-voice-provider-revision") === "read" && {
        selection: config.decisionProvider, keyRevisions: decisionKeyRevisions(), ...dashboardSnapshot(),
      }),
    });
  });
  app.put("/api/voice/decision-key", gate, limitBody, async (c) => {
    // Parsed here rather than through `parseBody`, whose 400 echoes the issues: a rejected key
    // must not come back in the answer.
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid_body", reason: "The body is not JSON." }, 400); }
    if (!featureEnabled(VOICE_FLAG)) return c.json({ error: "This feature is disabled.", feature: VOICE_FLAG }, 404);
    const parsed = VoiceDecisionKeyPutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_key", reason: "Send { provider, key } with a key of 8 to 512 printable characters and no spaces." }, 400);
    }
    const conflict = keyWriteConflict(c, parsed.data.provider);
    if (conflict) return c.json(conflict, 409);
    let availability: VoiceKeyAvailability;
    try {
      availability = saveDecisionKey(parsed.data.provider, parsed.data.key);
    } catch (error) {
      console.warn("[voice] could not save the decision-model key:", error instanceof Error ? error.message : String(error));
      return c.json({ error: "save_failed", reason: "The key could not be saved." }, 500);
    }
    return c.json(keyReport(availability));
  });
  app.delete("/api/voice/decision-key", gate, (c) => {
    const provider = VoiceDecisionKeyProviderSchema.safeParse(c.req.query("provider"));
    if (!provider.success) return c.json({ error: "invalid_provider", reason: "Name the provider: openai or jev." }, 400);
    const conflict = keyWriteConflict(c, provider.data);
    if (conflict) return c.json(conflict, 409);
    let availability: VoiceKeyAvailability;
    try {
      availability = removeDecisionKey(provider.data);
    } catch (error) {
      console.warn("[voice] could not remove the decision-model key:", error instanceof Error ? error.message : String(error));
      return c.json({ error: "save_failed", reason: "The key could not be removed." }, 500);
    }
    return c.json(keyReport(availability));
  });

  app.get("/voice/listener/directive", gate, async (c, next) => {
    if (!authed(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    c.header("Cache-Control", "no-store");
    const id = c.req.header(VOICE_LISTENER_ID_HEADER);
    if (!store.ownsCapture(id)) return c.json({ error: "not_listener_owner" }, 409);
    const current = store.directive();
    const signal = c.req.raw.signal;
    if (c.req.query("revision") === current.revision) await waitForDirective(store, current.revision, signal);
    await next();
  }, gate, (c) => {
    if (!store.ownsCapture(c.req.header(VOICE_LISTENER_ID_HEADER))) return c.json({ error: "not_listener_owner" }, 409);
    const state = store.state();
    const next = store.directive(state);
    if (next.capture && state.mode === "push-to-talk") c.header(VOICE_HELD_REVISION_HEADER, next.revision);
    const draining = store.drainingRevisions();
    if (draining.length) c.header(VOICE_DRAINING_REVISIONS_HEADER, draining.join(","));
    // The poll may have missed capture-off between key-up and the following press.
    const release = store.releasedCapture(c.req.query("revision")) ?? store.releasedCapture();
    if (release) {
      c.header(VOICE_RELEASE_REVISION_HEADER, release.revision);
      c.header(VOICE_RELEASE_TIME_HEADER, String(release.at));
    }
    return c.json(next);
  });
  app.post("/voice/listener/hello", gate, limitBody, async (c) => {
    if (!authed(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, VoiceListenerHelloSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    const result = store.acceptHello(c.req.header(VOICE_LISTENER_ID_HEADER), parsed.data);
    if (!result.ok) {
      return c.json({ error: result.error, reason: result.reason, protocol: result.protocol }, result.error === "invalid_listener_id" ? 400 : 409);
    }
    return c.json({ accepted: true, protocol: result.protocol });
  });
  app.post("/voice/shell-report", gate, limitBody, async (c) => {
    if (!authed(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, VoiceShellReportSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    store.acceptShellReport(parsed.data);
    return c.json({ state: store.state() });
  });
}

export function registerVoiceUtteranceRoutes(
  app: Hono,
  deliverer: VoiceDeliverer,
  publish: (card: VoiceCard) => void,
  decider: VoiceDecider = defaultVoiceDecider(),
): VoiceRouter {
  const gate = requireFeature(VOICE_FLAG);
  const router = new VoiceRouter(() => voiceStateStore.routingState(), () => getVoiceConfig().cancelWindow, deliverer, publish, decider,
    () => voiceStateStore.hostNowUs());
  app.post("/voice/utterances", gate, limitBody, async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, VoiceUtteranceSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    // Capture may have stopped and resumed while the request was in flight or its body was being read.
    const owner = c.req.header(VOICE_LISTENER_ID_HEADER);
    if (!voiceStateStore.ownsCapture(owner)) return c.json({ accepted: false });
    const state = voiceStateStore.state();
    let directive = voiceStateStore.directive(state);
    const revision = c.req.query("revision");
    if (state.mode === "push-to-talk" && directive.capture && revision === directive.revision) {
      // The physical key may already be up. Sending to the router here would make
      // delivery irreversible before the shell has confirmed the audio boundary.
      await waitForDirective(voiceStateStore, revision, c.req.raw.signal);
      const disabled = disabledFeatureResponse(c, VOICE_FLAG);
      if (disabled) return disabled;
      if (c.req.raw.signal.aborted || !voiceStateStore.ownsCapture(owner)) return c.json({ accepted: false });
      directive = voiceStateStore.directive();
      if (directive.revision === revision) {
        c.header(VOICE_HELD_REVISION_HEADER, revision);
        return c.json({ accepted: false });
      }
    }
    const release = revision ? voiceStateStore.releasedCapture(revision) : undefined;
    const heldBeforeRelease = release !== undefined && revision === release.revision;
    const startHeader = c.req.header(VOICE_CAPTURE_START_HEADER);
    const startUs = startHeader ? Number(startHeader) : undefined;
    if (startUs !== undefined && (!Number.isSafeInteger(startUs) || startUs < 0)) return c.json({ accepted: false });
    const endHeader = c.req.header(VOICE_CAPTURE_END_HEADER);
    const end = endHeader ? Number(endHeader) : NaN;
    const onsetHeader = c.req.header(VOICE_SPEECH_START_HEADER);
    const onsetUs = onsetHeader === undefined ? undefined : Number(onsetHeader);
    if (onsetUs !== undefined && (!onsetHeader?.trim() || !Number.isSafeInteger(onsetUs) || startUs === undefined ||
        onsetUs < startUs || !Number.isSafeInteger(end) || onsetUs >= end * 1000)) return c.json({ accepted: false });
    if (heldBeforeRelease) {
      if (startUs === undefined || startUs < release.pressedAtUs ||
          !Number.isSafeInteger(end) || end > release.at || startUs >= end * 1000) {
        c.header(VOICE_RELEASE_REVISION_HEADER, release.revision);
        c.header(VOICE_RELEASE_TIME_HEADER, String(release.at));
        return c.json({ accepted: false });
      }
    }
    if (!heldBeforeRelease && !(directive.capture && revision === directive.revision)) return c.json({ accepted: false });
    return c.json({ accepted: await router.accept(parsed.data, { heldBeforeRelease, startHostUs: startUs, speechStartHostUs: onsetUs }) });
  });
  app.get("/api/voice/heard", gate, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ entries: router.heard.list() });
  });
  app.delete("/api/voice/heard", gate, (c) => {
    router.heard.clear();
    return c.body(null, 204);
  });
  app.post("/api/voice/cards/:id/cancel", gate, (c) => {
    const ok = router.cancel(c.req.param("id"));
    return c.json({ ok }, ok ? 200 : 409);
  });
  app.post("/api/voice/cards/:id/send-now", gate, async (c) => {
    const ok = await router.sendNow(c.req.param("id"));
    return c.json({ ok }, ok ? 200 : 409);
  });
  app.post("/api/voice/cards/:id/pick", gate, limitBody, async (c) => {
    const parsed = await parseBody(c, z.object({ id: z.string().min(1) }).strict(), { strict: true });
    if (!parsed.ok) return parsed.res;
    const ok = await router.pick(c.req.param("id"), parsed.data.id);
    return c.json({ ok }, ok ? 200 : 409);
  });

  return router;
}
