import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { PolicyCollection } from "../../packages/contracts/src/inventory.js";
import type { MutationResult, MutationService } from "../application-contracts.js";
import type { AuthStore } from "../auth.js";
import { requestSessionToken, sessionCookie } from "./auth-routes.js";

interface MutationRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
  service: MutationService;
}

interface RouteError extends Error {
  status?: number;
  code?: string;
}

const RESOURCE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function routeError(status: number, message: string, code?: string): RouteError {
  const error = new Error(message) as RouteError;
  error.status = status;
  if (code) error.code = code;
  return error;
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const value = request.body === undefined ? {} : request.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError(400, "JSON 请求体必须是合法对象", "INVALID_JSON_BODY");
  }
  return value as Record<string, unknown>;
}

function jsonReply(reply: FastifyReply, result: MutationResult): FastifyReply {
  return reply.code(result.status).headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }).send(result.payload);
}

function validId(value: string): string {
  if (!RESOURCE_ID_RE.test(value)) throw routeError(404, "接口不存在");
  return value;
}

function policyCollection(value: string): PolicyCollection {
  if (value === "defines" || value === "functions" || value === "filters") return value;
  throw routeError(404, "接口不存在");
}

export const mutationRoutes: FastifyPluginAsync<MutationRoutesOptions> = async (app, options) => {
  app.addHook("onRequest", async (request, reply) => {
    if (await options.authStore.isAuthenticated(requestSessionToken(request))) return;
    return reply.code(401).headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
    }).send({ error: "请先登录", code: "AUTH_REQUIRED" });
  });

  app.post("/api/nodes/setup-script", async (request, reply) => jsonReply(reply, await options.service.createNodeSetupScript(jsonBody(request))));
  app.post("/api/nodes/test", async (request, reply) => jsonReply(reply, await options.service.testNode(jsonBody(request))));
  app.post("/api/nodes", async (request, reply) => jsonReply(reply, await options.service.createNode(jsonBody(request))));
  app.put<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => jsonReply(reply, await options.service.updateNode(validId(request.params.nodeId), jsonBody(request))));
  app.delete<{ Params: { nodeId: string }; Querystring: { force?: string } }>("/api/nodes/:nodeId", async (request, reply) => jsonReply(reply, await options.service.deleteNode(validId(request.params.nodeId), request.query.force === "true")));

  app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/peers", async (request, reply) => jsonReply(reply, await options.service.createPeer(validId(request.params.nodeId), jsonBody(request))));
  app.put<{ Params: { peerId: string } }>("/api/peers/:peerId", async (request, reply) => jsonReply(reply, await options.service.updatePeer(validId(request.params.peerId), jsonBody(request))));
  app.delete<{ Params: { peerId: string } }>("/api/peers/:peerId", async (request, reply) => jsonReply(reply, await options.service.deletePeer(validId(request.params.peerId))));

  app.post("/api/statics", async (request, reply) => jsonReply(reply, await options.service.createStatic(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/statics/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateStatic(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/statics/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteStatic(validId(request.params.resourceId))));

  app.post("/api/rpki", async (request, reply) => jsonReply(reply, await options.service.createRpki(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/rpki/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateRpki(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/rpki/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteRpki(validId(request.params.resourceId))));

  app.post<{ Params: { collection: string } }>("/api/:collection(defines|functions|filters)", async (request, reply) => jsonReply(reply, await options.service.createPolicy(policyCollection(request.params.collection), jsonBody(request))));
  app.post<{ Params: { collection: string; resourceId: string } }>("/api/:collection(defines|functions)/:resourceId/move", async (request, reply) => {
    const body = jsonBody(request);
    const direction = String(body.direction ?? "");
    if (direction !== "up" && direction !== "down") throw routeError(400, "资源移动方向不合法");
    const collection = request.params.collection;
    if (collection !== "defines" && collection !== "functions") throw routeError(404, "接口不存在");
    return jsonReply(reply, await options.service.movePolicy(collection, validId(request.params.resourceId), direction));
  });
  app.put<{ Params: { collection: string; resourceId: string } }>("/api/:collection(defines|functions|filters)/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updatePolicy(policyCollection(request.params.collection), validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { collection: string; resourceId: string } }>("/api/:collection(defines|functions|filters)/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deletePolicy(policyCollection(request.params.collection), validId(request.params.resourceId))));

  app.post("/api/sessions/preview", async (request, reply) => jsonReply(reply, await options.service.previewSession(jsonBody(request))));
  app.post("/api/sessions/apply", async (request, reply) => jsonReply(reply, await options.service.applySession(jsonBody(request))));
  app.delete<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => jsonReply(reply, await options.service.deleteSession(validId(request.params.sessionId))));
};
