// Shaper sign-in's service against the Phase 1 loopback mock authorization server, with a fake
// clock and fake timers, the memory store (wrapped so a test can make it fail or wait), and an
// in-memory registration key. Fake values only: every token, code and client id is the
// fixture's `fake-...`, and no Keychain item is written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import type { ShapingSignInClient, ShapingSignInConfig, ShapingSignInView, SignInTarget } from "../src/shared/shaping.ts";
import type { SignInStore, StoredSignIn } from "../src/server/shaping/sign-in/store.ts";
import type { BeginAnswer, ShaperSignInService, SignInFlow, SignInRegistrations, SignInUse, TimerHandle } from "../src/server/shaping/sign-in/service.ts";
import type { FakeOAuthRequest, FakeOAuthServer } from "./fixtures/fake-oauth-server.mjs";

// A fixture state home for the one test that reads the real `app_config` and a settings
// snapshot. Set before importing anything that resolves the state directory.
const home = mkdtempSync(join(tmpdir(), "mission-sign-in-service-"));
process.env.HARNESS_HOME = join(home, "state");
after(() => rmSync(home, { recursive: true, force: true }));

const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { SIGN_IN_REASONS, SHAPING_SIGN_IN_CLIENTS, SHAPING_SIGNED_OUT_CONNECTIONS, ShaperManifestSchema, ShapingConfigSchema, ShapingSignInConfigSchema } = await import("../src/shared/shaping.ts");
const { openDb, getAppConfig } = await import("../src/server/db.ts");
const { captureSettingsConfig } = await import("../src/server/settings-backups/config-registry.ts");
const { appConfigSignInRegistrations, signInRedirectUri, signInUses } = await import("../src/server/shaping/sign-in/index.ts");
const { connectionId } = await import("../src/server/shaping/sign-in/connection.ts");
const flow = await import("../src/server/shaping/sign-in/flow.ts");
const { createMemorySignInStore, SignInStoreError } = await import("../src/server/shaping/sign-in/store.ts");
const {
  BEGIN_DEADLINE_MS, MAX_TIMER_MS, PENDING_SIGN_INS, REVOKE_DEADLINE_MS, STOP_DEADLINE_MS, PENDING_SIGN_IN_MS, SIGN_IN_BEGIN_REFUSALS, SIGN_IN_COMPLETE_REFUSALS, createShaperSignInService,
} = await import("../src/server/shaping/sign-in/service.ts");
const { startFakeOAuthServer } = await import("./fixtures/fake-oauth-server.mjs");

const REDIRECT = signInRedirectUri(7317);
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const realFlow: SignInFlow = {
  discover: flow.discover, begin: flow.begin, exchange: flow.exchange, refresh: flow.refresh, revoke: flow.revoke,
};

// ---- fakes ----

interface FakeTimer extends TimerHandle { at: number; callback: () => void; cleared: boolean }

class FakeClock {
  t = NOW;
  timers: FakeTimer[] = [];
  idle: () => Promise<void> = async () => {};
  now = (): number => this.t;
  setTimer = (callback: () => void, delayMs: number): TimerHandle => {
    const timer: FakeTimer = { at: this.t + delayMs, callback, cleared: false, unref() {} };
    this.timers.push(timer);
    return timer;
  };
  clearTimer = (handle: TimerHandle): void => { (handle as FakeTimer).cleared = true; };
  /** Moves the clock without firing anything, as time passing while nothing looks. */
  jump(ms: number): void { this.t += ms; }
  live(): FakeTimer[] { return this.timers.filter((timer) => !timer.cleared); }
  /** Moves the clock and fires what falls due, without waiting for the service, which may be held. */
  fireDue(ms: number): void {
    this.t += ms;
    for (const timer of this.live().filter((due) => due.at <= this.t).sort((a, b) => a.at - b.at)) {
      // An earlier callback may have cleared it, as a real timer would then never fire.
      if (timer.cleared) continue;
      timer.cleared = true;
      timer.callback();
    }
  }
  /** Moves the clock, firing every timer that falls due on the way, in order, and settling after each. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await this.idle();
    for (;;) {
      const next = this.live().filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cleared = true;
      this.t = Math.max(this.t, next.at);
      next.callback();
      await this.idle();
    }
    this.t = end;
  }
}

interface ControlledStore {
  store: SignInStore;
  records: SignInStore;
  calls: string[];
  failWrites: boolean;
  failRemoves: boolean;
  failIds: boolean;
  /** Holds every write until the returned function is called; resolves `started` when one waits. */
  holdWrites(): { release: () => void; started: Promise<void> };
  /** The same for removals. */
  holdRemoves(): { release: () => void; started: Promise<void> };
  /** Holds every read after it has read the record, so the caller gets what was there before. */
  holdReads(): { release: () => void; started: Promise<void> };
}

function controlledStore(kind: "memory" | "keychain" = "memory", records: SignInStore = createMemorySignInStore()): ControlledStore {
  let gate: Promise<void> | null = null;
  let onWait: (() => void) | null = null;
  let removeGate: Promise<void> | null = null;
  let onRemoveWait: (() => void) | null = null;
  let readGate: Promise<void> | null = null;
  let onReadWait: (() => void) | null = null;
  const control: ControlledStore = {
    records,
    calls: [],
    failWrites: false,
    failRemoves: false,
    failIds: false,
    holdWrites() {
      let release!: () => void;
      gate = new Promise<void>((done) => { release = () => { gate = null; done(); }; });
      const started = new Promise<void>((done) => { onWait = done; });
      return { release, started };
    },
    holdReads() {
      let release!: () => void;
      readGate = new Promise<void>((done) => { release = () => { readGate = null; done(); }; });
      const started = new Promise<void>((done) => { onReadWait = done; });
      return { release, started };
    },
    holdRemoves() {
      let release!: () => void;
      removeGate = new Promise<void>((done) => { release = () => { removeGate = null; done(); }; });
      const started = new Promise<void>((done) => { onRemoveWait = done; });
      return { release, started };
    },
    store: {
      kind,
      async read(id) {
        control.calls.push(`read ${id}`);
        const record = await records.read(id);
        if (readGate) { onReadWait?.(); await readGate; }
        return record;
      },
      async write(id, record) {
        control.calls.push(`write ${id}`);
        if (gate) { onWait?.(); await gate; }
        if (control.failWrites) throw new SignInStoreError("write", -25308);
        return records.write(id, record);
      },
      async remove(id) {
        control.calls.push(`remove ${id}`);
        if (removeGate) { onRemoveWait?.(); await removeGate; }
        if (control.failRemoves) throw new SignInStoreError("remove", -25308);
        return records.remove(id);
      },
      async ids() {
        control.calls.push("ids");
        if (control.failIds) throw new SignInStoreError("ids", -25300);
        return records.ids();
      },
    },
  };
  return control;
}

/** The `shaping.signIn` key in memory. `raw` is what is stored: a value the schema does not accept reads as null, as the daemon's does. */
function memoryRegistrations(initial: ShapingSignInClient[] = []): SignInRegistrations & { raw: unknown; writes: number; failWrites: boolean } {
  const state = {
    raw: { clients: structuredClone(initial), signedOut: [], signedOutOverflow: false } as unknown,
    writes: 0,
    failWrites: false,
    read: () => {
      const parsed = ShapingSignInConfigSchema.safeParse(structuredClone(state.raw));
      return parsed.success ? parsed.data : null;
    },
    write: (value: ShapingSignInConfig) => {
      if (state.failWrites) throw new Error("fake app_config write failure");
      state.raw = structuredClone(ShapingSignInConfigSchema.parse(value));
      state.writes += 1;
    },
  };
  return state;
}

function flagSwitch(on: boolean) {
  const listeners = new Set<() => void>();
  return {
    on,
    enabled() { return this.on; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(value: boolean) { this.on = value; for (const listener of listeners) listener(); },
  };
}

/** A flow whose refresh replies can be held after the fixture answered, as a slow network would. */
function holdableFlow(): SignInFlow & { holdRefreshReplies(): () => void; replies: Array<Awaited<ReturnType<SignInFlow["refresh"]>>> } {
  let gate: Promise<void> | null = null;
  const replies: Array<Awaited<ReturnType<SignInFlow["refresh"]>>> = [];
  return {
    ...realFlow,
    replies,
    holdRefreshReplies() {
      let release!: () => void;
      gate = new Promise<void>((done) => { release = done; });
      return () => { gate = null; release(); };
    },
    async refresh(...args) {
      const reply = await realFlow.refresh(...args);
      replies.push(reply);
      if (gate) await gate;
      return reply;
    },
  };
}

interface Harness {
  svc: ShaperSignInService;
  clock: FakeClock;
  store: ControlledStore;
  regs: ReturnType<typeof memoryRegistrations> | SignInRegistrations;
  fake: FakeOAuthServer;
  flags: ReturnType<typeof flagSwitch>;
  changes: ShapingSignInView[][];
  warnings: string[];
  storesBuilt: () => number;
}

interface HarnessOptions {
  fake?: FakeOAuthServer;
  clock?: FakeClock;
  store?: ControlledStore;
  regs?: Harness["regs"];
  flags?: ReturnType<typeof flagSwitch>;
  flow?: SignInFlow;
  redirectUri?: string;
  inUse?: SignInUse[];
  start?: boolean;
}

async function harness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const fake = options.fake ?? await startFakeOAuthServer();
  if (!options.fake) t.after(() => fake.close());
  const clock = options.clock ?? new FakeClock();
  const store = options.store ?? controlledStore();
  const regs = options.regs ?? memoryRegistrations();
  const flags = options.flags ?? flagSwitch(true);
  const warnings: string[] = [];
  let built = 0;
  const svc = createShaperSignInService({
    store: () => { built += 1; return store.store; },
    flow: options.flow ?? realFlow,
    registrations: regs,
    redirectUri: options.redirectUri ?? REDIRECT,
    enabled: () => flags.enabled(),
    onEnabledChanged: flags.subscribe,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    flowTimeoutMs: 2_000,
    warn: (message) => warnings.push(message),
  });
  clock.idle = () => svc.idle();
  const changes: ShapingSignInView[][] = [];
  svc.onChanged((view) => changes.push(view));
  if (options.inUse) svc.setInUse(options.inUse);
  if (options.start !== false) {
    svc.start();
    await svc.idle();
  }
  // stop() waits for work in flight within STOP_DEADLINE_MS on this fake clock. Firing that
  // deadline here means a test that fails while it holds work still finishes, never stalls.
  t.after(async () => {
    const stopping = svc.stop();
    clock.fireDue(STOP_DEADLINE_MS);
    await stopping;
  });
  return { svc, clock, store, regs, fake, flags, changes, warnings, storesBuilt: () => built };
}

// ---- helpers ----

const target = (fake: FakeOAuthServer, extra: Partial<SignInTarget> = {}): SignInTarget =>
  ({ url: fake.resourceUrl, scope: "mcp:context", issuer: null, ...extra });
const use = (signInTarget: SignInTarget, ...shapers: string[]): SignInUse => ({ target: signInTarget, shapers: shapers.length ? shapers : ["shaper"] });

const since = (fake: FakeOAuthServer, from: number): FakeOAuthRequest[] => fake.requests.slice(from);
const form = (request: FakeOAuthRequest) => new URLSearchParams(request.body);
const registrationsSeen = (fake: FakeOAuthServer, from = 0) => since(fake, from).filter((request) => request.path === "/register");
const tokenRequests = (fake: FakeOAuthServer, from = 0, grant?: string) => since(fake, from)
  .filter((request) => request.path === "/token" && (!grant || form(request).get("grant_type") === grant));
const refreshesSeen = (fake: FakeOAuthServer, from = 0) => tokenRequests(fake, from, "refresh_token");
const revokedTokens = (fake: FakeOAuthServer, from = 0) => since(fake, from).filter((request) => request.path === "/revoke").map((request) => form(request).get("token"));

/** What the browser does: open the authorization URL and read where it is sent back. */
async function authorize(url: string): Promise<URLSearchParams> {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location")!).searchParams;
}

const callback = (back: URLSearchParams) => ({ state: back.get("state"), code: back.get("code"), error: back.get("error"), iss: back.get("iss") });

async function begun(h: Harness, signInTarget: SignInTarget) {
  const answer = await h.svc.begin(signInTarget);
  assert.ok(answer.ok, `begin failed: ${JSON.stringify(answer)}`);
  return answer;
}

/** A whole sign-in: begin, the fixture's redirect, complete. */
async function signIn(h: Harness, signInTarget: SignInTarget): Promise<{ id: string; back: URLSearchParams; authorizationUrl: string }> {
  const answer = await begun(h, signInTarget);
  const back = await authorize(answer.authorizationUrl);
  const done = await h.svc.complete(callback(back));
  assert.ok(done.ok, `complete failed: ${JSON.stringify(done)}`);
  await h.svc.idle();
  return { id: answer.connection, back, authorizationUrl: answer.authorizationUrl };
}

