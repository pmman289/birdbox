import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import type { ApiErrorResponse, ChangeEvent, DashboardResponse } from "../../packages/contracts/src/api.js";
import type { MutationService } from "../application-contracts.js";
import type { AuthStore } from "../auth.js";
import { fail, isPublicError, safeErrorMessage, type PublicError } from "../errors.js";
import type { InventoryStore } from "../store.js";
import { logger } from "../logger.js";
import { authRoutes } from "./auth-routes.js";
import { requestSessionToken } from "./auth-routes.js";
import type { AgentBroker } from "../agent-broker.js";
import { MemoryDatabase, type StateDatabase } from "../database.js";
import { AuditWriter, MetricsRegistry } from "../observability.js";
import { agentRoutes } from "./agent-routes.js";
import { auditRoutes } from "./audit-routes.js";
import { dashboardRoutes } from "./dashboard-routes.js";
import { mutationRoutes } from "./mutation-routes.js";
import { sessionRuntimeRoutes } from "./session-runtime-routes.js";
import { inspectOspfRuntime } from "../bird.js";

interface HttpApplicationOptions {
  publicDirectory: string;
  appVersion: string;
  authStore: AuthStore;
  store: InventoryStore;
  secureCookieSetting: boolean | null;
  ping(): Promise<unknown>;
  isDeploymentLocked(): boolean;
  recoveryState?: () => "idle" | "pending" | "failed";
  loadDashboard(nodeId: string | null, peerId: string | null): Promise<DashboardResponse>;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  withNodeOperationLock<Result>(nodeId: string, operation: () => Promise<Result> | Result): Promise<Result>;
  mutationService: MutationService;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
  agentBroker: AgentBroker;
  agentBinaryPath?: string;
  agentPublicUrl?: string;
  database?: StateDatabase;
  metricsToken?: string | null;
  trustProxy?: boolean | string | number;
  inspectOspfRuntime?: typeof inspectOspfRuntime;
  ospfRuntimeTimeoutMs?: number;
}

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
}

function assertSameOrigin(request: FastifyRequest): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    // Fastify's request.hostname intentionally strips the port. Compare the
    // Origin with the raw Host header first so normal non-default dev ports
    // (and an HTTPS reverse proxy) are not rejected as cross-site requests.
    const requestHost = String(request.headers.host || request.hostname || "").toLowerCase();
    if (originHost !== requestHost) {
      fail(403, "请求来源不受信任");
    }
  } catch {
    fail(403, "请求来源不受信任");
  }
}

function sendJson(
  reply: FastifyReply,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): FastifyReply {
  return reply.code(status).headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  }).send(payload);
}

async function serveStatic(
  reply: FastifyReply,
  publicDirectory: string,
  pathname: string,
  appVersion: string,
): Promise<FastifyReply> {
  let requested: string;
  try {
    requested = decodeURIComponent(pathname === "/" ? "index.html" : pathname.slice(1));
  } catch {
    return reply.code(404).send();
  }
  const normalized = path.normalize(requested);
  const root = path.resolve(publicDirectory);
  const fullPath = path.resolve(root, normalized);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) return reply.code(403).send();
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return reply.code(404).send();
    let content = await fs.readFile(fullPath);
    if (normalized === "index.html") {
      content = Buffer.from(content.toString("utf8").replaceAll("__BIRDBOX_VERSION__", encodeURIComponent(appVersion)));
    }
    const etag = `"${createHash("sha256").update(content).digest("hex").slice(0, 32)}"`;
    const immutable = normalized !== "index.html"
      && (normalized === "styles.css" || normalized.startsWith("migrated/") || normalized.startsWith("vendor/"));
    const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    if (String(reply.request.headers["if-none-match"] ?? "") === etag) {
      return reply.code(304).header("etag", etag).header("cache-control", cacheControl).send();
    }
    return reply
      .type(MIME_TYPES[path.extname(normalized)] ?? "application/octet-stream")
      .header("etag", etag)
      .header("cache-control", cacheControl)
      .send(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return reply.code(code === "ENOENT" || code === "EISDIR" ? 404 : 500).send();
  }
}

