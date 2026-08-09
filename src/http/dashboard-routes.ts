import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { DashboardResponse } from "../../packages/contracts/src/api.js";
import type { AuthStore } from "../auth.js";
import { requestSessionToken, sessionCookie } from "./auth-routes.js";

interface DashboardRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
  ping(): Promise<unknown>;
  isDeploymentLocked(): boolean;
  loadDashboard(nodeId: string | null, peerId: string | null): Promise<DashboardResponse>;
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
  options: DashboardRoutesOptions,
): Promise<FastifyReply | undefined> {
  if (await options.authStore.isAuthenticated(requestSessionToken(request))) return undefined;
  return jsonReply(reply, 401, { error: "请先登录", code: "AUTH_REQUIRED" }, {
    "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
  });
}

export const dashboardRoutes: FastifyPluginAsync<DashboardRoutesOptions> = async (app, options) => {
  app.get("/api/health", async (_request, reply) => {
    await options.ping();
    return jsonReply(reply, 200, { status: "ok", deploymentLocked: options.isDeploymentLocked() });
  });

  const dashboardHandler = async (
    request: FastifyRequest<{ Querystring: { nodeId?: string; peerId?: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const unauthenticated = await requireAuthentication(request, reply, options);
    if (unauthenticated) return unauthenticated;
    const nodeId = typeof request.query.nodeId === "string" && request.query.nodeId ? request.query.nodeId : null;
    const peerId = typeof request.query.peerId === "string" && request.query.peerId ? request.query.peerId : null;
    return jsonReply(reply, 200, await options.loadDashboard(nodeId, peerId));
  };

  app.get<{ Querystring: { nodeId?: string; peerId?: string } }>("/api/dashboard", dashboardHandler);
  app.get<{ Querystring: { nodeId?: string; peerId?: string } }>("/api/session", dashboardHandler);
};