/** A server's refusal of the token the connection holds now, read from the store, which every write keeps in step with memory. */
const refuse = async (h: Harness, signInTarget: SignInTarget) => {
  const record = await h.store.records.read(connectionId(signInTarget));
  h.svc.noteRefused(signInTarget, record?.accessToken ?? "fake-access-none");
};
const viewOf = (h: Harness, id: string) => h.svc.view().find((entry) => entry.id === id);
const tokenOf = (h: Harness, signInTarget: SignInTarget) => {
  const answer = h.svc.accessToken(signInTarget);
  return answer.ok ? answer.token : null;
};
const settle = async (h: Harness) => { await new Promise((done) => setImmediate(done)); await h.svc.idle(); };

function seededRecord(fake: FakeOAuthServer, n: number, clientId: string, scope: string): { id: string; record: StoredSignIn } {
  const signInTarget = { url: fake.resourceUrl, scope, issuer: null };
  return {
    id: connectionId(signInTarget),
    record: {
      v: 1, target: signInTarget, issuer: fake.issuer, clientId,
      accessToken: `fake-seeded-access-${n}`, refreshToken: `fake-seeded-refresh-${n}`,
      expiresAt: NOW + HOUR, scope, obtainedAt: NOW,
    },
  };
}

/** `count` registrations for the fixture's issuer, each with its own scope, and optionally a record naming each. */
async function seed(fake: FakeOAuthServer, count: number, records: SignInStore | null) {
  const clients: ShapingSignInClient[] = [];
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const scope = `mcp:seed-${n}`;
    const clientId = `fake-seeded-client-${n}`;
    clients.push({ issuer: fake.issuer, clientId, redirectUri: REDIRECT, scope, registeredAt: NOW - (100 - n) * MINUTE });
    const { id, record } = seededRecord(fake, n, clientId, scope);
    ids.push(id);
    if (records) await records.write(id, record);
  }
  return { clients, ids };
}

const clientsOf = (regs: Harness["regs"]): ShapingSignInClient[] => regs.read()?.clients ?? assert.fail("shaping.signIn is unreadable");
const signedOutOf = (regs: Harness["regs"]) => regs.read()?.signedOut ?? assert.fail("shaping.signIn is unreadable");
const clientIds = (regs: Harness["regs"]) => clientsOf(regs).map((client) => client.clientId);

// ---- tests ----

test("connectionId is the first 32 hex characters of the SHA-256 of the target's canonical JSON, and is final", () => {
  // Expected values computed outside Node, with
  // printf '%s' '<canonical JSON>' | shasum -a 256 | cut -c1-32
  // over the keys in sorted order. Changing either strands every stored sign-in.
  assert.equal(connectionId({ url: "https://tools.example/mcp", scope: "mcp:context", issuer: null }), "ae060e26f62ba3c5c376bf09e71cbd00");
  assert.equal(
    connectionId({ url: "https://tools.example/mcp?tenant=a", scope: "mcp:context offline_access", issuer: "https://login.example/" }),
    "48abd9698b9a253df6233ea94b58b6c3",
  );
  // Key order and extra fields do not change it: only the three values do.
  const reordered = JSON.parse('{"issuer":null,"url":"https://tools.example/mcp","scope":"mcp:context"}') as SignInTarget;
  assert.equal(connectionId(reordered), "ae060e26f62ba3c5c376bf09e71cbd00");
  assert.equal(connectionId({ ...reordered, extra: "ignored" } as SignInTarget), "ae060e26f62ba3c5c376bf09e71cbd00");
  assert.notEqual(connectionId({ ...reordered, issuer: "https://tools.example" }), "ae060e26f62ba3c5c376bf09e71cbd00");
  assert.match(connectionId(reordered), /^[0-9a-f]{32}$/);
});

test("a whole sign-in: begin, the redirect, complete, then the token and signed_in", async (t) => {
  const h = await harness(t);
  const signInTarget = target(h.fake);
  h.svc.setInUse([use(signInTarget, "context")]);
  const answer = await begun(h, signInTarget);
  assert.equal(answer.connection, connectionId(signInTarget));
  assert.equal(answer.expiresAt, NOW + PENDING_SIGN_IN_MS);
  const url = new URL(answer.authorizationUrl);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("scope"), "mcp:context");
  for (const name of ["client_id", "state", "code_challenge"]) assert.ok(url.searchParams.get(name), name);
  assert.equal(url.searchParams.get("code_verifier"), null);
  assert.equal(viewOf(h, answer.connection)?.state, "pending");
  assert.equal(tokenOf(h, signInTarget), null, "a pending sign-in hands out no token");

  const back = await authorize(answer.authorizationUrl);
  const done = await h.svc.complete(callback(back));
  assert.deepEqual(done, { ok: true, connection: answer.connection });
  const issued = tokenRequests(h.fake, 0, "authorization_code");
  assert.equal(issued.length, 1);
  const stored = await h.store.records.read(answer.connection);
  assert.ok(stored);
  assert.deepEqual(stored.target, signInTarget);
  assert.equal(stored.clientId, url.searchParams.get("client_id"));
  assert.equal(tokenOf(h, signInTarget), stored.accessToken);
  assert.match(stored.accessToken, /^fake-access-/);
  await settle(h);
  assert.deepEqual(viewOf(h, answer.connection), {
    id: answer.connection, url: h.fake.resourceUrl, scope: "mcp:context", issuer: null, state: "signed_in",
    storage: "memory", expiresAt: NOW + HOUR, reason: null, shapers: ["context"],
  });
});

test("two shapers on one connection share one sign-in, and the view lists both", async (t) => {
  const h = await harness(t);
  const signInTarget = target(h.fake);
  h.svc.setInUse([use({ ...signInTarget }, "router"), use({ ...signInTarget }, "selector")]);
  assert.equal(h.svc.view().length, 1);
  await signIn(h, signInTarget);
  const view = h.svc.view();
  assert.equal(view.length, 1);
  assert.deepEqual(view[0]!.shapers, ["router", "selector"]);
  assert.equal(registrationsSeen(h.fake).length, 1);
  assert.equal(tokenRequests(h.fake, 0, "authorization_code").length, 1);
});

test("two scopes on one authorization server each register, and a third connection reuses its scope's client", async (t) => {
  const h = await harness(t);
  const context = target(h.fake);
  const other = target(h.fake, { scope: "mcp:other" });
  const shape = target(h.fake, { url: h.fake.shapeUrl });
  h.svc.setInUse([use(context, "a"), use(other, "b"), use(shape, "c")]);
  await signIn(h, context);
  await signIn(h, other);
  const registered = registrationsSeen(h.fake);
  assert.equal(registered.length, 2);
  assert.deepEqual(registered.map((request) => JSON.parse(request.body).scope), ["mcp:context", "mcp:other"]);
  assert.deepEqual(clientsOf(h.regs).map((client) => client.scope), ["mcp:context", "mcp:other"]);

  const before = h.fake.requests.length;
  await signIn(h, shape);
  assert.equal(registrationsSeen(h.fake, before).length, 0, "the shape connection reuses the mcp:context client");
  assert.equal(clientsOf(h.regs).length, 2);

  const clientOf = async (signInTarget: SignInTarget) => (await h.store.records.read(connectionId(signInTarget)))!.clientId;
  const expected = new Map([[await clientOf(context), 0], [await clientOf(other), 0]]);
  assert.equal(await clientOf(shape), await clientOf(context));
  const from = h.fake.requests.length;
  await h.clock.advance(46 * MINUTE);
  const refreshes = refreshesSeen(h.fake, from);
  assert.equal(refreshes.length, 3);
  // Each refresh carries the client that obtained those tokens: two for mcp:context, one for mcp:other.
  for (const request of refreshes) {
    const clientId = form(request).get("client_id")!;
    assert.ok(expected.has(clientId), clientId);
    expected.set(clientId, expected.get(clientId)! + 1);
  }
  assert.deepEqual([...expected.values()], [2, 1]);
});

test("at the registration limit: refused while every one is named, and room made only from one nothing names", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  const seeded = await seed(fake, SHAPING_SIGN_IN_CLIENTS - 1, records);
  const regs = memoryRegistrations(seeded.clients);
  const h = await harness(t, { fake, store: controlledStore("memory", records), regs });
  assert.equal(h.svc.view().length, 15, "every stored sign-in is listed");

  // A real sign-in for A begins and stays pending: 16 registrations, every one named.
  const a = target(fake);
  const answerA = await begun(h, a);
  assert.equal(registrationsSeen(fake).length, 1);
  const clientA = clientIds(regs).at(-1)!;
  assert.equal(clientsOf(regs).length, 16);

  const b = target(fake, { scope: "mcp:other" });
  const keyBefore = clientsOf(regs);
  const idsBefore = await records.ids();
  const refused = await h.svc.begin(b);
  assert.deepEqual(refused, { ok: false, code: "registration_limit", reason: SIGN_IN_BEGIN_REFUSALS.registration_limit });
  assert.match(refused.ok ? "" : refused.reason, /at most 16 client registrations.*Sign out of one in Settings > Task shaping/);
  assert.equal(registrationsSeen(fake).length, 1, "no registration request");
  assert.deepEqual(clientsOf(regs), keyBefore);
  assert.deepEqual(await records.ids(), idsBefore);
  assert.equal(viewOf(h, connectionId(b)), undefined, "nothing is pending for B");

  // A's pending sign-in is cancelled: its registration is the one dropped for B.
  assert.equal(await h.svc.signOut(answerA.connection), true);
  await begun(h, b);
  assert.equal(registrationsSeen(fake).length, 2);
  assert.equal(clientsOf(regs).length, 16);
  assert.ok(!clientIds(regs).includes(clientA));
  for (const client of seeded.clients) assert.ok(clientIds(regs).includes(client.clientId));

  // 16 named again. Signing out of one seeded connection frees exactly its registration.
  await h.svc.signOut(seeded.ids[3]!);
  await begun(h, target(fake, { scope: "mcp:third" }));
  assert.ok(!clientIds(regs).includes("fake-seeded-client-3"));
  assert.equal(clientsOf(regs).length, 16);

  // With two not named, the older is dropped.
  await h.svc.signOut(seeded.ids[7]!);
  await h.svc.signOut(seeded.ids[5]!);
  await begun(h, target(fake, { scope: "mcp:fourth" }));
  assert.ok(!clientIds(regs).includes("fake-seeded-client-5"));
  assert.ok(clientIds(regs).includes("fake-seeded-client-7"));

  // A registration request the server refuses changes nothing.
  await h.svc.signOut(seeded.ids[9]!);
  fake.setMode({ registration: "refuse" });
  const keyNow = clientsOf(regs);
  const failed = await h.svc.begin(target(fake, { scope: "mcp:fifth" }));
  assert.equal(failed.ok, false);
  assert.deepEqual(clientsOf(regs), keyNow);
});

test("a store that could not be read refuses at the limit with store_unread, and a store that reads makes room", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  const seeded = await seed(fake, SHAPING_SIGN_IN_CLIENTS, null);
  // Fifteen of the sixteen registrations are named by a stored record; the last is not.
  for (let n = 0; n < 15; n++) {
    const { id, record } = seededRecord(fake, n, `fake-seeded-client-${n}`, `mcp:seed-${n}`);
    await records.write(id, record);
  }
  const regs = memoryRegistrations(seeded.clients);
  const unreadable = controlledStore("memory", records);
  unreadable.failIds = true;
  const h = await harness(t, { fake, store: unreadable, regs });
  const keyBefore = clientsOf(regs);
  const refused = await h.svc.begin(target(fake));
  assert.deepEqual(refused, { ok: false, code: "store_unread", reason: SIGN_IN_BEGIN_REFUSALS.store_unread });
  assert.match(refused.ok ? "" : refused.reason, /could not read its stored sign-ins.*Restart Mission Control/);
  assert.equal(registrationsSeen(fake).length, 0);
  assert.deepEqual(clientsOf(regs), keyBefore);

  const second = await harness(t, { fake, store: controlledStore("memory", records), regs });
  await begun(second, target(fake));
  assert.equal(registrationsSeen(fake).length, 1);
  assert.equal(clientsOf(regs).length, 16);
  assert.deepEqual(keyBefore.map((client) => client.clientId).filter((id) => !clientIds(regs).includes(id)), ["fake-seeded-client-15"]);
});