export async function createHttpApplication(options: HttpApplicationOptions) {
  const app = Fastify({
    bodyLimit: 128 * 1024,
    // Make the intended HTTP/1 server overload explicit. Without this flag,
    // Fastify's conditional typings can infer the HTTP/2 overload when the
    // trust-proxy compatibility value is supplied by the environment.
    http2: false,
    // Agent task polling may wait up to 30 seconds. Keep both timers above
    // that window so idle outbound agents are not disconnected by the server.
    // Deployments may legitimately take several minutes across multiple
    // nodes. Route-level timeouts and Agent task deadlines remain authoritative.
    requestTimeout: 0,
    connectionTimeout: 0,
    keepAliveTimeout: 5000,
    maxRequestsPerSocket: 0,
    logger: false,
    // Fastify supports a numeric hop count at runtime, but its v5 declaration
    // omits that legacy-compatible form. Keep the public environment contract
    // while constraining the compile-time option to the accepted union.
    trustProxy: options.trustProxy as boolean | string | string[] | undefined ?? false,
  });

  app.server.maxHeadersCount = 100;
  const metrics = new MetricsRegistry();
  const auditDatabase = options.database ?? new MemoryDatabase();
  const audit = new AuditWriter(auditDatabase);
  const requestStartedAt = new WeakMap<FastifyRequest, number>();
  app.decorateRequest("loginReservation", null);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const source = typeof body === "string" ? body : body.toString("utf8");
    if (source === "") return done(null, {});
    try {
      return done(null, JSON.parse(source));
    } catch {
      const error = new Error("JSON 请求体必须是合法对象") as PublicError;
      error.status = 400;
      return done(error);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, Date.now());
    applySecurityHeaders(reply);
    if (request.url.startsWith("/api/")) assertSameOrigin(request);
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request) ?? Date.now();
    const pathname = new URL(request.raw.url ?? "/", "http://localhost").pathname;
    // Route templates keep metric cardinality bounded even for resource IDs.
    const route = request.routeOptions?.url ?? pathname.replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, "/:id");
    metrics.observeRequest(request.method, route, reply.statusCode, Date.now() - startedAt);
    // Agent poll/heartbeat/result traffic is machine-generated and can be
    // very frequent. Keep it in request metrics, but do not turn it into a
    // high-volume human audit stream; registration and failed controller
    // operations remain visible through structured logs and metrics.
    const auditableApiRequest = pathname.startsWith("/api/")
      && !pathname.startsWith("/api/agent/")
      && !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (auditableApiRequest) {
      const authenticated = await options.authStore.isAuthenticated(requestSessionToken(request)).catch(() => false);
      audit.record({
        requestId: request.id,
        actor: authenticated ? "admin" : "anonymous",
        method: request.method,
        path: pathname,
        status: reply.statusCode,
        outcome: reply.statusCode >= 400 ? "error" : "success",
        remoteAddress: request.ip ?? request.socket.remoteAddress ?? null,
        userAgent: String(request.headers["user-agent"] ?? "") || null,
        detail: reply.statusCode >= 400 ? `HTTP ${reply.statusCode}` : null,
      });
    }
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (request, reply) => {
      const url = new URL(request.raw.url ?? "/", "http://localhost");
      return serveStatic(reply, options.publicDirectory, url.pathname, options.appVersion);
    },
  });
  app.setErrorHandler(async (error, request, reply) => {
    const publicError = error as PublicError;
    const pathname = new URL(request.raw.url ?? "/", "http://localhost").pathname;
    const authPath = pathname.startsWith("/api/auth/");
    const healthPath = pathname === "/api/health";
    if (publicError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      publicError.status = 413;
      publicError.message = "请求体过大";
    } else if (
      publicError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
      || publicError.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      publicError.status = 400;
      publicError.message = "JSON 请求体必须是合法对象";
    }
    const unexpected = !isPublicError(publicError);
    const unauthenticatedPrefix = pathname.startsWith("/api/agent/")
      || pathname.startsWith("/api/nodes/setup-script/")
      || pathname.startsWith("/api/auth/")
      || healthPath;
    const authenticated = !unauthenticatedPrefix && publicError.code !== "AUTH_REQUIRED"
      ? await options.authStore.isAuthenticated(requestSessionToken(request)).catch(() => false)
      : false;
    if (authenticated) options.addEvent("error", safeErrorMessage(publicError));
    if (healthPath) return sendJson(reply, 503, { status: "error" });
    if (unexpected || (publicError.status ?? publicError.statusCode ?? 500) >= 500) {
      logger.error("HTTP 请求处理失败", {
        requestId: request.id,
        method: request.method,
        path: pathname,
        status: publicError.status ?? publicError.statusCode ?? 500,
        ...({ error: safeErrorMessage(publicError) }),
      });
    }
    const payload: ApiErrorResponse = { error: unexpected ? "服务器内部错误" : publicError.message };
    if (!unexpected && publicError.code) payload.code = publicError.code;
    if (authenticated) payload.events = options.getEvents();
    if (!reply.sent) {
      return sendJson(reply, publicError.status ?? publicError.statusCode ?? 500, payload);
    }
    reply.raw.destroy();
  });

  await app.register(authRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
  });
  await app.register(agentRoutes, { broker: options.agentBroker, binaryPath: options.agentBinaryPath });
  await app.register(auditRoutes, { authStore: options.authStore, secureCookieSetting: options.secureCookieSetting, database: auditDatabase });
  await app.register(dashboardRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
    ping: options.ping,
    isDeploymentLocked: options.isDeploymentLocked,
    recoveryState: options.recoveryState,
    loadDashboard: options.loadDashboard,
  });
  await app.register(sessionRuntimeRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
    store: options.store,
    withDeploymentLock: options.withDeploymentLock,
    withNodeOperationLock: options.withNodeOperationLock,
    addEvent: options.addEvent,
    getEvents: options.getEvents,
    inspectOspfRuntime: options.inspectOspfRuntime,
    ospfRuntimeTimeoutMs: options.ospfRuntimeTimeoutMs,
  });
  await app.register(mutationRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
    service: options.mutationService,
    agentBroker: options.agentBroker,
    agentPublicUrl: options.agentPublicUrl,
    agentBinaryPath: options.agentBinaryPath,
    appVersion: options.appVersion,
  });

  app.get("/metrics", async (request, reply) => {
    const expected = options.metricsToken?.trim() || null;
    if (expected) {
      const authorization = String(request.headers.authorization ?? "");
      if (authorization !== `Bearer ${expected}`) return reply.code(401).type("text/plain; version=0.0.4").send("unauthorized\n");
    }
    return reply.type("text/plain; version=0.0.4").header("cache-control", "no-store").send(metrics.render());
  });

  return app;
}
