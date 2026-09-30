import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { AuthStore } from "../auth.js";
import type { StateDatabase } from "../database.js";
import { requestSessionToken, sessionCookie } from "./auth-routes.js";

interface AuditRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
  database: StateDatabase;
}

function jsonReply(reply: FastifyReply, status: number, payload: unknown, headers: Record<string, string> = {}): FastifyReply {
  return reply.code(status).headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  }).send(payload);
}

async function requireAuthentication(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuditRoutesOptions,
): Promise<FastifyReply | undefined> {
  if (await options.authStore.isAuthenticated(requestSessionToken(request))) return undefined;
  return jsonReply(reply, 401, { error: "请先登录", code: "AUTH_REQUIRED" }, {
    "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
  });
}

export const auditRoutes: FastifyPluginAsync<AuditRoutesOptions> = async (app, options) => {
  app.get<{ Querystring: { limit?: string } }>("/api/audit/events", async (request, reply) => {
    const unauthenticated = await requireAuthentication(request, reply, options);
    if (unauthenticated) return unauthenticated;
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return jsonReply(reply, 400, { error: "limit 必须是 1 到 1000 之间的整数", code: "INVALID_LIMIT" });
    }
    return jsonReply(reply, 200, { events: await options.database.listAuditEvents(limit) });
  });
};