test("a changed port keeps refreshing a held sign-in with its own client, and registers again for a new one", async (t) => {
  const records = createMemorySignInStore();
  const regs = memoryRegistrations();
  const first = await harness(t, { store: controlledStore("memory", records), regs });
  const context = target(first.fake);
  const { id } = await signIn(first, context);
  const original = (await records.read(id))!.clientId;
  await first.svc.stop();

  const moved = signInRedirectUri(7318);
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", records), regs, redirectUri: moved, inUse: [use(context)] });
  assert.equal(viewOf(second, id)?.state, "signed_in");
  const from = first.fake.requests.length;
  await second.clock.advance(46 * MINUTE);
  const refreshes = refreshesSeen(first.fake, from);
  assert.equal(refreshes.length, 1);
  assert.equal(form(refreshes[0]!).get("client_id"), original);
  assert.equal(viewOf(second, id)?.state, "signed_in");

  const before = first.fake.requests.length;
  await signIn(second, target(first.fake, { url: first.fake.shapeUrl }));
  const registered = registrationsSeen(first.fake, before);
  assert.equal(registered.length, 1);
  assert.deepEqual(JSON.parse(registered[0]!.body).redirect_uris, [moved]);
  assert.ok(clientIds(regs).includes(original), "the registration a held record names is still in the key");
});

test("a key that lost a registration, as after a database restore, still refreshes the record's client", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const context = target(first.fake);
  const { id } = await signIn(first, context);
  const original = (await records.read(id))!.clientId;
  await first.svc.stop();

  const restored = memoryRegistrations([]);
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", records), regs: restored, inUse: [use(context)] });
  assert.equal(viewOf(second, id)?.state, "signed_in");
  const from = first.fake.requests.length;
  await second.clock.advance(46 * MINUTE);
  assert.deepEqual(refreshesSeen(first.fake, from).map((request) => form(request).get("client_id")), [original]);

  const before = first.fake.requests.length;
  await signIn(second, target(first.fake, { url: first.fake.shapeUrl }));
  assert.equal(registrationsSeen(first.fake, before).length, 1);
  await begun(second, target(first.fake, { url: `${first.fake.shapeUrl}?tenant=two` }));
  assert.equal(registrationsSeen(first.fake, before).length, 1, "registered once for that scope");
});

test("two sign-ins started together for one issuer and scope send one registration request", async (t) => {
  const h = await harness(t);
  const [one, two] = await Promise.all([h.svc.begin(target(h.fake)), h.svc.begin(target(h.fake, { url: h.fake.shapeUrl }))]);
  assert.ok(one.ok && two.ok);
  assert.equal(registrationsSeen(h.fake).length, 1);
  assert.equal(new URL(one.authorizationUrl).searchParams.get("client_id"), new URL(two.authorizationUrl).searchParams.get("client_id"));
  assert.equal(clientsOf(h.regs).length, 1);
});

test("a state works once, and an unknown, expired, error or wrong-issuer callback leaves no record", async (t) => {
  const h = await harness(t);
  const noRecord = async (signInTarget: SignInTarget) => {
    assert.deepEqual(await h.store.records.ids(), []);
    assert.deepEqual(h.svc.accessToken(signInTarget), { ok: false, reason: "signedOut" });
  };
  const a = target(h.fake);

  assert.deepEqual(await h.svc.complete({ state: "fake-unknown-state", code: "fake-code-0", error: null, iss: null }),
    { ok: false, code: "unknown_state", reason: SIGN_IN_COMPLETE_REFUSALS.unknown_state });
  assert.equal((await h.svc.complete({ state: null, code: null, error: null, iss: null })).ok, false);

  // An error parameter, and then the same state again with a code.
  let back = await authorize((await begun(h, a)).authorizationUrl);
  assert.equal((await h.svc.complete({ ...callback(back), code: null, error: "access_denied" }) as { code: string }).code, "denied");
  assert.equal((await h.svc.complete(callback(back)) as { code: string }).code, "unknown_state");
  await noRecord(a);

  // No code.
  back = await authorize((await begun(h, a)).authorizationUrl);
  assert.equal((await h.svc.complete({ ...callback(back), code: null }) as { code: string }).code, "no_code");
  await noRecord(a);

  // An iss that is not the pinned issuer: refused, and the state is spent.
  h.fake.setMode({ iss: "http://127.0.0.1:9/" });
  back = await authorize((await begun(h, a)).authorizationUrl);
  assert.equal((await h.svc.complete(callback(back)) as { code: string }).code, "wrong_issuer");
  assert.equal((await h.svc.complete({ ...callback(back), iss: h.fake.issuer }) as { code: string }).code, "unknown_state");
  h.fake.resetModes();
  await noRecord(a);

  // Expired after ten minutes.
  back = await authorize((await begun(h, a)).authorizationUrl);
  await h.clock.advance(PENDING_SIGN_IN_MS);
  assert.equal(viewOf(h, connectionId(a)), undefined, "the expired pending sign-in is gone");
  assert.equal((await h.svc.complete(callback(back)) as { code: string }).code, "unknown_state");
  await noRecord(a);
  assert.equal(tokenRequests(h.fake).length, 0, "no callback above reached the token endpoint");

  // A success, then the same callback again.
  back = await authorize((await begun(h, a)).authorizationUrl);
  assert.equal((await h.svc.complete(callback(back))).ok, true);
  const token = tokenOf(h, a);
  assert.equal((await h.svc.complete(callback(back)) as { code: string }).code, "unknown_state");
  assert.equal(tokenOf(h, a), token);
  assert.equal(tokenRequests(h.fake).length, 1);
});

test("a begin held past its 20 second deadline answers timeout, makes nothing pending, and the next begin runs", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  const release = h.fake.hold("/.well-known/oauth-authorization-server");
  const answer = h.svc.begin(a);
  // Discovery is waiting on the held metadata request.
  while (!h.fake.requests.some((request) => request.path === "/.well-known/oauth-authorization-server")) {
    await new Promise((done) => setTimeout(done, 5));
  }
  h.clock.fireDue(BEGIN_DEADLINE_MS - 1);
  h.clock.fireDue(1);
  assert.deepEqual(await answer, { ok: false, code: "timeout", reason: SIGN_IN_BEGIN_REFUSALS.timeout });
  release();
  await settle(h);
  assert.equal(viewOf(h, connectionId(a)), undefined, "the abandoned begin left nothing pending");
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  // The queue moved on: the next begin, and its sign-in, work.
  const { id } = await signIn(h, a);
  assert.ok(h.svc.accessToken(a).ok);
  assert.equal(id, connectionId(a));
});

test("a ninth pending sign-in drops the oldest, and the eight newer ones still complete", async (t) => {
  const h = await harness(t);
  const targets = Array.from({ length: PENDING_SIGN_INS + 1 }, (_, n) => target(h.fake, { url: `${h.fake.resourceUrl}?tenant=${n}` }));
  h.svc.setInUse(targets.map((signInTarget, n) => use(signInTarget, `shaper-${n}`)));
  const backs: URLSearchParams[] = [];
  for (const signInTarget of targets) {
    backs.push(await authorize((await begun(h, signInTarget)).authorizationUrl));
    h.clock.jump(1);
  }
  await settle(h);
  const states = targets.map((signInTarget) => viewOf(h, connectionId(signInTarget))?.state);
  assert.deepEqual(states, ["signed_out", ...Array(PENDING_SIGN_INS).fill("pending")]);
  assert.equal((await h.svc.complete(callback(backs[0]!)) as { code: string }).code, "unknown_state");
  for (const [n, back] of backs.entries()) {
    if (n === 0) continue;
    assert.equal((await h.svc.complete(callback(back))).ok, true, `pending sign-in ${n}`);
  }
  await settle(h);
  assert.deepEqual(h.svc.accessToken(targets[0]!), { ok: false, reason: "signedOut" });
  for (const signInTarget of targets.slice(1)) assert.ok(h.svc.accessToken(signInTarget).ok);
});

test("client_rejected at the code exchange ends every sign-in that names the client, drops its pending sign-in, then its registration", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  // A registration the authorization server no longer knows, a stored sign-in it obtained, and two sign-ins that reuse it.
  const ghost = "fake-forgotten-client";
  const regs = memoryRegistrations([{ issuer: fake.issuer, clientId: ghost, redirectUri: REDIRECT, scope: "mcp:context", registeredAt: NOW - HOUR }]);
  const held = target(fake, { url: fake.shapeUrl });
  const heldId = connectionId(held);
  await records.write(heldId, { ...seededRecord(fake, 0, ghost, "mcp:context").record, target: held });
  const a = target(fake);
  const b = target(fake, { url: `${fake.resourceUrl}?tenant=b` });
  const h = await harness(t, { fake, store: controlledStore("memory", records), regs, inUse: [use(held), use(a), use(b)] });
  assert.equal(viewOf(h, heldId)?.state, "signed_in");
  const beganA = await begun(h, a);
  const beganB = await begun(h, b);
  assert.equal(registrationsSeen(fake).length, 0, "both reuse the stored registration");
  assert.equal(new URL(beganA.authorizationUrl).searchParams.get("client_id"), ghost);

  // The browser's redirect, which the fixture cannot produce for a client it does not know.
  const stateOf = (url: string) => new URL(url).searchParams.get("state");
  const done = await h.svc.complete({ state: stateOf(beganA.authorizationUrl), code: "fake-code-for-forgotten-client", error: null, iss: null });
  assert.equal(done.ok, false);
  assert.equal((done as { code: string }).code, "client_rejected");
  await settle(h);
  assert.equal(tokenRequests(fake, 0, "authorization_code").length, 1);
  assert.equal(viewOf(h, heldId)?.state, "signed_out");
  assert.equal(viewOf(h, heldId)?.reason, SIGN_IN_REASONS.signInAgain);
  assert.equal(await records.read(heldId), null);
  assert.equal(viewOf(h, beganB.connection)?.state, "signed_out", "the pending sign-in that reused the client is gone");
  assert.equal((await h.svc.complete({ state: stateOf(beganB.authorizationUrl), code: "fake-code-b", error: null, iss: null }) as { code: string }).code, "unknown_state");
  assert.deepEqual(clientsOf(regs), []);
  assert.equal(viewOf(h, beganA.connection)?.state, "signed_out");
});

test("a first write that fails at completion: the sign-in works from memory, says so, and nothing is stored", async (t) => {
  const h = await harness(t, { store: controlledStore("keychain") });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const back = await authorize((await begun(h, a)).authorizationUrl);
  h.store.failWrites = true;
  const done = await h.svc.complete(callback(back));
  assert.deepEqual(done, { ok: true, connection: connectionId(a) });
  await settle(h);
  const answer = h.svc.accessToken(a);
  assert.ok(answer.ok);
  assert.match(answer.token, /^fake-access-/);
  const view = viewOf(h, connectionId(a))!;
  assert.equal(view.state, "signed_in");
  assert.equal(view.storage, "memory");
  assert.equal(view.reason, SIGN_IN_REASONS.memoryOnly);
  assert.equal(await h.store.records.read(connectionId(a)), null);
  assert.ok(h.warnings.some((warning) => warning.includes("kept in memory only")));
  assert.ok(h.warnings.every((warning) => !warning.includes(answer.token)));
});

test("a record with no refresh token is removed by its own timer at expiry, whether or not a shaper uses it", async (t) => {
  const h = await harness(t);
  h.fake.setMode({ tokens: "no-refresh" });
  const used = target(h.fake);
  const unused = target(h.fake, { url: h.fake.shapeUrl });
  h.svc.setInUse([use(used)]);
  const { id: usedId } = await signIn(h, used);
  const { id: unusedId } = await signIn(h, unused);
  assert.equal(viewOf(h, usedId)?.state, "signed_in");
  assert.equal(viewOf(h, unusedId)?.state, "signed_in");
  const from = h.fake.requests.length;
  h.changes.length = 0;

  // No call asks for either token: only the timers run.
  await h.clock.advance(HOUR - 1);
  assert.ok(await h.store.records.read(usedId));
  assert.ok(await h.store.records.read(unusedId));
  await h.clock.advance(1);
  await settle(h);
  assert.equal(await h.store.records.read(usedId), null);
  assert.equal(await h.store.records.read(unusedId), null);
  assert.equal(viewOf(h, usedId)?.state, "signed_out");
  assert.equal(viewOf(h, usedId)?.reason, SIGN_IN_REASONS.signInAgain);
  assert.equal(viewOf(h, unusedId), undefined, "an unused connection with no record is no longer listed");
  assert.equal(h.fake.requests.length, from, "removing an expired record sends no request");
  assert.deepEqual(h.changes.at(-1), h.svc.view(), "the removal was reported");
  assert.equal(h.clock.live().length, 0, "no timer is left for either connection");
});

