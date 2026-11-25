// A loopback OAuth 2.1 authorization server in front of two protected resources, for shaper
// sign-in's tests. Fake values only: every client id, code and token is `fake-...`, every host is
// 127.0.0.1, and there is no login page - `/authorize` approves at once.
//
// `startFakeOAuthServer(options)` resolves to:
//   resourceUrl   the protected `/mcp`, an MCP server with `get_guidance` (fake-guidance-mcp.mjs)
//   shapeUrl      the protected `/shape`, which answers a shaping result to a POST
//   issuer        the authorization server's URL: the resource server's origin, or a second
//                 loopback origin with `{ separateIssuer: true }`
//   elsewhereUrl  a third loopback origin nothing should reach; its requests are recorded too
//   requests      every request: `{ server, method, path, query, headers, body }`
//   setMode(patch), hold(path) -> release(), close()
//
// A token is accepted only by the resource its sign-in named in `resource`. Refresh tokens are
// single use and rotate.
//
// Modes, set with `setMode`:
//   refresh        "ok" | "invalid_grant" | "invalid_client" | "invalid_scope" | "503" | "close"
//   registration   "ok" | "secret" | "refuse" | "auth-method" (registers a client_secret_basic client with no secret)
//   metadata       "ok" | "wrong-issuer" | "foreign-endpoint" | "no-s256" | "no-registration" | "no-code"
//   resourceMetadata "ok" | "none" | "foreign-issuer" (names elsewhereUrl as its authorization server)
//                  | "wrong-resource" (names a resource on elsewhereUrl)
//   shape          "ok" | "echo" | "error" | "unauthorized"
//   stall          a path that never answers
//   oversize       a path that answers 100 KiB
//   redirect       a path that answers 307 to elsewhereUrl
//   status         { [path]: status }: that path answers an HTML status page repeating the request body
//   iss            true: the `/authorize` redirect carries `iss`; or a string to send instead
//   tokens         "full" | "no-refresh" (no refresh token, and a refresh does not rotate) | "no-expiry" | "no-scope"
//   revoke         "ok" | "400" | "429" | "503" | "close"; each error body repeats the token
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGuidanceServer } from "./fake-guidance-mcp.mjs";

const SCOPES_ADVERTISED = ["mcp:context", "mcp:other", "mcp", "offline_access"];

const DEFAULT_MODES = {
  refresh: "ok", registration: "ok", metadata: "ok", resourceMetadata: "ok", shape: "ok",
  stall: null, oversize: null, redirect: null, status: null, iss: false, tokens: "full", revoke: "ok",
};

async function listen(handler) {
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error?.message ?? error));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
};
const oauthError = (res, status, error, description) => json(res, status, { error, ...(description ? { error_description: description } : {}) });
const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");

