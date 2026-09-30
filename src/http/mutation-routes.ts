import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { PolicyCollection } from "../../packages/contracts/src/inventory.js";
import type { MutationResult, MutationService } from "../application-contracts.js";
import type { AuthStore } from "../auth.js";
import { requestSessionToken, sessionCookie } from "./auth-routes.js";
import type { AgentBatchUpgradeInput, AgentBroker } from "../agent-broker.js";
import { buildAgentUpgradeParams } from "../agent-release.js";
import { redactPayload } from "../inventory-redaction.js";

interface MutationRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
  service: MutationService;
  agentBroker: AgentBroker;
  agentPublicUrl?: string;
  agentBinaryPath?: string;
  appVersion?: string;
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
  }).send(redactPayload(result.payload));
}

function validId(value: string): string {
  if (!RESOURCE_ID_RE.test(value)) throw routeError(404, "接口不存在");
  return value;
}

function validScriptDeliveryToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) throw routeError(404, "准备脚本不存在或已过期");
  return value;
}

function policyCollection(value: string): PolicyCollection {
  if (value === "defines" || value === "functions" || value === "filters") return value;
  throw routeError(404, "接口不存在");
}

export const mutationRoutes: FastifyPluginAsync<MutationRoutesOptions> = async (app, options) => {
  const upgradeParams = async (nodeId: string): Promise<Record<string, unknown>> => {
    if (!options.agentPublicUrl || !options.agentBinaryPath || !options.appVersion) throw routeError(503, "Agent 发布包尚未配置", "AGENT_RELEASE_MISSING");
    const status = options.agentBroker.status(nodeId);
    if (!status?.connected) throw routeError(409, "Agent 当前未连接，无法下发升级任务", "AGENT_OFFLINE");
    return buildAgentUpgradeParams({ architecture: status.architecture, publicUrl: options.agentPublicUrl, binaryBase: options.agentBinaryPath, version: options.appVersion });
  };
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" && request.url.startsWith("/api/nodes/setup-script/")) return;
    if (await options.authStore.isAuthenticated(requestSessionToken(request))) return;
    return reply.code(401).headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
    }).send({ error: "请先登录", code: "AUTH_REQUIRED" });
  });

  app.get<{ Params: { deliveryToken: string } }>("/api/nodes/setup-script/:deliveryToken", async (request, reply) => {
    const script = await options.service.getNodeSetupScript(validScriptDeliveryToken(request.params.deliveryToken));
    return reply.code(200).headers({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "content-disposition": "inline; filename=birdbox-node-setup.sh",
      "x-content-type-options": "nosniff",
    }).send(script);
  });
  app.post("/api/nodes/setup-script", async (request, reply) => jsonReply(reply, await options.service.createNodeSetupScript(jsonBody(request))));
  app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/agent-upgrade-script", async (request, reply) => jsonReply(reply, await options.service.createNodeAgentUpgradeScript(validId(request.params.nodeId))));
  app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/promote-agent", async (request, reply) => jsonReply(reply, await options.service.promoteNodeToAgent(validId(request.params.nodeId))));
  app.post("/api/nodes/test", async (request, reply) => jsonReply(reply, await options.service.testNode(jsonBody(request))));
  app.post("/api/nodes", async (request, reply) => jsonReply(reply, await options.service.createNode(jsonBody(request))));
  app.put<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => jsonReply(reply, await options.service.updateNode(validId(request.params.nodeId), jsonBody(request))));
  app.delete<{ Params: { nodeId: string }; Querystring: { force?: string } }>("/api/nodes/:nodeId", async (request, reply) => jsonReply(reply, await options.service.deleteNode(validId(request.params.nodeId), request.query.force === "true")));
  app.get("/api/agent/status", async (_request, reply) => reply.header("cache-control", "no-store").send({ agents: options.agentBroker.statuses() }));
  app.get("/api/agent/upgrades/batch", async (_request, reply) => reply.header("cache-control", "no-store").send({ job: options.agentBroker.batchUpgradeStatus() }));
  app.post("/api/agent/upgrades/batch", async (request, reply) => {
    const body = jsonBody(request);
    const raw = body.nodes;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
      throw routeError(400, "请选择 1 至 100 个 Agent 节点", "INVALID_BATCH_UPGRADE_NODES");
    }
    const seen = new Set<string>();
    const inputs: AgentBatchUpgradeInput[] = [];
    for (const value of raw) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw routeError(400, "批量升级节点参数不合法", "INVALID_BATCH_UPGRADE_NODE");
      const record = value as Record<string, unknown>;
      const nodeId = validId(String(record.nodeId ?? ""));
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (record.params !== undefined && (typeof record.params !== "object" || record.params === null || Array.isArray(record.params))) throw routeError(400, "批量升级参数不合法", "INVALID_BATCH_UPGRADE_PARAMS");
      const status = options.agentBroker.status(nodeId);
      inputs.push({ nodeId, params: status?.connected ? await upgradeParams(nodeId) : {} });
    }
    if (!inputs.length) throw routeError(400, "请选择至少一个不同的 Agent 节点", "INVALID_BATCH_UPGRADE_NODES");
    try {
      return reply.code(202).send({ job: options.agentBroker.startBatchUpgrade(inputs) });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "BATCH_UPGRADE_RUNNING") throw routeError(409, "已有 Agent 批量升级任务正在执行，请等待完成", code);
      throw error;
    }
  });
  app.post<{ Params: { nodeId: string } }>("/api/agent/nodes/:nodeId/upgrade", async (request, reply) => {
    const nodeId = validId(request.params.nodeId);
    if (!options.agentBroker.status(nodeId)?.connected) {
      throw routeError(409, "Agent 当前未连接，无法下发升级任务", "AGENT_OFFLINE");
    }
    jsonBody(request);
    if (!options.agentBroker.beginSingleUpgrade()) {
      throw routeError(409, "已有 Agent 升级任务正在执行，请等待完成", "AGENT_UPGRADE_RUNNING");
    }
    try {
      const result = await options.agentBroker.dispatch(nodeId, "agent.self_upgrade", await upgradeParams(nodeId), 10 * 60 * 1000);
      return reply.code(result.ok ? 200 : 502).send(result);
    } finally {
      options.agentBroker.endSingleUpgrade();
    }
  });

  app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/peers", async (request, reply) => jsonReply(reply, await options.service.createPeer(validId(request.params.nodeId), jsonBody(request))));
  app.put<{ Params: { peerId: string } }>("/api/peers/:peerId", async (request, reply) => jsonReply(reply, await options.service.updatePeer(validId(request.params.peerId), jsonBody(request))));
  app.delete<{ Params: { peerId: string } }>("/api/peers/:peerId", async (request, reply) => jsonReply(reply, await options.service.deletePeer(validId(request.params.peerId))));

  app.post("/api/statics", async (request, reply) => jsonReply(reply, await options.service.createStatic(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/statics/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateStatic(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/statics/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteStatic(validId(request.params.resourceId))));
  app.post("/api/directs", async (request, reply) => jsonReply(reply, await options.service.createDirect(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/directs/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateDirect(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/directs/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteDirect(validId(request.params.resourceId))));
  app.post("/api/kernels", async (request, reply) => jsonReply(reply, await options.service.createKernel(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/kernels/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateKernel(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/kernels/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteKernel(validId(request.params.resourceId))));

  app.post("/api/rpki", async (request, reply) => jsonReply(reply, await options.service.createRpki(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/rpki/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateRpki(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/rpki/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteRpki(validId(request.params.resourceId))));

  app.get<{ Params: { resourceId: string }; Querystring: { nodeId?: string } }>("/api/source-policies/:resourceId/plan", async (request, reply) => jsonReply(reply, await options.service.getSourcePolicyPlan(validId(request.params.resourceId), typeof request.query.nodeId === "string" ? request.query.nodeId : null)));
  app.post("/api/source-policies/preview", async (request, reply) => jsonReply(reply, await options.service.previewSourcePolicy(jsonBody(request))));
  app.post("/api/source-policies", async (request, reply) => jsonReply(reply, await options.service.createSourcePolicy(jsonBody(request))));
  app.put<{ Params: { resourceId: string } }>("/api/source-policies/:resourceId", async (request, reply) => jsonReply(reply, await options.service.updateSourcePolicy(validId(request.params.resourceId), jsonBody(request))));
  app.delete<{ Params: { resourceId: string } }>("/api/source-policies/:resourceId", async (request, reply) => jsonReply(reply, await options.service.deleteSourcePolicy(validId(request.params.resourceId))));

  app.post<{ Params: { collection: string } }>("/api/:collection(defines|functions|filters)", async (request, reply) => jsonReply(reply, await options.service.createPolicy(policyCollection(request.params.collection), jsonBody(request))));
  app.post("/api/defines/irr/resolve", async (request, reply) => jsonReply(reply, await options.service.resolveIrrDefine(jsonBody(request))));
  app.post<{ Params: { resourceId: string } }>("/api/defines/:resourceId/sync", async (request, reply) => jsonReply(reply, await options.service.syncIrrDefine(validId(request.params.resourceId))));
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

  app.get("/api/ibgp-domains", async (_request, reply) => jsonReply(reply, await options.service.listIbgpDomains()));
  app.post("/api/ibgp-domains/preview", async (request, reply) => jsonReply(reply, await options.service.previewIbgpDomain(jsonBody(request))));
  app.post("/api/ibgp-domains", async (request, reply) => jsonReply(reply, await options.service.createIbgpDomain(jsonBody(request))));
  app.put<{ Params: { domainId: string } }>("/api/ibgp-domains/:domainId", async (request, reply) => jsonReply(reply, await options.service.updateIbgpDomain(validId(request.params.domainId), jsonBody(request))));
  app.delete<{ Params: { domainId: string } }>("/api/ibgp-domains/:domainId", async (request, reply) => jsonReply(reply, await options.service.deleteIbgpDomain(validId(request.params.domainId))));
  app.patch<{ Params: { domainId: string } }>("/api/ibgp-domains/:domainId/layout", async (request, reply) => jsonReply(reply, await options.service.updateIbgpDomainLayout(validId(request.params.domainId), jsonBody(request))));

  app.get("/api/ospf", async (_request, reply) => jsonReply(reply, await options.service.listOspfDomains()));
  app.patch("/api/ospf/layout", async (request, reply) => jsonReply(reply, await options.service.updateOspfLayout(jsonBody(request))));
  app.post("/api/ospf/preview", async (request, reply) => jsonReply(reply, await options.service.previewOspfDomain(jsonBody(request))));
  app.post("/api/ospf", async (request, reply) => jsonReply(reply, await options.service.createOspfDomain(jsonBody(request))));
  app.put<{ Params: { domainId: string } }>("/api/ospf/:domainId", async (request, reply) => jsonReply(reply, await options.service.updateOspfDomain(validId(request.params.domainId), jsonBody(request))));
  app.delete<{ Params: { domainId: string } }>("/api/ospf/:domainId", async (request, reply) => jsonReply(reply, await options.service.deleteOspfDomain(validId(request.params.domainId))));
  app.patch<{ Params: { domainId: string } }>("/api/ospf/:domainId/layout", async (request, reply) => jsonReply(reply, await options.service.updateOspfDomainLayout(validId(request.params.domainId), jsonBody(request))));
};