test("change reports: one per changed view, carrying that view, and none for a change that leaves it the same", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  const b = target(h.fake, { url: h.fake.shapeUrl });
  const { id } = await signIn(h, a);
  await settle(h);
  h.changes.length = 0;

  // Several changes in one turn are one report.
  h.svc.setInUse([use(a, "x")]);
  h.svc.setInUse([use(a, "x"), use(b, "y")]);
  await settle(h);
  assert.equal(h.changes.length, 1);
  assert.deepEqual(h.changes[0], h.svc.view());
  assert.deepEqual(h.changes[0]!.map((entry) => entry.shapers), [["x"], ["y"]]);

  // Telling it the same again, or asking for a token, changes nothing and reports nothing.
  h.svc.setInUse([use(a, "x"), use(b, "y")]);
  assert.ok(h.svc.accessToken(a).ok);
  h.svc.view();
  await settle(h);
  assert.equal(h.changes.length, 1);

  // A sign-out clears memory and reports once, though it touches the record, the reason and the timers.
  await h.svc.signOut(id);
  await settle(h);
  assert.equal(h.changes.length, 2);
  assert.deepEqual(h.changes[1], h.svc.view());
  assert.equal(h.changes[1]!.find((entry) => entry.id === id)?.state, "signed_out");

  // A listener that unsubscribed hears nothing more.
  const heard: unknown[] = [];
  const off = h.svc.onChanged((view) => heard.push(view));
  off();
  h.svc.setInUse([]);
  await settle(h);
  assert.equal(h.changes.length, 3);
  assert.deepEqual(heard, []);
});

test("stop waits for a held refresh only until its 10 second deadline", async (t) => {
  const held = holdableFlow();
  const h = await harness(t, { flow: held });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  await signIn(h, a);
  const release = held.holdRefreshReplies();
  // The 75% refresh starts, and its reply is held after the fixture answered.
  h.clock.fireDue(46 * MINUTE);
  while (held.replies.length === 0) await new Promise((done) => setTimeout(done, 5));

  let stopped = false;
  const stopping = h.svc.stop().then(() => { stopped = true; });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(stopped, false, "stop waits while the refresh is in flight");
  h.clock.fireDue(STOP_DEADLINE_MS - 1);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(stopped, false, "and still waits just before the deadline");
  h.clock.fireDue(1);
  await stopping;
  assert.equal(stopped, true, "stop resolves at the deadline");
  assert.equal(held.replies.length, 1, "while the refresh is still held");
  assert.equal(h.clock.live().length, 0, "and stop leaves no timer");
  release();
  await h.svc.idle();
});

test("after a restart, server metadata that cannot be read keeps the sign-in and retries the refresh on schedule", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake);
  const { id } = await signIn(first, a);
  const held = (await records.read(id))!;
  await first.svc.stop();

  // Restarted past 75% of the hour, with the metadata refused: the new service has none cached.
  first.clock.jump(46 * MINUTE);
  first.fake.setMode({ metadata: "wrong-issuer" });
  const from = first.fake.requests.length;
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", records), inUse: [use(a)] });
  await second.clock.advance(0);
  const metadataReads = () => since(first.fake, from).filter((request) => request.path === "/.well-known/oauth-authorization-server").length;
  assert.equal(metadataReads(), 1, "the refresh tried to read the metadata");
  assert.equal(refreshesSeen(first.fake, from).length, 0, "and sent nothing to the token endpoint");
  assert.deepEqual(await records.read(id), held, "the stored sign-in is kept");
  assert.equal(tokenOf(second, a), held.accessToken, "its unexpired token is still handed out");
  assert.equal(viewOf(second, id)?.state, "signed_in");
  assert.ok(second.warnings.some((warning) => /metadata/i.test(warning)));

  // The scheduled retry, a minute later, and no request before it.
  await second.clock.advance(MINUTE - 1);
  assert.equal(metadataReads(), 1);
  first.fake.resetModes();
  await second.clock.advance(1);
  assert.equal(refreshesSeen(first.fake, from).length, 1);
  assert.notEqual(tokenOf(second, a), held.accessToken);
  assert.equal(viewOf(second, id)?.state, "signed_in");
});

test("signOut resolves at the 5 second revoke deadline when revocation is held, with the record already gone", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const release = h.fake.hold("/revoke");
  let resolved: boolean | null = null;
  const signingOut = h.svc.signOut(id).then((answer) => { resolved = answer; });
  while (!h.fake.requests.some((request) => request.path === "/revoke")) await new Promise((done) => setTimeout(done, 5));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(resolved, null, "signOut waits on the revocation");
  assert.equal(viewOf(h, id)?.state, "signed_out", "memory was cleared before the revocation");
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(await h.store.records.read(id), null, "and the stored record removed");
  h.clock.fireDue(REVOKE_DEADLINE_MS - 1);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(resolved, null, "still waiting just before the deadline");
  h.clock.fireDue(1);
  // At once: well before the flow's own per-request timeout would have ended the held revocation.
  await Promise.race([signingOut, new Promise((done) => setTimeout(done, 300))]);
  assert.equal(resolved, true, "signOut resolves at the deadline, not when the request gives up");
  release();
  await settle(h);
});

test("a sign-out while the code is being exchanged: the completion keeps nothing and revokes what it received", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const back = await authorize((await begun(h, a)).authorizationUrl);
  const release = h.fake.hold("/token");
  const completing = h.svc.complete(callback(back));
  while (tokenRequests(h.fake, 0, "authorization_code").length === 0) await new Promise((done) => setTimeout(done, 5));
  // The pending sign-in was already taken; the exchange is in flight.
  assert.equal(await h.svc.signOut(connectionId(a)), true, "a completion in flight is something to sign out of");
  const from = h.fake.requests.length;
  release();
  assert.deepEqual(await completing, { ok: false, code: "cancelled", reason: SIGN_IN_COMPLETE_REFUSALS.cancelled });
  await settle(h);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(await h.store.records.read(connectionId(a)), null);
  assert.equal(viewOf(h, connectionId(a))?.state, "signed_out");
  const revoked = revokedTokens(h.fake, from);
  assert.equal(revoked.length, 2, "the pair the exchange issued is revoked");
  assert.ok(revoked.every((token) => /^fake-(access|refresh)-/.test(token!)));
});

test("a sign-out while the new record is being written: the written record is removed, and nothing is kept", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const back = await authorize((await begun(h, a)).authorizationUrl);
  const writes = h.store.holdWrites();
  const completing = h.svc.complete(callback(back));
  await writes.started;
  // signOut waits for the removal queued behind that write, so it answers once the write is let go.
  const signingOut = h.svc.signOut(connectionId(a));
  writes.release();
  assert.equal(await signingOut, true);
  assert.equal((await completing as { code: string }).code, "cancelled");
  await settle(h);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(await h.store.records.read(connectionId(a)), null, "the removal queued behind the write cleared it");
  assert.equal(revokedTokens(h.fake).length, 2);
  // A sign-in started afterwards still works.
  await signIn(h, a);
  assert.ok(h.svc.accessToken(a).ok);
});

test("a begin abandoned at its deadline makes no registration request and saves nothing when discovery returns", async (t) => {
  const regs = memoryRegistrations();
  const h = await harness(t, { regs });
  const a = target(h.fake, { scope: "mcp:other" });
  const release = h.fake.hold("/.well-known/oauth-authorization-server");
  const answer = h.svc.begin(a);
  while (!h.fake.requests.some((request) => request.path === "/.well-known/oauth-authorization-server")) {
    await new Promise((done) => setTimeout(done, 5));
  }
  h.clock.fireDue(BEGIN_DEADLINE_MS);
  assert.equal((await answer as { code: string }).code, "timeout");
  release();
  await settle(h);
  assert.equal(registrationsSeen(h.fake).length, 0, "no registration request after the caller was told timeout");
  assert.equal(regs.writes, 0, "and no registration saved");
  assert.deepEqual(clientsOf(regs), []);
});

test("a sign-out while the first load is still reading the store keeps that record from loading", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake);
  const { id } = await signIn(first, a);
  await first.svc.stop();

  const slow = controlledStore("memory", records);
  const reads = slow.holdReads();
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: slow, inUse: [use(a)], start: false });
  second.svc.start();
  // The load has read the record and is waiting to install it.
  await reads.started;
  assert.equal(await second.svc.signOut(id), true, "a connection the load may still install is something to sign out of");
  reads.release();
  await settle(second);
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(viewOf(second, id)?.state, "signed_out");
  assert.equal(await records.read(id), null, "and the stored record is removed");
});

test("signOut waits for the store's removal before it answers", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const h = await harness(t, { store });
  const a = target(h.fake);
  const { id } = await signIn(h, a);
  const removes = store.holdRemoves();
  let answered: boolean | null = null;
  const signingOut = h.svc.signOut(id).then((answer) => { answered = answer; });
  await removes.started;
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" }, "memory is cleared at once");
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(answered, null, "and the answer waits for the store");
  removes.release();
  await signingOut;
  assert.equal(answered, true);
  assert.equal(await records.read(id), null);
});

/** Store calls and `shaping.signIn` writes in one log, so a test can see which came first. */
function loggedRegistrations(store: ControlledStore, initial: ShapingSignInClient[] = []) {
  const regs = memoryRegistrations(initial);
  const write = regs.write;
  regs.write = (value) => {
    write(value);
    store.calls.push(`signedOut ${value.signedOut.join(",")}${value.signedOutOverflow ? " overflow" : ""}`);
  };
  return regs;
}

/** A second service over the same records and key, as after a daemon restart. */
async function restarted(t: TestContext, first: Harness, records: SignInStore, inUse: SignInUse[], options: { failRemoves?: boolean } = {}) {
  await first.svc.stop();
  const store = controlledStore("memory", records);
  store.failRemoves = options.failRemoves ?? false;
  return harness(t, { fake: first.fake, clock: first.clock, store, regs: first.regs, inUse });
}

test("a removal the store refuses: the sign-out is listed before the store is asked, and a restart never loads it", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const regs = loggedRegistrations(store);
  const h = await harness(t, { store, regs });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const held = (await records.read(id))!;
  store.failRemoves = true;
  const from = h.fake.requests.length;
  const callsFrom = store.calls.length;
  assert.equal(await h.svc.signOut(id), true);
  await settle(h);
  assert.deepEqual(store.calls.slice(callsFrom), [`signedOut ${id}`, `remove ${id}`], "listed in app_config before the store is asked");
  assert.deepEqual(signedOutOf(regs), [id], "the entry is the connection id alone: no time, no token");
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.ok(h.warnings.some((warning) => warning.includes("could not be removed")), "the refusal is logged");
  assert.ok(h.warnings.every((warning) => !warning.includes(held.accessToken) && !warning.includes(held.refreshToken!)));
  assert.deepEqual(revokedTokens(h.fake, from).sort(), [held.accessToken, held.refreshToken].sort(), "both tokens are revoked at the server");
  assert.ok(await records.read(id), "the store still holds the record");

  // Restarted with the store still refusing: the record is not loaded, read or refreshed, and stays listed.
  const second = await restarted(t, h, records, [use(a)], { failRemoves: true });
  assert.ok(!second.store.calls.includes(`read ${id}`), "a listed record is never read");
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(viewOf(second, id)?.state, "signed_out");
  await second.clock.advance(2 * HOUR);
  assert.equal(refreshesSeen(second.fake, from).length, 0, "nothing refreshes the signed-out record");
  assert.deepEqual(signedOutOf(regs), [id], "an entry whose removal is unconfirmed is never dropped");
  assert.ok(await records.read(id));

  // Restarted with a store that removes: the record is removed and the entry cleared.
  const third = await restarted(t, second, records, [use(a)]);
  await settle(third);
  assert.equal(await records.read(id), null);
  assert.deepEqual(signedOutOf(regs), []);
  assert.deepEqual(third.svc.accessToken(a), { ok: false, reason: "signedOut" });
  // A sign-in afterwards loads after the next restart as any other does.
  await signIn(third, a);
  const fourth = await restarted(t, third, records, [use(a)]);
  assert.ok(fourth.svc.accessToken(a).ok);
});

for (const variant of ["revocation fails", "the server has no revocation endpoint"] as const) {
  test(`a refused removal when ${variant}: the tokens still work at the server, and a restart never loads or uses them`, async (t) => {
    const records = createMemorySignInStore();
    const store = controlledStore("memory", records);
    // No endpoint: the discovered metadata names none, so the flow revokes nothing.
    const flowUsed: SignInFlow = variant === "revocation fails" ? realFlow : {
      ...realFlow,
      async discover(...args) {
        const found = await realFlow.discover(...args);
        if (!found.ok) return found;
        const metadata = { ...found.discovery.metadata };
        delete (metadata as { revocation_endpoint?: string }).revocation_endpoint;
        return { ...found, discovery: { ...found.discovery, metadata } };
      },
    };
    const h = await harness(t, { store, flow: flowUsed });
    const a = target(h.fake);
    h.svc.setInUse([use(a)]);
    const { id } = await signIn(h, a);
    const held = (await records.read(id))!;
    if (variant === "revocation fails") h.fake.setMode({ revoke: "503" });
    store.failRemoves = true;
    const from = h.fake.requests.length;
    assert.equal(await h.svc.signOut(id), true);
    await settle(h);
    const revokes = since(h.fake, from).filter((request) => request.path === "/revoke");
    if (variant === "revocation fails") assert.ok(revokes.length > 0, "revocation was tried and refused");
    else assert.equal(revokes.length, 0, "nothing to revoke against");
    assert.deepEqual(signedOutOf(h.regs), [id]);
    assert.deepEqual(await records.read(id), held, "the store still holds the unrevoked pair");

    h.fake.resetModes();
    const second = await restarted(t, h, records, [use(a)], { failRemoves: true });
    assert.ok(!second.store.calls.includes(`read ${id}`), "the record is never read");
    assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
    assert.equal(viewOf(second, id)?.state, "signed_out");
    await second.clock.advance(2 * HOUR);
    assert.equal(refreshesSeen(second.fake, from).length, 0, "the still-valid refresh token is never spent");
    assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
    assert.deepEqual(signedOutOf(second.regs), [id]);
  });
}

