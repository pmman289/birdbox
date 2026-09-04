import { promises as fs } from "node:fs";
import path from "node:path";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import type { ApiErrorResponse, ChangeEvent, DashboardResponse } from "../../packages/contracts/src/api.js";
import type { MutationService } from "../application-contracts.js";
import type { AuthStore } from "../auth.js";
import { fail, isPublicError, safeErrorMessage, type PublicError } from "../errors.js";
import type { InventoryStore } from "../store.js";
import { authRoutes } from "./auth-routes.js";
import { dashboardRoutes } from "./dashboard-routes.js";
import { mutationRoutes } from "./mutation-routes.js";
import { sessionRuntimeRoutes } from "./session-runtime-routes.js";

interface HttpApplicationOptions {
  publicDirectory: string;
  appVersion: string;
  authStore: AuthStore;
  store: InventoryStore;
  secureCookieSetting: boolean | null;
  ping(): Promise<unknown>;
  isDeploymentLocked(): boolean;
  loadDashboard(nodeId: string | null, peerId: string | null): Promise<DashboardResponse>;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  mutationService: MutationService;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
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
    if (new URL(origin).host.toLowerCase() !== String(request.headers.host ?? "").toLowerCase()) {
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
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = path.normalize(requested);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return reply.code(403).send();
  try {
    let content = await fs.readFile(path.join(publicDirectory, normalized));
    if (normalized === "index.html") {
      content = Buffer.from(content.toString("utf8").replaceAll("__BIRDBOX_VERSION__", encodeURIComponent(appVersion)));
    }
    return reply.type(MIME_TYPES[path.extname(normalized)] ?? "application/octet-stream").send(content);
  } catch (error) {
    return reply.code((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500).send();
  }
}

export async function createHttpApplication(options: HttpApplicationOptions) {
  const app = Fastify({
    bodyLimit: 128 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    maxRequestsPerSocket: 0,
    logger: false,
  });

  app.server.maxHeadersCount = 100;
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
    applySecurityHeaders(reply);
    if (request.url.startsWith("/api/")) assertSameOrigin(request);
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (request, reply) => {
      const url = new URL(request.raw.url ?? "/", "http://localhost");
      return serveStatic(reply, options.publicDirectory, url.pathname, options.appVersion);
    },
  });
  app.setErrorHandler((error, request, reply) => {
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
    if (!authPath && !healthPath) options.addEvent("error", safeErrorMessage(publicError));
    if (healthPath) return sendJson(reply, 503, { status: "error" });
    if (unexpected) console.error(publicError);
    const payload: ApiErrorResponse = { error: unexpected ? "服务器内部错误" : publicError.message };
    if (!unexpected && publicError.code) payload.code = publicError.code;
    if (!authPath && publicError.code !== "AUTH_REQUIRED") payload.events = options.getEvents();
    if (!reply.sent) {
      return sendJson(reply, publicError.status ?? publicError.statusCode ?? 500, payload);
    }
    reply.raw.destroy();
  });

  await app.register(authRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
  });
  await app.register(dashboardRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
    ping: options.ping,
    isDeploymentLocked: options.isDeploymentLocked,
    loadDashboard: options.loadDashboard,
  });
  await app.register(sessionRuntimeRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
    store: options.store,
    withDeploymentLock: options.withDeploymentLock,
    addEvent: options.addEvent,
    getEvents: options.getEvents,
  });
  await app.register(mutationRoutes, {
    authStore: options.authStore,
    secureCookieSetting: options.secureCookieSetting,
    service: options.mutationService,
  });

  return app;
}
