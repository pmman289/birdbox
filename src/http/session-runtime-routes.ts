import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { ChangeEvent, RouteDetailsResponse } from "../../packages/contracts/src/api.js";
import type { Inventory, ManagedNode } from "../../packages/contracts/src/inventory.js";
import type { AuthStore } from "../auth.js";
import { inspectProtocolRoutes, setProtocolState } from "../bird.js";
import type { InventoryStore } from "../store.js";
import { requestSessionToken, sessionCookie } from "./auth-routes.js";

interface SessionRuntimeRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
  store: InventoryStore;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
}

interface RouteError extends Error {
  status?: number;
  code?: string;
}

type JsonObject = Record<string, unknown>;

function routeError(status: number, message: string, code?: string): RouteError {
  const error = new Error(message) as RouteError;
  error.status = status;
  if (code) error.code = code;
  return error;
}

function jsonBody(request: FastifyRequest): JsonObject {
  const value = request.body === undefined ? {} : request.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError(400, "JSON 请求体必须是合法对象", "INVALID_JSON_BODY");
  }
  return value as JsonObject;
}

function jsonReply(reply: FastifyReply, status: number, payload: unknown, headers: Record<string, string> = {}): FastifyReply {
  return reply.code(status).headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  }).send(payload);
}

function findNode(state: Inventory, nodeId: string): ManagedNode {
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) throw routeError(404, "受管节点不存在");
  return node;
}

export const sessionRuntimeRoutes: FastifyPluginAsync<SessionRuntimeRoutesOptions> = async (app, options) => {
  app.addHook("onRequest", async (request, reply) => {
    if (await options.authStore.isAuthenticated(requestSessionToken(request))) return;
    return jsonReply(reply, 401, { error: "请先登录", code: "AUTH_REQUIRED" }, {
      "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
    });
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { family?: string; direction?: string };
  }>("/api/sessions/:sessionId/routes", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.sessionId)) throw routeError(404, "接口不存在");
    const family = String(request.query.family ?? "").toLowerCase();
    const direction = String(request.query.direction ?? "").toLowerCase();
    if (family !== "ipv4" && family !== "ipv6") throw routeError(400, "路由地址族必须是 ipv4 或 ipv6");
    if (direction !== "import" && direction !== "export") throw routeError(400, "路由方向必须是 import 或 export");
    const state = await options.store.read();
    const session = state.sessions.find((item) => item.id === request.params.sessionId);
    if (!session) throw routeError(404, "会话不存在");
    if (!session.enabled) throw routeError(409, "会话配置已停用，无法读取路由明细");
    const channel = session.channels[family];
    if (!channel.enabled) throw routeError(409, `会话未启用 ${family === "ipv4" ? "IPv4" : "IPv6"} Channel`);
    const node = findNode(state, session.nodeId);
    const result = await inspectProtocolRoutes(node, session.protocolName, family, direction, { table: channel.table });
    if (!result.ok) throw routeError(502, result.error || "无法读取 BIRD 路由明细");
    const payload: RouteDetailsResponse = {
      session: { id: session.id, protocolName: session.protocolName },
      family,
      direction,
      table: result.table ?? channel.table ?? (family === "ipv4" ? "master4" : "master6"),
      routes: result.routes,
      truncated: result.truncated,
      limit: result.limit,
    };
    return jsonReply(reply, 200, payload);
  });

  app.post<{
    Params: { sessionId: string };
    Body: unknown;
  }>("/api/sessions/:sessionId/control", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.sessionId)) throw routeError(404, "接口不存在");
    const action = String(jsonBody(request).action ?? "").trim().toLowerCase();
    if (action !== "enable" && action !== "disable") throw routeError(400, "BGP 协议动作只能是 enable 或 disable");
    const control = await options.withDeploymentLock(async () => {
      const state = await options.store.read();
      const session = state.sessions.find((item) => item.id === request.params.sessionId);
      if (!session) throw routeError(404, "会话不存在");
      if (!session.enabled) throw routeError(409, "会话配置已停用，请先应用启用会话");
      const node = findNode(state, session.nodeId);
      const result = await setProtocolState(node, session.protocolName, action === "enable");
      if (!result.ok) throw routeError(502, result.stderr || result.stdout || `无法${action === "enable" ? "启动" : "停止"} BGP 协议`);
      options.addEvent("success", `${node.name} 的 BGP 协议 ${session.protocolName} 已${action === "enable" ? "启动" : "停止"}`, node.id);
      return {
        sessionId: session.id,
        nodeId: node.id,
        protocolName: session.protocolName,
        action,
        enabled: action === "enable",
        result,
        events: options.getEvents(),
      };
    });
    return jsonReply(reply, 200, control);
  });
};