test("a sign-out during the first load with a removal the store refuses: no later start loads that record", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake);
  const { id } = await signIn(first, a);
  await first.svc.stop();

  const slow = controlledStore("memory", records);
  slow.failRemoves = true;
  const reads = slow.holdReads();
  const regs = memoryRegistrations(clientsOf(first.regs));
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: slow, regs, inUse: [use(a)], start: false });
  second.svc.start();
  await reads.started;
  assert.equal(await second.svc.signOut(id), true);
  assert.deepEqual(signedOutOf(regs), [id], "listed while the load still holds the record it read");
  reads.release();
  await settle(second);
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.ok(await records.read(id), "the store refused the removal");

  const third = await restarted(t, second, records, [use(a)], { failRemoves: true });
  assert.deepEqual(third.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.deepEqual(signedOutOf(regs), [id]);
});

test("a flag turned off and on reloads nothing listed, and an entry clears only from a removal begun after the last sign-out", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const flags = flagSwitch(true);
  const h = await harness(t, { store, flags });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  store.failRemoves = true;
  await h.svc.signOut(id);
  await settle(h);
  assert.deepEqual(signedOutOf(h.regs), [id]);

  // Off and on, removals still refused: the new load does not install the record.
  flags.set(false);
  flags.set(true);
  await settle(h);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.deepEqual(signedOutOf(h.regs), [id]);

  // Off and on again. That load's removal is held and then confirmed; every removal after it is
  // refused. A sign-out while the load still reads marks the connection again, so the held
  // removal, begun before that sign-out, must not clear the entry.
  let removeCalls = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((done) => { releaseFirst = done; });
  let firstStarted!: () => void;
  const firstRemoving = new Promise<void>((done) => { firstStarted = done; });
  store.store.remove = async (removeId) => {
    removeCalls += 1;
    if (removeCalls > 1) throw new SignInStoreError("remove", -25308);
    firstStarted();
    await firstHeld;
    return records.remove(removeId);
  };
  // Another stored record, not listed, which the load reads and is held at.
  const other = seededRecord(h.fake, 1, "fake-seeded-client-1", "mcp:other");
  await records.write(other.id, other.record);
  const reads = store.holdReads();
  flags.set(false);
  flags.set(true);
  await Promise.all([firstRemoving, reads.started]);
  const signingOut = h.svc.signOut(id);
  releaseFirst();
  reads.release();
  assert.equal(await signingOut, true, "a load was reading, so there was something to sign out of");
  await settle(h);
  assert.equal(removeCalls, 2);
  assert.equal(await records.read(id), null, "the first removal was confirmed");
  assert.deepEqual(signedOutOf(h.regs), [id], "but it began before the later sign-out, whose own removal was refused: the entry stays");
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });

  // The next start's removal is confirmed after the last sign-out: the entry clears.
  store.store.remove = (removeId) => records.remove(removeId);
  flags.set(false);
  flags.set(true);
  await settle(h);
  assert.deepEqual(signedOutOf(h.regs), []);
});

test("a write that a sign-out cancelled never clears the entry, and a sign-in still wanted when its write ends does", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const h = await harness(t, { store });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  store.failRemoves = true;
  await h.svc.signOut(id);
  await settle(h);

  // A new sign-in whose write is in flight when it is signed out: the write lands, is not kept,
  // and the removal that undoes it is refused. The entry stays.
  const back = await authorize((await begun(h, a)).authorizationUrl);
  const writes = store.holdWrites();
  const completing = h.svc.complete(callback(back));
  await writes.started;
  const signingOut = h.svc.signOut(id);
  writes.release();
  assert.equal((await completing as { code: string }).code, "cancelled");
  await signingOut;
  await settle(h);
  assert.ok(await records.read(id), "the cancelled write is still in the store, which refused every removal");
  assert.deepEqual(signedOutOf(h.regs), [id], "a write a sign-out cancelled never clears the entry");
  const second = await restarted(t, h, records, [use(a)], { failRemoves: true });
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" }, "and no restart loads it");

  // A sign-in whose write fails is kept in memory only, and the entry stays.
  second.store.failWrites = true;
  await signIn(second, a);
  assert.equal(viewOf(second, id)?.reason, SIGN_IN_REASONS.memoryOnly);
  assert.deepEqual(signedOutOf(second.regs), [id], "a write the store refused does not clear the entry");
  const third = await restarted(t, second, records, [use(a)], { failRemoves: true });
  assert.deepEqual(third.svc.accessToken(a), { ok: false, reason: "signedOut" });

  // A sign-in still wanted when its write ends replaced the stored record: the entry clears, and it loads after a restart.
  const { id: again } = await signIn(third, a);
  assert.equal(again, id);
  assert.deepEqual(signedOutOf(third.regs), []);
  const kept = (await records.read(id))!;
  const fourth = await restarted(t, third, records, [use(a)], { failRemoves: true });
  assert.deepEqual(fourth.svc.accessToken(a), { ok: true, token: kept.accessToken });
});

test("a sign-in write in flight when the flag turns off: still wanted, so it clears the entry and loads after a restart", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const flags = flagSwitch(true);
  const h = await harness(t, { store, flags });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  store.failRemoves = true;
  await h.svc.signOut(id);
  await settle(h);
  assert.deepEqual(signedOutOf(h.regs), [id]);
  store.failRemoves = false;

  const back = await authorize((await begun(h, a)).authorizationUrl);
  const writes = store.holdWrites();
  const completing = h.svc.complete(callback(back));
  await writes.started;
  // The flag clears with the write in flight: nothing signed it out, so the write is still wanted.
  flags.set(false);
  assert.deepEqual(signedOutOf(h.regs), [id], "the entry stays while the write is in flight");
  writes.release();
  assert.deepEqual(await completing, { ok: true, connection: id });
  await settle(h);
  const kept = (await records.read(id))!;
  assert.deepEqual(signedOutOf(h.regs), [], "the confirmed, wanted write cleared the entry");
  assert.equal(h.svc.view().length, 0, "nothing is reported while the flag is off");

  flags.set(true);
  await settle(h);
  assert.deepEqual(h.svc.accessToken(a), { ok: true, token: kept.accessToken });
  const second = await restarted(t, h, records, [use(a)]);
  assert.deepEqual(second.svc.accessToken(a), { ok: true, token: kept.accessToken }, "and it loads after a restart");
});

test("a sign-in write in flight when a rejected client cancels it: the undo is listed first, so a refused removal never loads after a restart", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const regs = loggedRegistrations(store);
  const h = await harness(t, { store, regs });
  const a = target(h.fake);
  const b = target(h.fake, { url: h.fake.shapeUrl });
  h.svc.setInUse([use(a), use(b)]);
  // B holds a sign-in with the client A's sign-in uses too.
  const { id: idB } = await signIn(h, b);
  const idA = connectionId(a);
  const back = await authorize((await begun(h, a)).authorizationUrl);
  assert.equal(registrationsSeen(h.fake).length, 1, "one client for both");

  const writes = store.holdWrites();
  const completing = h.svc.complete(callback(back));
  await writes.started;
  // B's refresh is refused for the client while A's write is in flight: A's completion is cancelled with no sign-out.
  h.fake.setMode({ refresh: "invalid_client" });
  store.failRemoves = true;
  const refreshesBefore = refreshesSeen(h.fake).length;
  h.clock.fireDue(46 * MINUTE);
  while (refreshesSeen(h.fake).length === refreshesBefore) await new Promise((done) => setTimeout(done, 5));
  while (viewOf(h, idB)?.state !== "signed_out") await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(signedOutOf(regs), [idB], "B's removal is listed; A held no record yet");

  const callsFrom = store.calls.length;
  writes.release();
  assert.equal((await completing as { code: string }).code, "cancelled");
  await settle(h);
  const undo = store.calls.slice(callsFrom);
  assert.ok(undo.indexOf(`write ${idA}`) < undo.indexOf(`signedOut ${idB},${idA}`), "the cancelled write landed first");
  assert.ok(undo.indexOf(`signedOut ${idB},${idA}`) < undo.lastIndexOf(`remove ${idA}`), "and its undo was listed before the store was asked to remove it");
  assert.ok(await records.read(idA), "the store refused the undo");
  assert.deepEqual([...signedOutOf(regs)].sort(), [idA, idB].sort());
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });

  const second = await restarted(t, h, records, [use(a), use(b)], { failRemoves: true });
  assert.ok(!second.store.calls.includes(`read ${idA}`), "the cancelled write's record is never read");
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.deepEqual(second.svc.accessToken(b), { ok: false, reason: "signedOut" });

  // A start whose removals succeed removes both and clears both entries.
  const third = await restarted(t, second, records, [use(a), use(b)]);
  await settle(third);
  assert.equal(await records.read(idA), null);
  assert.deepEqual(signedOutOf(regs), []);
});

test("a sign-out app_config refuses to save: the store is still asked, and the entry is saved by the next write the key takes", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const regs = memoryRegistrations();
  const h = await harness(t, { store, regs });
  const a = target(h.fake);
  const b = target(h.fake, { url: h.fake.shapeUrl });
  h.svc.setInUse([use(a), use(b)]);
  const { id: idA } = await signIn(h, a);
  const { id: idB } = await signIn(h, b);

  // app_config refuses, the store removes: the confirmed removal holds the sign-out on its own.
  regs.failWrites = true;
  await h.svc.signOut(idA);
  await settle(h);
  assert.ok(h.warnings.some((warning) => warning.includes("could not be saved yet")));
  assert.equal(await records.read(idA), null, "the store was asked although the entry was not saved");

  // Both refuse for B: the entry is kept in memory, and the next write the key takes saves it.
  await signIn(h, a);
  store.failRemoves = true;
  await h.svc.signOut(idB);
  await settle(h);
  assert.deepEqual(signedOutOf(regs), [], "not saved while app_config refuses");
  assert.ok(await records.read(idB));
  regs.failWrites = false;
  await h.svc.signOut(idA);
  await settle(h);
  assert.deepEqual([...signedOutOf(regs)].sort(), [idA, idB].sort(), "B's unsaved entry went out with A's");

  const second = await restarted(t, h, records, [use(a), use(b)], { failRemoves: true });
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.deepEqual(second.svc.accessToken(b), { ok: false, reason: "signedOut" });
});

test("accepted limit: app_config and the store both refuse, and the daemon restarts before either recovers", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const regs = memoryRegistrations();
  const h = await harness(t, { store, regs });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  regs.failWrites = true;
  store.failRemoves = true;
  await h.svc.signOut(id);
  await settle(h);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.ok(h.warnings.some((warning) => warning.includes("could not be saved yet")), "the failure is logged");
  // Neither durable place took the sign-out, so nothing outlives this daemon: the record loads again.
  regs.failWrites = false;
  const second = await restarted(t, h, records, [use(a)]);
  assert.equal(second.svc.accessToken(a).ok, true);
});

test("an unparseable shaping.signIn is unreadable, never empty: no stored record loads, and the key fails closed", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake);
  const { id } = await signIn(first, a);
  await first.svc.stop();

  const regs = memoryRegistrations();
  regs.raw = { clients: "not a list" };
  const store = controlledStore("memory", records);
  store.failRemoves = true;
  const second = await harness(t, { fake: first.fake, clock: first.clock, store, regs, inUse: [use(a)] });
  assert.ok(!store.calls.includes(`read ${id}`));
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.deepEqual(regs.read(), { clients: [], signedOut: [], signedOutOverflow: true }, "rewritten to the overflow mark");
  assert.ok(await records.read(id), "the store refused the removal");

  // While the mark stands, no start loads a stored record. A start whose removals succeed clears it.
  const third = await restarted(t, second, records, [use(a)], { failRemoves: true });
  assert.deepEqual(third.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(regs.read()?.signedOutOverflow, true);
  const fourth = await restarted(t, third, records, [use(a)]);
  await settle(fourth);
  assert.equal(await records.read(id), null);
  assert.equal(regs.read()?.signedOutOverflow, false);
  // A key that turns unreadable later refuses a begin rather than overwriting what it may list.
  regs.raw = "unreadable";
  assert.equal((await fourth.svc.begin(target(fourth.fake, { scope: "mcp:fresh" })) as { code: string }).code, "store_unread");
  assert.equal(regs.raw, "unreadable");
});

