import { z } from "zod";
import { VoiceUtteranceSchema, type VoiceCard } from "@shared/voice-routing.ts";
import { VoiceRouter, type VoiceDeliverer } from "./router.ts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  VOICE_FLAG,
  VoiceConfigPatchSchema,
  VoiceListenerHelloSchema,
  VoiceMuteRequestSchema,
  VoiceShellReportSchema,
} from "@shared/voice.ts";
import { checkToken } from "../auth.ts";
import { requireFeature } from "../feature-flags/index.ts";
import { parseBody } from "../http-body.ts";
import { getVoiceConfig, setVoiceConfig } from "./config.ts";
import { voiceModelManager, type VoiceModelManager } from "./models.ts";
import { voiceStateStore, type VoiceStateStore } from "./state.ts";

/**
 * A hello lists at most 64 devices of two bounded strings each, and a shell report at most 32
 * capabilities; both fit well inside this. Refused while streaming, after the flag's gate, so a
 * disabled route still answers 404 before any body is read.
 */
const VOICE_BODY_MAX_BYTES = 128 * 1024;

const limitBody = bodyLimit({
  maxSize: VOICE_BODY_MAX_BYTES,
  onError: (c) => c.json({ error: "request_too_large", reason: "The request body is too large." }, 413),
});

/**
 * Voice's routes (contracts A, B and D), every one behind the `voice` flag: with it off each answers
 * 404 before its handler runs.
 *
 * Dashboard routes live under `/api/voice/`, behind the loopback gate every `/api/*` route has:
 * - `GET /api/voice/config` returns `{ config }`; `PUT` applies a patch and returns `{ config }`.
 * - `POST /api/voice/mute { muted }` mutes or unmutes and returns `{ state }`.
 * - `GET /api/voice/devices` returns `{ devices, listener }`: the input devices the live listener
 *   listed in its hello, which Voice settings offers beside the built-in microphone and the
 *   system default, and whether a listener is live at all.
 * - `POST /api/voice/model/download` starts downloading the speech model (contract H) and answers
 *   202 with `{ model }`, or 409 with the reason when there is no model to download. A download
 *   already running, or a model already verified, is not started again.
 * - `DELETE /api/voice/model/download` cancels a running download, removes what it wrote, and
 *   returns `{ model }` as the disk now reads.
 *
 * Token routes live under `/voice/` and check `x-harness-token`, as the hook ingest does: a
 * cooperating local process posts to them, and the token is what separates it from any other.
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

  app.get("/api/voice/config", gate, (c) => c.json({ config: getVoiceConfig() }));
  app.put("/api/voice/config", gate, limitBody, async (c) => {
    const parsed = await parseBody(c, VoiceConfigPatchSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    return c.json({ config: setVoiceConfig(parsed.data) });
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
  app.post("/api/voice/model/download", gate, (c) => {
    const result = models.download();
    if (!result.ok) return c.json({ error: "model_unavailable", reason: result.reason, model: result.model }, 409);
    return c.json({ model: result.model }, 202);
  });
  app.delete("/api/voice/model/download", gate, async (c) => c.json({ model: await models.cancel() }));

  app.post("/voice/listener/hello", gate, limitBody, async (c) => {
    if (!authed(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, VoiceListenerHelloSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    const result = store.acceptHello(parsed.data);
    if (!result.ok) {
      return c.json({ error: "unsupported_protocol", reason: result.reason, protocol: result.protocol }, 409);
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
): VoiceRouter {
  const gate = requireFeature(VOICE_FLAG);
  const router = new VoiceRouter(() => voiceStateStore.state(), () => getVoiceConfig().cancelWindow, deliverer, publish);
  app.post("/voice/utterances", gate, limitBody, async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, VoiceUtteranceSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    return c.json({ accepted: await router.accept(parsed.data) });
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