export async function startFakeOAuthServer({ separateIssuer = false } = {}) {
  const requests = [];
  const modes = { ...DEFAULT_MODES };
  const holds = new Map();
  const clients = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const counters = { client: 0, code: 0, token: 0 };
  const sockets = new Set();

  const elsewhere = await listen(async (req, res) => {
    requests.push({ server: "elsewhere", method: req.method, path: req.url, query: "", headers: { ...req.headers }, body: await readBody(req) });
    json(res, 200, { reached: "elsewhere" });
  });

  // Filled in once both origins are known.
  const urls = {};

  const issuerMetadata = () => {
    const base = urls.issuer;
    const metadata = {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES_ADVERTISED,
    };
    switch (modes.metadata) {
      case "wrong-issuer": metadata.issuer = elsewhere.origin; break;
      case "foreign-endpoint": metadata.token_endpoint = `${elsewhere.origin}/token`; break;
      case "no-s256": metadata.code_challenge_methods_supported = ["plain"]; break;
      case "no-registration": delete metadata.registration_endpoint; break;
      case "no-code": metadata.response_types_supported = ["token"]; break;
    }
    return metadata;
  };

  const resourceMetadata = (resource) => ({
    resource: modes.resourceMetadata === "wrong-resource" ? `${elsewhere.origin}/mcp` : resource,
    authorization_servers: [modes.resourceMetadata === "foreign-issuer" ? elsewhere.origin : urls.issuer],
    scopes_supported: SCOPES_ADVERTISED,
    bearer_methods_supported: ["header"],
  });

  /** The bearer token on `req` when it was issued for `resource`, or null. */
  const bearerFor = (req, resource) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const grant = token ? accessTokens.get(token) : null;
    return grant && grant.resource === resource ? token : null;
  };

  const challenge = (res, wellKnown) => {
    res.writeHead(401, {
      "www-authenticate": `Bearer resource_metadata="${urls.resourceOrigin}/.well-known/oauth-protected-resource${wellKnown}"`,
      "content-type": "application/json",
    }).end(JSON.stringify({ error: "invalid_token" }));
  };

  const issue = (clientId, scope, resource) => {
    const n = ++counters.token;
    const access = `fake-access-${n}`;
    const refresh = `fake-refresh-${n}`;
    accessTokens.set(access, { clientId, scope, resource });
    const reply = { access_token: access, token_type: "Bearer", expires_in: 3600, scope };
    if (modes.tokens === "no-expiry") delete reply.expires_in;
    if (modes.tokens === "no-scope") delete reply.scope;
    if (modes.tokens === "no-refresh") return reply;
    refreshTokens.set(refresh, { clientId, scope, resource, used: false });
    return { ...reply, refresh_token: refresh };
  };

  const handle = (serverName) => async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readBody(req);
    const record = { server: serverName, method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers }, body };
    requests.push(record);
    const path = url.pathname;
    const isIssuer = serverName === "issuer" || (!separateIssuer && serverName === "resource");
    const isResource = serverName === "resource";

    if (modes.stall === path) return new Promise(() => {});
    if (modes.oversize === path) return json(res, 200, { padding: "x".repeat(100 * 1024) });
    if (modes.redirect === path) { res.writeHead(307, { location: `${elsewhere.origin}${path}${url.search}` }).end(); return; }
    // A status page that is not an OAuth reply, as a gateway or proxy answers, repeating the request it got.
    if (modes.status?.[path]) {
      res.writeHead(modes.status[path], { "content-type": "text/html" }).end(`<html><body>HTTP ${modes.status[path]} for ${path}: ${body}</body></html>`);
      return;
    }
    const held = holds.get(path);
    if (held) await held.promise;

    if (isResource && path === "/.well-known/oauth-protected-resource/mcp") {
      return modes.resourceMetadata === "none" ? json(res, 404, {}) : json(res, 200, resourceMetadata(urls.resourceUrl));
    }
    if (isResource && path === "/.well-known/oauth-protected-resource/shape") {
      return modes.resourceMetadata === "none" ? json(res, 404, {}) : json(res, 200, resourceMetadata(urls.shapeUrl));
    }
    if (isIssuer && path === "/.well-known/oauth-authorization-server") return json(res, 200, issuerMetadata());

    if (isIssuer && path === "/register" && req.method === "POST") {
      if (modes.registration === "refuse") return oauthError(res, 400, "invalid_client_metadata", "registration is closed");
      const metadata = JSON.parse(body);
      const clientId = `fake-client-${++counters.client}`;
      clients.set(clientId, { redirectUris: metadata.redirect_uris ?? [], scope: metadata.scope ?? "" });
      const secret = modes.registration === "secret" ? { client_secret: `fake-secret-${counters.client}` }
        : modes.registration === "auth-method" ? { token_endpoint_auth_method: "client_secret_basic" } : {};
      return json(res, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...secret });
    }

    if (isIssuer && path === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      const client = clients.get(q.get("client_id") ?? "");
      const redirectUri = q.get("redirect_uri") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri)) return oauthError(res, 400, "invalid_request", "unknown client or redirect URI");
      const back = new URL(redirectUri);
      if (q.get("state")) back.searchParams.set("state", q.get("state"));
      if (modes.iss) back.searchParams.set("iss", typeof modes.iss === "string" ? modes.iss : urls.issuer);
      const registered = new Set(client.scope.split(" ").filter(Boolean));
      const requested = (q.get("scope") ?? "").split(" ").filter(Boolean);
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        back.searchParams.set("error", "invalid_request");
      } else if (requested.length === 0 || requested.some((scope) => !registered.has(scope))) {
        back.searchParams.set("error", "invalid_scope");
      } else {
        const code = `fake-code-${++counters.code}`;
        codes.set(code, {
          clientId: q.get("client_id"), redirectUri, challenge: q.get("code_challenge"), scope: requested.join(" "),
          resource: q.get("resource"), used: false,
        });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.href }).end();
      return;
    }

    if (isIssuer && path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const clientId = form.get("client_id") ?? "";
      if (form.get("grant_type") === "authorization_code") {
        if (!clients.has(clientId)) return oauthError(res, 401, "invalid_client");
        const grant = codes.get(form.get("code") ?? "");
        if (!grant || grant.used || grant.clientId !== clientId || grant.redirectUri !== form.get("redirect_uri")
          || s256(form.get("code_verifier") ?? "") !== grant.challenge) {
          return oauthError(res, 400, "invalid_grant", "the code or its verifier does not match");
        }
        grant.used = true;
        return json(res, 200, issue(clientId, grant.scope, form.get("resource") ?? grant.resource));
      }
      if (form.get("grant_type") === "refresh_token") {
        switch (modes.refresh) {
          case "invalid_grant": return oauthError(res, 400, "invalid_grant", "the refresh token was revoked");
          case "invalid_client": return oauthError(res, 401, "invalid_client", "the client is no longer accepted");
          case "invalid_scope": return oauthError(res, 400, "invalid_scope", "the scope is no longer granted");
          case "503": res.writeHead(503, { "content-type": "text/plain" }).end(`unavailable for ${form.get("refresh_token")}`); return;
          case "close": req.socket.destroy(); return;
        }
        if (!clients.has(clientId)) return oauthError(res, 401, "invalid_client");
        const grant = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!grant || grant.used || grant.clientId !== clientId) return oauthError(res, 400, "invalid_grant", "the refresh token is spent");
        // A server that does not rotate keeps the refresh token valid and answers none.
        if (modes.tokens !== "no-refresh") grant.used = true;
        return json(res, 200, issue(clientId, grant.scope, grant.resource));
      }
      return oauthError(res, 400, "unsupported_grant_type");
    }

    if (isIssuer && path === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(body).get("token");
      switch (modes.revoke) {
        case "400": return oauthError(res, 400, "invalid_request", `cannot revoke ${token}`);
        case "429": res.writeHead(429, { "content-type": "text/plain" }).end(`slow down with ${token}`); return;
        case "503": res.writeHead(503, { "content-type": "text/plain" }).end(`unavailable for ${token}`); return;
        case "close": req.socket.destroy(); return;
      }
      res.writeHead(200).end();
      return;
    }

    if (isResource && path === "/mcp") {
      if (!bearerFor(req, urls.resourceUrl)) return challenge(res, "/mcp");
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const server = createGuidanceServer("ok");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(body));
      return;
    }

    if (isResource && path === "/shape") {
      if (modes.shape === "unauthorized" || !bearerFor(req, urls.shapeUrl)) return challenge(res, "/shape");
      const authorization = req.headers.authorization;
      if (modes.shape === "error") { res.writeHead(500, { "content-type": "text/plain" }).end(`refused ${authorization}`); return; }
      const request = JSON.parse(body || "{}");
      const text = modes.shape === "echo" ? `the server received ${authorization}` : `guidance for ${request?.task?.title ?? "the task"}`;
      return json(res, 200, { version: "fake-1", guidance: [{ id: "fake/guide", title: "Guide", body: text }], truncated: false, degraded: false });
    }

    json(res, 404, { error: "not_found" });
  };

  const resource = await listen(handle("resource"));
  const issuerServer = separateIssuer ? await listen(handle("issuer")) : null;
  urls.resourceOrigin = resource.origin;
  urls.resourceUrl = `${resource.origin}/mcp`;
  urls.shapeUrl = `${resource.origin}/shape`;
  urls.issuer = issuerServer?.origin ?? resource.origin;

  const servers = [resource.server, elsewhere.server, ...(issuerServer ? [issuerServer.server] : [])];
  for (const server of servers) server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  return {
    resourceUrl: urls.resourceUrl,
    shapeUrl: urls.shapeUrl,
    issuer: urls.issuer,
    elsewhereUrl: elsewhere.origin,
    requests,
    setMode(patch) { Object.assign(modes, patch); },
    resetModes() { Object.assign(modes, DEFAULT_MODES); },
    hold(path) {
      let release;
      const promise = new Promise((done) => { release = done; });
      holds.set(path, { promise, release: () => release() });
      return () => { holds.delete(path); release(); };
    },
    close: async () => {
      for (const held of holds.values()) held.release();
      holds.clear();
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); })));
    },
  };
}