test("a full signed-out list is never trimmed: one more sign-out fails closed until a start removes every stored record", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const regs = memoryRegistrations();
  const listed = Array.from({ length: SHAPING_SIGNED_OUT_CONNECTIONS }, (_, n) => n.toString(16).padStart(32, "0"));
  regs.raw = { clients: [], signedOut: listed, signedOutOverflow: false };
  store.failRemoves = true;
  const h = await harness(t, { store, regs });
  const a = target(h.fake);
  const b = target(h.fake, { scope: "mcp:other" });
  h.svc.setInUse([use(a), use(b)]);
  const { id } = await signIn(h, a);
  const { id: kept } = await signIn(h, b);
  assert.deepEqual(signedOutOf(regs), listed, "the start's refused removals keep every entry");
  await h.svc.signOut(id);
  await settle(h);
  assert.deepEqual(regs.read(), { clients: regs.read()!.clients, signedOut: listed, signedOutOverflow: true }, "no entry dropped to make room");

  // Fail closed: no stored record loads, not even one never signed out.
  const second = await restarted(t, h, records, [use(a), use(b)], { failRemoves: true });
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.deepEqual(second.svc.accessToken(b), { ok: false, reason: "signedOut" });
  assert.ok(await records.read(kept));

  // A start whose removals succeed removes every stored record, clears the entries and the mark.
  const third = await restarted(t, second, records, [use(a), use(b)]);
  await settle(third);
  assert.deepEqual(await records.ids(), []);
  assert.deepEqual(regs.read()?.signedOut, []);
  assert.equal(regs.read()?.signedOutOverflow, false);
});

test("with the overflow mark set, a store that cannot be listed keeps the mark, and no later start loads a stored record until one lists and removes it", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  const { id, record } = seededRecord(fake, 0, "fake-seeded-client-0", "mcp:context");
  await records.write(id, record);
  const regs = memoryRegistrations();
  regs.raw = { clients: [], signedOut: [], signedOutOverflow: true };
  const a = record.target;

  const unlisted = controlledStore("memory", records);
  unlisted.failIds = true;
  const first = await harness(t, { fake, store: unlisted, regs, inUse: [use(a)] });
  await settle(first);
  assert.equal(regs.read()?.signedOutOverflow, true, "an incomplete listing never clears the mark");
  assert.deepEqual(first.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.ok(await records.read(id));

  // Listed now, removal refused: still nothing loads, and the mark stays.
  const second = await restarted(t, first, records, [use(a)], { failRemoves: true });
  await settle(second);
  assert.ok(!second.store.calls.includes(`read ${id}`));
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(regs.read()?.signedOutOverflow, true);

  // Listed and removed: the mark clears.
  const third = await restarted(t, second, records, [use(a)]);
  await settle(third);
  assert.equal(await records.read(id), null);
  assert.equal(regs.read()?.signedOutOverflow, false);
});

test("shaping.signIn in app_config: a missing row is empty, an older value gains empty lists, and a row that does not parse is unreadable", () => {
  openDb().exec("DELETE FROM app_config");
  assert.deepEqual(appConfigSignInRegistrations.read(), { clients: [], signedOut: [], signedOutOverflow: false });
  openDb().prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run("shaping.signIn", JSON.stringify({ clients: [] }));
  assert.deepEqual(appConfigSignInRegistrations.read(), { clients: [], signedOut: [], signedOutOverflow: false });
  openDb().prepare("UPDATE app_config SET value = ? WHERE key = ?").run("{not json", "shaping.signIn");
  assert.equal(appConfigSignInRegistrations.read(), null);
  openDb().prepare("UPDATE app_config SET value = ? WHERE key = ?").run(JSON.stringify({ signedOut: ["not an id"] }), "shaping.signIn");
  assert.equal(appConfigSignInRegistrations.read(), null);
  openDb().exec("DELETE FROM app_config");
});

test("stop waits for a code exchange in flight, so the tokens it receives are stored", async (t) => {
  const records = createMemorySignInStore();
  const h = await harness(t, { store: controlledStore("memory", records) });
  const a = target(h.fake);
  const back = await authorize((await begun(h, a)).authorizationUrl);
  const release = h.fake.hold("/token");
  const completing = h.svc.complete(callback(back));
  while (tokenRequests(h.fake, 0, "authorization_code").length === 0) await new Promise((done) => setTimeout(done, 5));
  let stopped = false;
  const stopping = h.svc.stop().then(() => { stopped = true; });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(stopped, false, "stop waits while the exchange is in flight");
  release();
  assert.equal((await completing).ok, true);
  await stopping;
  assert.equal(stopped, true);
  assert.ok(await records.read(connectionId(a)), "the tokens it received were stored before stop finished");
});

test("a sign-out while a second, overlapping load is still reading keeps that record from loading", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake);
  const { id } = await signIn(first, a);
  await first.svc.stop();

  // The first load's read fails; the second load's read is held after it has read the record.
  const store = controlledStore("memory", records);
  let reads = 0;
  let releaseSecond!: () => void;
  const secondHeld = new Promise<void>((done) => { releaseSecond = done; });
  let secondStarted!: () => void;
  const secondReading = new Promise<void>((done) => { secondStarted = done; });
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((done) => { releaseFirst = done; });
  store.store.read = async (readId) => {
    reads += 1;
    if (reads === 1) {
      await firstHeld;
      throw new SignInStoreError("read", -25308);
    }
    const record = await records.read(readId);
    secondStarted();
    await secondHeld;
    return record;
  };
  const flags = flagSwitch(true);
  const second = await harness(t, { fake: first.fake, clock: first.clock, store, flags, inUse: [use(a)], start: false });
  second.svc.start();
  while (reads === 0) await new Promise((done) => setTimeout(done, 5));
  flags.set(false);
  flags.set(true);
  await secondReading;
  // The first load ends while the second is still reading.
  releaseFirst();
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(await second.svc.signOut(id), true, "a load is still reading, so there is something to sign out of");
  releaseSecond();
  await settle(second);
  assert.deepEqual(second.svc.accessToken(a), { ok: false, reason: "signedOut" });
  assert.equal(viewOf(second, id)?.state, "signed_out");
  assert.equal(await records.read(id), null, "and the stored record is removed");
});

test("a long-lived token never sets a timer longer than a day, and still refreshes and expires on schedule", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  const DAY = 24 * HOUR;
  const seeded = (n: number, scope: string, refreshToken: string | null) => {
    const { id, record } = seededRecord(fake, n, `fake-seeded-client-${n}`, scope);
    return { id, target: record.target, record: { ...record, refreshToken, expiresAt: NOW + 90 * DAY } };
  };
  // Refreshable and in use: due at 75%, day 67.5. No refresh token: removed at expiry, day 90.
  // Refreshable and unused: never refreshed, but woken to report its expiry.
  const inUse = seeded(1, "mcp:long-in-use", "fake-seeded-refresh-1");
  const noRefresh = seeded(2, "mcp:long-no-refresh", null);
  const unused = seeded(3, "mcp:long-unused", "fake-seeded-refresh-3");
  for (const entry of [inUse, noRefresh, unused]) await records.write(entry.id, entry.record);
  const clock = new FakeClock();
  const h = await harness(t, { fake, clock, store: controlledStore("memory", records), inUse: [use(inUse.target)] });
  const longest = () => Math.max(0, ...clock.live().map((timer) => timer.at - clock.t));
  assert.ok(clock.live().length >= 3);
  assert.ok(longest() <= MAX_TIMER_MS, `a timer of ${longest()} ms`);

  const from = fake.requests.length;
  await clock.advance(67 * DAY);
  assert.equal(refreshesSeen(fake, from).length, 0, "nothing before 75% of the lifetime");
  assert.ok(longest() <= MAX_TIMER_MS);
  assert.equal(viewOf(h, unused.id)?.state, "signed_in");
  await clock.advance(DAY);
  assert.equal(refreshesSeen(fake, from).length, 1, "the in-use connection refreshed at day 67.5");
  await clock.advance(22 * DAY);
  assert.equal(viewOf(h, noRefresh.id), undefined, "the record with no refresh token was removed at expiry");
  assert.equal(await records.read(noRefresh.id), null);
  assert.equal(viewOf(h, unused.id)?.state, "renewing", "the unused connection's expiry was reported");
  assert.equal(refreshesSeen(fake, from).length, 1, "the unused connection was never refreshed");
  assert.ok(longest() <= MAX_TIMER_MS);
});

test("a completion superseded during its write leaves nothing stored when the newer completion then fails", async (t) => {
  const records = createMemorySignInStore();
  const store = controlledStore("memory", records);
  const h = await harness(t, { store });
  const a = target(h.fake);
  const id = connectionId(a);
  const back = await authorize((await begun(h, a)).authorizationUrl);
  const writes = store.holdWrites();
  const first = h.svc.complete(callback(back));
  await writes.started;
  // A newer sign-in for the same connection takes over, and its code exchange fails.
  const newer = await begun(h, a);
  const state = new URL(newer.authorizationUrl).searchParams.get("state");
  writes.release();
  assert.equal((await h.svc.complete({ state, code: "fake-code-unknown", error: null, iss: null })).ok, false);
  assert.equal((await first as { code: string }).code, "cancelled");
  await settle(h);
  assert.equal(await records.read(id), null, "the superseded write is not left in the store");
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
});

test("idle waits for a revoke that outlasts signOut's 5 second bound", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  const { id } = await signIn(h, a);
  const release = h.fake.hold("/revoke");
  const signingOut = h.svc.signOut(id);
  while (!h.fake.requests.some((request) => request.path === "/revoke")) await new Promise((done) => setTimeout(done, 5));
  h.clock.fireDue(REVOKE_DEADLINE_MS);
  assert.equal(await signingOut, true, "signOut answers at its bound");
  let idle = false;
  const idling = h.svc.idle().then(() => { idle = true; });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(idle, false, "the revoke still running is work in flight");
  release();
  await idling;
  assert.equal(idle, true);
});

test("a refresh that falls due while an older refresh is still running is started once that one ends", async (t) => {
  const held = holdableFlow();
  const h = await harness(t, { flow: held });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const release = held.holdRefreshReplies();
  let replacement: StoredSignIn;
  let from: number;
  try {
    // The first record's 75% refresh starts and its reply is held.
    h.clock.fireDue(46 * MINUTE);
    while (held.replies.length === 0) await new Promise((done) => setTimeout(done, 5));
    // A new sign-in replaces the record while that refresh runs; its own refresh then falls due.
    const back = await authorize((await begun(h, a)).authorizationUrl);
    assert.equal((await h.svc.complete(callback(back))).ok, true);
    replacement = (await h.store.records.read(id))!;
    h.clock.fireDue(46 * MINUTE);
    from = h.fake.requests.length;
  } finally {
    // Released even when an assertion above fails, so teardown never waits on the held reply.
    release();
  }
  await settle(h);
  await h.clock.advance(0);
  const refreshed = refreshesSeen(h.fake, from).map((request) => form(request).get("refresh_token"));
  assert.deepEqual(refreshed, [replacement.refreshToken], "the replacement's refresh ran once the slot freed");
  assert.equal(viewOf(h, id)?.state, "signed_in");
});

test("a load switched off while it reads stops before reading another record", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  for (let n = 0; n < 3; n++) {
    const { id, record } = seededRecord(fake, n, `fake-seeded-client-${n}`, `mcp:seed-${n}`);
    await records.write(id, record);
  }
  const store = controlledStore("memory", records);
  const reads = store.holdReads();
  const flags = flagSwitch(true);
  const h = await harness(t, { fake, store, flags, start: false });
  h.svc.start();
  await reads.started;
  flags.set(false);
  reads.release();
  await settle(h);
  assert.equal(store.calls.filter((call) => call.startsWith("read ")).length, 1, "no read after the flag went off");
});

test("a begin that timed out while queued makes no request, and one whose flag went off during discovery registers nothing", async (t) => {
  const regs = memoryRegistrations();
  const flags = flagSwitch(true);
  const h = await harness(t, { regs, flags });
  const release = h.fake.hold("/.well-known/oauth-authorization-server");
  const first = h.svc.begin(target(h.fake));
  const queued = h.svc.begin(target(h.fake, { url: h.fake.shapeUrl, scope: "mcp:other" }));
  while (!h.fake.requests.some((request) => request.path === "/.well-known/oauth-authorization-server")) {
    await new Promise((done) => setTimeout(done, 5));
  }
  h.clock.fireDue(BEGIN_DEADLINE_MS);
  assert.equal((await first as { code: string }).code, "timeout");
  assert.equal((await queued as { code: string }).code, "timeout");
  release();
  await settle(h);
  assert.equal(h.fake.requests.filter((request) => request.path === "/.well-known/oauth-protected-resource/shape").length, 0,
    "the queued begin never started discovery");
  assert.equal(registrationsSeen(h.fake).length, 0);

  // The flag goes off while discovery is held.
  const holdAgain = h.fake.hold("/.well-known/oauth-authorization-server");
  const from = h.fake.requests.length;
  const offDuring = h.svc.begin(target(h.fake, { scope: "mcp:third" }));
  while (!since(h.fake, from).some((request) => request.path === "/.well-known/oauth-authorization-server")) {
    await new Promise((done) => setTimeout(done, 5));
  }
  flags.set(false);
  holdAgain();
  assert.equal((await offDuring as { code: string }).code, "flag_off");
  await settle(h);
  assert.equal(registrationsSeen(h.fake).length, 0, "no registration request after the flag went off");
  assert.equal(regs.writes, 0);
});

test("the test clock does not fire a timer that an earlier callback cleared", () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  let second: TimerHandle | null = null;
  clock.setTimer(() => { fired.push("first"); if (second) clock.clearTimer(second); }, 10);
  second = clock.setTimer(() => fired.push("second"), 20);
  clock.fireDue(30);
  assert.deepEqual(fired, ["first"]);
});

test("a load whose activation ended publishes nothing, so its late failure cannot refuse a begin with store_unread", async (t) => {
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  // Sixteen registrations, none named: a new scope can make room.
  const regs = memoryRegistrations((await seed(fake, SHAPING_SIGN_IN_CLIENTS, null)).clients);
  const store = controlledStore("memory");
  let listings = 0;
  let failFirst!: () => void;
  const firstHeld = new Promise<void>((done) => { failFirst = done; });
  const listIds = store.store.ids.bind(store.store);
  store.store.ids = async () => {
    listings += 1;
    if (listings === 1) {
      await firstHeld;
      throw new SignInStoreError("ids", -25300);
    }
    return listIds();
  };
  const flags = flagSwitch(true);
  const h = await harness(t, { fake, store, regs, flags, start: false });
  h.svc.start();
  while (listings === 0) await new Promise((done) => setTimeout(done, 5));
  // Off and on: the second load lists the store, which reads fully.
  flags.set(false);
  flags.set(true);
  while (listings < 2) await new Promise((done) => setTimeout(done, 5));
  await new Promise((done) => setTimeout(done, 10));
  // The first load's listing now fails, after its activation ended.
  failFirst();
  await settle(h);
  const answer = await h.svc.begin(target(fake, { scope: "mcp:fresh" }));
  assert.equal(answer.ok, true, `begin answered ${JSON.stringify(answer)}`);
  assert.equal(registrationsSeen(fake).length, 1);
});

test("a begin queued across a flag reset waits for the new load, so it never drops a registration an unread record names", async (t) => {
  const records = createMemorySignInStore();
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  // Sixteen registrations, each named by a stored record.
  const seeded = await seed(fake, SHAPING_SIGN_IN_CLIENTS, records);
  const regs = memoryRegistrations(seeded.clients);
  const store = controlledStore("memory", records);
  let reads = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((done) => { releaseFirst = done; });
  let releaseSecond!: () => void;
  const secondHeld = new Promise<void>((done) => { releaseSecond = done; });
  let secondReading!: () => void;
  const secondStarted = new Promise<void>((done) => { secondReading = done; });
  store.store.read = async (id) => {
    reads += 1;
    const record = await records.read(id);
    if (reads === 1) await firstHeld;
    else { secondReading(); await secondHeld; }
    return record;
  };
  const flags = flagSwitch(true);
  const h = await harness(t, { fake, store, regs, flags, start: false });
  h.svc.start();
  let answer: Promise<BeginAnswer>;
  let keyBefore: ShapingSignInClient[];
  try {
    while (reads === 0) await new Promise((done) => setTimeout(done, 5));
    // Queued behind the first load, for a scope that needs a new registration.
    answer = h.svc.begin(target(fake, { scope: "mcp:fresh" }));
    // Let it start waiting on the first load before the flags are reset.
    await new Promise((done) => setImmediate(done));
    flags.set(false);
    flags.set(true);
    await secondStarted;
    // The first load stops early. The begin must not go on while the second is still reading.
    releaseFirst();
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(registrationsSeen(fake).length, 0, "no registration request while the new load is still reading");
    keyBefore = clientsOf(regs);
  } finally {
    // Both loads are let go even when an assertion above fails, in the same order as normally.
    releaseFirst();
    releaseSecond();
  }
  assert.equal((await answer as { code: string }).code, "registration_limit", "every registration is named once the load has read them");
  assert.equal(registrationsSeen(fake).length, 0);
  assert.deepEqual(clientsOf(regs), keyBefore, "no registration a stored sign-in names was dropped");
});

test("a late refusal of a token already replaced is ignored, and a refusal of the current token is not", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a, "one"), use(a, "two")]);
  const { id } = await signIn(h, a);
  const tokenA = tokenOf(h, a)!;
  // A call goes out with A; the 75% refresh rotates to B before the server's 401 for A arrives.
  await h.clock.advance(46 * MINUTE);
  const tokenB = tokenOf(h, a)!;
  assert.notEqual(tokenB, tokenA);
  const from = h.fake.requests.length;
  h.svc.noteRefused(a, tokenA);
  await settle(h);
  assert.equal(tokenOf(h, a), tokenB, "B is still handed out");
  assert.equal(viewOf(h, id)?.state, "signed_in");
  assert.equal(viewOf(h, id)?.reason, null);
  assert.equal(refreshesSeen(h.fake, from).length, 0, "and no refresh is forced");

  // A refusal of B itself is acted on.
  h.svc.noteRefused(a, tokenB);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "renewing" });
  await settle(h);
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  assert.equal(viewOf(h, id)?.state, "signed_in");
});

test("a late refusal never removes a replacement that has no refresh token", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  await signIn(h, a);
  const tokenA = tokenOf(h, a)!;
  // A new sign-in, from a server that issues no refresh token, replaces A before A's 401 arrives.
  h.fake.setMode({ tokens: "no-refresh" });
  const { id } = await signIn(h, a);
  const tokenB = tokenOf(h, a)!;
  h.svc.noteRefused(a, tokenA);
  await settle(h);
  assert.equal(tokenOf(h, a), tokenB);
  assert.ok(await h.store.records.read(id), "the replacement is kept");
  h.svc.noteRefused(a, tokenB);
  await settle(h);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" }, "refusing B itself still ends a sign-in with no refresh token");
});

test("every row of the accessToken table", async (t) => {
  const flags = flagSwitch(true);
  const h = await harness(t, { flags });
  const a = target(h.fake);

  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" }, "no record");
  const answer = await begun(h, a);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" }, "a sign-in pending");
  await h.svc.complete(callback(await authorize(answer.authorizationUrl)));
  const first = h.svc.accessToken(a);
  assert.ok(first.ok, "a record whose token has not expired");

  flags.set(false);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "flagOff" });
  flags.set(true);
  await settle(h);

  // Refused: renewing until a refresh replaces the token.
  const release = h.fake.hold("/token");
  await refuse(h, a);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "renewing" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "renewing" });
  release();
  await settle(h);
  const replaced = h.svc.accessToken(a);
  assert.ok(replaced.ok && replaced.token !== first.token);

  // Expired, with a refresh token: renewing, and a refresh is asked for.
  h.clock.jump(2 * HOUR);
  const from = h.fake.requests.length;
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "renewing" });
  await settle(h);
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  assert.ok(h.svc.accessToken(a).ok);

  // Expired, with no refresh token: removed from memory at once and from the store in its turn.
  const b = target(h.fake, { url: h.fake.shapeUrl });
  h.fake.setMode({ tokens: "no-refresh" });
  const { id } = await signIn(h, b);
  assert.ok(h.svc.accessToken(b).ok);
  h.clock.jump(2 * HOUR);
  assert.deepEqual(h.svc.accessToken(b), { ok: false, reason: "signedOut" });
  assert.deepEqual(h.svc.accessToken(b), { ok: false, reason: "signedOut" });
  await settle(h);
  assert.equal(await h.store.records.read(id), null);
});

test("refresh at 75%: five triggers make one request, the rotated pair is stored first, and a failing write keeps it in memory", async (t) => {
  const h = await harness(t, { store: controlledStore("keychain") });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const signedInToken = tokenOf(h, a)!;
  assert.equal(viewOf(h, id)?.storage, "keychain");

  // Nothing before 75% of the hour.
  let from = h.fake.requests.length;
  await h.clock.advance(45 * MINUTE - 1);
  assert.equal(refreshesSeen(h.fake, from).length, 0);

  // The 75% refresh, with the store write held: memory keeps the old token until the write is done.
  const writes = h.store.holdWrites();
  const advancing = h.clock.advance(1);
  await writes.started;
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  assert.equal(tokenOf(h, a), signedInToken);
  writes.release();
  await advancing;
  await settle(h);
  const rotated = (await h.store.records.read(id))!;
  assert.notEqual(rotated.accessToken, signedInToken);
  assert.equal(tokenOf(h, a), rotated.accessToken);

  // Five triggers at once: the due refresh, two expired calls and two refusals.
  from = h.fake.requests.length;
  const release = h.fake.hold("/token");
  h.clock.jump(2 * HOUR);
  h.svc.accessToken(a);
  h.svc.accessToken(a);
  await refuse(h, a);
  await refuse(h, a);
  const triggered = h.clock.advance(0);
  await new Promise((done) => setTimeout(done, 50));
  release();
  await triggered;
  await settle(h);
  assert.equal(refreshesSeen(h.fake, from).length, 1);

  // A write that fails: the pair is used from memory, and the view says so.
  h.store.failWrites = true;
  from = h.fake.requests.length;
  await h.clock.advance(46 * MINUTE);
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  const kept = tokenOf(h, a);
  assert.ok(kept);
  assert.notEqual((await h.store.records.read(id))!.accessToken, kept);
  assert.equal(viewOf(h, id)?.storage, "memory");
  assert.equal(viewOf(h, id)?.reason, SIGN_IN_REASONS.memoryOnly);
  assert.match(SIGN_IN_REASONS.memoryOnly, /restart will need a new sign-in/);
});

test("a token endpoint that is down is retried after 1, 2, 4, 8 and then every 15 minutes, and invalid_grant ends the sign-in", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  h.fake.setMode({ refresh: "503" });
  const from = h.fake.requests.length;
  const times: number[] = [];
  let seen = 0;
  for (let step = 0; step < 7 * 60; step++) {
    await h.clock.advance(MINUTE);
    const count = refreshesSeen(h.fake, from).length;
    if (count > seen) {
      times.push((h.clock.t - NOW) / MINUTE);
      seen = count;
    }
    if (times.length === 7) break;
  }
  assert.deepEqual(times, [45, 46, 48, 52, 60, 75, 90]);
  assert.equal(viewOf(h, id)?.state, "renewing", "renewing once the access token has expired");

  h.fake.setMode({ refresh: "invalid_grant" });
  await h.clock.advance(15 * MINUTE);
  const view = viewOf(h, id)!;
  assert.equal(view.state, "signed_out");
  assert.equal(view.reason, SIGN_IN_REASONS.signInAgain);
  assert.equal(await h.store.records.read(id), null);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
});

test("a sign-out during a refresh keeps nothing the held reply issued, and revokes both pairs", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const held = (await h.store.records.read(id))!;
  const release = h.fake.hold("/token");
  const from = h.fake.requests.length;
  const advancing = h.clock.advance(46 * MINUTE);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await h.svc.signOut(id), true);
  assert.equal(viewOf(h, id)?.state, "signed_out");
  release();
  await advancing;
  await settle(h);
  assert.equal(viewOf(h, id)?.state, "signed_out");
  assert.equal(await h.store.records.read(id), null);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  const revoked = revokedTokens(h.fake, from);
  assert.ok(revoked.includes(held.refreshToken) && revoked.includes(held.accessToken), "the record signed out");
  const issued = refreshesSeen(h.fake, from);
  assert.equal(issued.length, 1);
  const fresh = revoked.filter((token) => token !== held.refreshToken && token !== held.accessToken);
  assert.equal(fresh.length, 2, "the pair the held reply issued");
  assert.ok(fresh.every((token) => /^fake-(access|refresh)-/.test(token!)));
});

test("a removal and a new sign-in that cross: the new record stands in the store and in memory", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.fake.setMode({ tokens: "no-refresh" });
  const { id } = await signIn(h, a);
  h.fake.resetModes();
  h.clock.jump(2 * HOUR);

  const back = await authorize((await begun(h, a)).authorizationUrl);
  const writes = h.store.holdWrites();
  const completing = h.svc.complete(callback(back));
  await writes.started;
  // The old record is expired and has no refresh token: removed while the new one is being stored.
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "signedOut" });
  writes.release();
  assert.equal((await completing).ok, true);
  await settle(h);
  const stored = (await h.store.records.read(id))!;
  assert.ok(stored.refreshToken, "the new sign-in's record");
  assert.equal(tokenOf(h, a), stored.accessToken);
  assert.equal(viewOf(h, id)?.state, "signed_in");
});

test("a token endpoint that is down: calls made before the next try add no request", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  await signIn(h, a);
  h.fake.setMode({ refresh: "503" });
  h.clock.jump(2 * HOUR);
  const from = h.fake.requests.length;
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "renewing" });
  await settle(h);
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  for (let n = 0; n < 3; n++) h.svc.accessToken(a);
  await refuse(h, a);
  await refuse(h, a);
  await settle(h);
  await h.clock.advance(MINUTE - 1);
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  await h.clock.advance(1);
  assert.equal(refreshesSeen(h.fake, from).length, 2, "the next request is the scheduled one");
});

test("a server that refuses every token costs one refresh per wait, and a 75% refresh starts the count again", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const from = h.fake.requests.length;
  const refreshAt: number[] = [];
  const count = () => refreshesSeen(h.fake, from).length;

  await refuse(h, a);
  await settle(h);
  assert.equal(count(), 1, "the first refusal's refresh runs at once");
  refreshAt.push(h.clock.t);
  for (const wait of [1, 2, 4, 8, 15, 15]) {
    await refuse(h, a);
    await settle(h);
    assert.equal(viewOf(h, id)?.state, "renewing");
    assert.equal(viewOf(h, id)?.reason, SIGN_IN_REASONS.refused);
    assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "renewing" });
    const before = count();
    // Refusals in between add nothing.
    await h.clock.advance(wait * MINUTE / 2);
    await refuse(h, a);
    await settle(h);
    assert.equal(count(), before);
    await h.clock.advance(wait * MINUTE / 2);
    assert.equal(count(), before + 1, `the refresh after a ${wait} minute wait`);
    refreshAt.push(h.clock.t);
  }
  assert.deepEqual(refreshAt.slice(1).map((at, n) => (at - refreshAt[n]!) / MINUTE), [1, 2, 4, 8, 15, 15]);
  assert.equal(viewOf(h, id)?.state, "signed_in");

  // A 75% refresh succeeds: the next refusal's refresh runs at once again.
  await h.clock.advance(45 * MINUTE);
  const afterDue = count();
  assert.equal(afterDue, refreshAt.length + 1);
  await refuse(h, a);
  await settle(h);
  assert.equal(count(), afterDue + 1);
});

test("a refresh and a new sign-in that cross: the new sign-in stands, and the held reply's tokens are revoked", async (t) => {
  const held = holdableFlow();
  const h = await harness(t, { flow: held });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const release = held.holdRefreshReplies();
  const from = h.fake.requests.length;
  const advancing = h.clock.advance(46 * MINUTE);
  while (held.replies.length === 0) await new Promise((done) => setTimeout(done, 5));

  // The new sign-in completes while the refresh's reply is still held.
  const answer = await begun(h, a);
  assert.equal((await h.svc.complete(callback(await authorize(answer.authorizationUrl)))).ok, true);
  const fresh = (await h.store.records.read(id))!;
  release();
  await advancing;
  await settle(h);
  assert.deepEqual(await h.store.records.read(id), fresh);
  assert.equal(tokenOf(h, a), fresh.accessToken);
  const reply = held.replies[0]!;
  assert.ok(reply.ok);
  const revoked = revokedTokens(h.fake, from);
  assert.ok(revoked.includes(reply.tokens.accessToken) && revoked.includes(reply.tokens.refreshToken));
});

test("client_rejected ends every sign-in that names the client, drops its pending sign-in, then its registration", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  const b = target(h.fake, { url: h.fake.shapeUrl });
  const c = target(h.fake, { url: `${h.fake.shapeUrl}?tenant=three` });
  h.svc.setInUse([use(a), use(b), use(c)]);
  const { id: idA } = await signIn(h, a);
  const { id: idB } = await signIn(h, b);
  const pending = await begun(h, c);
  assert.equal(registrationsSeen(h.fake).length, 1, "all three share one client");
  assert.equal(viewOf(h, pending.connection)?.state, "pending");

  h.fake.setMode({ refresh: "invalid_client" });
  await h.clock.advance(46 * MINUTE);
  for (const id of [idA, idB]) {
    assert.equal(viewOf(h, id)?.state, "signed_out");
    assert.equal(viewOf(h, id)?.reason, SIGN_IN_REASONS.signInAgain);
    assert.equal(await h.store.records.read(id), null);
  }
  assert.equal(viewOf(h, pending.connection)?.state, "signed_out", "the pending sign-in is gone");
  assert.deepEqual(clientsOf(h.regs), []);
});

test("a connection that is not in use is not refreshed", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  const { id } = await signIn(h, a);
  const from = h.fake.requests.length;
  await h.clock.advance(3 * HOUR);
  assert.equal(refreshesSeen(h.fake, from).length, 0);
  assert.ok(viewOf(h, id));
  // Named again, it is refreshed at once.
  h.svc.setInUse([use(a)]);
  await h.clock.advance(0);
  assert.equal(refreshesSeen(h.fake, from).length, 1);
  assert.equal(viewOf(h, id)?.state, "signed_in");
});

test("a restarted service is signed in with no request, refreshes a record that expired meanwhile, and a spent token ends signed_out", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake);
  const { id } = await signIn(first, a);
  const spent = (await records.read(id))!;
  await first.svc.stop();

  const from = first.fake.requests.length;
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", records) });
  assert.equal(viewOf(second, id)?.state, "signed_in");
  assert.equal(tokenOf(second, a), spent.accessToken);
  assert.equal(first.fake.requests.length, from, "no request at start");
  await second.svc.stop();

  first.clock.jump(2 * HOUR);
  const third = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", records), inUse: [use(a)] });
  await third.clock.advance(0);
  assert.equal(refreshesSeen(first.fake, from).length, 1);
  assert.equal(viewOf(third, id)?.state, "signed_in");
  await third.svc.stop();

  // A copy of the store from before that refresh holds a spent refresh token.
  const stale = createMemorySignInStore();
  await stale.write(id, spent);
  const fourth = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", stale), inUse: [use(a)] });
  await fourth.clock.advance(0);
  assert.equal(viewOf(fourth, id)?.state, "signed_out");
  assert.equal(viewOf(fourth, id)?.reason, SIGN_IN_REASONS.signInAgain);
  assert.equal(await stale.read(id), null);
});

test("after a restart, a stored sign-in no shaper names is listed, not refreshed, and can be signed out", async (t) => {
  const records = createMemorySignInStore();
  const first = await harness(t, { store: controlledStore("memory", records) });
  const a = target(first.fake, { scope: "mcp:other" });
  const { id } = await signIn(first, a);
  await first.svc.stop();
  // A record stored under an id its target does not hash to is ignored.
  const misfiled = { ...(await records.read(id))!, accessToken: "fake-misfiled-access" };
  await records.write("0123456789abcdef0123456789abcdef", misfiled);

  first.clock.jump(2 * HOUR);
  const from = first.fake.requests.length;
  const second = await harness(t, { fake: first.fake, clock: first.clock, store: controlledStore("memory", records), inUse: [] });
  await second.clock.advance(HOUR);
  const view = second.svc.view();
  assert.equal(view.length, 1);
  assert.equal(view[0]!.id, id);
  assert.equal(view[0]!.url, first.fake.resourceUrl);
  assert.equal(view[0]!.scope, "mcp:other");
  assert.deepEqual(view[0]!.shapers, []);
  assert.equal(first.fake.requests.length, from, "no request for it");
  assert.equal(await second.svc.signOut(id), true);
  await settle(second);
  assert.equal(await records.read(id), null);
});

test("with either flag off: no store, no request, no timer, and flagOff", async (t) => {
  const flags = flagSwitch(false);
  const h = await harness(t, { flags });
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  assert.deepEqual(h.svc.accessToken(a), { ok: false, reason: "flagOff" });
  await refuse(h, a);
  assert.deepEqual(await h.svc.begin(a), { ok: false, code: "flag_off", reason: SIGN_IN_BEGIN_REFUSALS.flag_off });
  assert.equal((await h.svc.complete({ state: "fake-state", code: "fake-code", error: null, iss: null })).ok, false);
  assert.equal(await h.svc.signOut(connectionId(a)), false);
  assert.deepEqual(h.svc.view(), []);
  await settle(h);
  assert.equal(h.storesBuilt(), 0);
  assert.deepEqual(h.store.calls, []);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(h.clock.live().length, 0);

  // Turning both on loads then; turning one off clears the timers and keeps the sign-in.
  flags.set(true);
  await settle(h);
  assert.deepEqual(h.store.calls, ["ids"]);
  const { id } = await signIn(h, a);
  assert.ok(h.clock.live().length > 0);
  flags.set(false);
  assert.equal(h.clock.live().length, 0);
  assert.deepEqual(h.svc.view(), []);
  flags.set(true);
  await settle(h);
  assert.equal(viewOf(h, id)?.state, "signed_in");
  assert.ok(await h.store.records.read(id));
});

test("signOut removes the record, revokes it, and keeps the registration", async (t) => {
  const h = await harness(t);
  const a = target(h.fake);
  h.svc.setInUse([use(a)]);
  const { id } = await signIn(h, a);
  const record = (await h.store.records.read(id))!;
  const from = h.fake.requests.length;
  assert.equal(await h.svc.signOut(id), true);
  await settle(h);
  assert.equal(await h.store.records.read(id), null);
  assert.deepEqual(revokedTokens(h.fake, from).sort(), [record.accessToken, record.refreshToken].sort());
  assert.deepEqual(clientIds(h.regs), [record.clientId]);
  assert.equal(viewOf(h, id)?.state, "signed_out");
  assert.equal(viewOf(h, id)?.reason, null);
  assert.equal(await h.svc.signOut("ffffffffffffffffffffffffffffffff"), false);
});

test("no token, code, state or verifier leaves the store and the service: not the view, events, app_config or a settings snapshot", async (t) => {
  openDb().exec("DELETE FROM app_config");
  const h = await harness(t, { regs: appConfigSignInRegistrations });
  const a = target(h.fake);
  h.svc.setInUse([use(a, "context")]);
  const { back, id, authorizationUrl } = await signIn(h, a);
  await h.clock.advance(46 * MINUTE);
  await settle(h);

  const record = (await h.store.records.read(id))!;
  const exchangeBody = form(tokenRequests(h.fake, 0, "authorization_code")[0]!);
  const secrets = [
    ...h.fake.requests.flatMap((request) => [...request.body.matchAll(/fake-(?:access|refresh)-\d+/g)].map((match) => match[0])),
    record.accessToken, record.refreshToken!, back.get("code")!, back.get("state")!, exchangeBody.get("code_verifier")!,
  ];
  assert.ok(secrets.length >= 6);

  const stored = JSON.stringify(getAppConfig(APP_CONFIG_ENTRIES.shapingSignIn));
  assert.match(stored, /"clientId":"fake-client-\d+"/);
  const snapshot = JSON.stringify(captureSettingsConfig());
  assert.ok(!snapshot.includes("shaping.signIn") && !snapshot.includes(record.clientId), "the snapshot does not carry shaping.signIn");
  const surfaces = {
    view: JSON.stringify(h.svc.view()),
    changes: JSON.stringify(h.changes),
    appConfig: stored,
    snapshot,
    warnings: JSON.stringify(h.warnings),
  };
  assert.ok(h.changes.length >= 2);
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${surface} holds ${secret.slice(0, 12)}…`);
    assert.ok(!text.includes(authorizationUrl), `${surface} holds the authorization URL`);
  }
});

test("signInUses groups the known shapers by connection, registered and discovered", () => {
  const url = "https://tools.example/mcp";
  const shaper = (id: string, scope: string | null) => ({
    id, label: id, stage: "select",
    transport: {
      type: "mcp", tool: "get_guidance",
      server: { type: "http", url, headers: {}, ...(scope ? { auth: { type: "oauth", scope } } : {}) },
    },
  });
  const config = ShapingConfigSchema.parse({ shapers: [shaper("a", "mcp:one"), shaper("b", null)] });
  const manifest = (id: string, scope: string) => ShaperManifestSchema.parse(shaper(id, scope));
  const discovered = [
    { id: "c", path: "/x/c", state: "ok" as const, problem: null, sha256: null, shaper: manifest("c", "mcp:one") },
    { id: "d", path: "/x/d", state: "ok" as const, problem: null, sha256: null, shaper: manifest("d", "mcp:two") },
    { id: "e", path: "/x/e", state: "invalid" as const, problem: "no", sha256: null, shaper: null },
    // Shadowed by the registered shaper with the same id.
    { id: "a", path: "/x/a", state: "ok" as const, problem: null, sha256: null, shaper: manifest("a", "mcp:three") },
  ];
  const uses = signInUses(config, discovered);
  assert.deepEqual(uses.map((entry) => [entry.target.scope, entry.shapers]), [["mcp:one", ["a", "c"]], ["mcp:two", ["d"]]]);
});
