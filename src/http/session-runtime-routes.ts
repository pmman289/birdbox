import { inspectRoaTable, parseRpkiRuntime } from "../bird-rpki-runtime.js";
import type { RpkiRuntimeResponse } from "../../packages/contracts/src/api.js";
import { parseStaticRuntime } from "../bird-static-runtime.js";
import { inspectSourcePolicyRuntime } from "../bird-source-policy-runtime.js";
import { sourcePolicyNames, sourcePolicyForNode } from "../bird-source-policy.js";
import { parseSystemProtocolRuntime } from "../bird-system-runtime.js";
import { knownPipeTables } from "../bird-pipe.js";
import { parsePipeRuntime } from "../bird-pipe-runtime.js";
import { resourceAppliesToNode } from "../../packages/contracts/src/resource-scope.js";
import type { PipeRuntimeResponse, SystemProtocolRuntimeResponse } from "../../packages/contracts/src/api.js";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { ChangeEvent, DashboardRuntimeResponse, ProtocolDetailsResponse, RouteDetailsResponse, RoutePathResponse } from "../../packages/contracts/src/api.js";
import type { Inventory, ManagedNode } from "../../packages/contracts/src/inventory.js";
import type { AuthStore } from "../auth.js";
import { executeNodeCommand, executeNodeRpc, inspectNode, inspectOspfRuntime, inspectProtocolDetails, inspectProtocolRoutes, inspectRoutePath, setProtocolState, type OspfRuntimeResult } from "../bird.js";
import { ospfDomainNodeIds, ospfProtocolName } from "../ospf.js";
import { configForNode } from "../inventory-domain.js";
import { redactPayload } from "../inventory-redaction.js";
import type { InventoryStore } from "../store.js";
import { requestSessionToken, sessionCookie } from "./auth-routes.js";

interface SessionRuntimeRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
  store: InventoryStore;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result, options?: { allowPendingJournal?: boolean; waitForActive?: boolean }): Promise<Result>;
  withNodeOperationLock<Result>(nodeId: string, operation: () => Promise<Result> | Result): Promise<Result>;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
  /** Injectable for bounded runtime checks and route-level fault tests. */
  inspectOspfRuntime?: typeof inspectOspfRuntime;
  ospfRuntimeTimeoutMs?: number;
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
  }).send(redactPayload(payload));
}

function findNode(state: Inventory, nodeId: string): ManagedNode {
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) throw routeError(404, "受管节点不存在");
  return node;
}

const OSPF_RUNTIME_NODE_TIMEOUT_MS = 12_000;

function emptyOspfRuntime(error: string): OspfRuntimeResult {
  return {
    reachable: false,
    error,
    v2: { state: null, neighbors: 0, routes: null },
    v3: { state: null, neighbors: 0, routes: null },
    neighbors: [],
    routes: [],
    routesTruncated: false,
    interfaces: [],
  };
}

async function inspectOspfRuntimeBounded(
  node: ManagedNode,
  protocolNames: { v2: string; v3: string },
  timeoutMs = OSPF_RUNTIME_NODE_TIMEOUT_MS,
  inspector: typeof inspectOspfRuntime = inspectOspfRuntime,
): Promise<OspfRuntimeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => inspector(node, protocolNames, timeoutMs)).catch((error: unknown) => emptyOspfRuntime(
        error instanceof Error ? error.message : "节点 OSPF 运行态检查失败",
      )),
      new Promise<OspfRuntimeResult>((resolve) => {
        timer = setTimeout(() => resolve(emptyOspfRuntime("节点 OSPF 运行态检查超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const sessionRuntimeRoutes: FastifyPluginAsync<SessionRuntimeRoutesOptions> = async (app, options) => {
  app.addHook("onRequest", async (request, reply) => {
    if (await options.authStore.isAuthenticated(requestSessionToken(request))) return;
    return jsonReply(reply, 401, { error: "请先登录", code: "AUTH_REQUIRED" }, {
      "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
    });
  });

  app.get<{ Params: { resourceId: string } }>("/api/source-policies/:resourceId/runtime", async (request, reply) => {
    const state = await options.store.read(), resource = state.sourcePolicies.find(item => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "源地址出口映射不存在");
    return jsonReply(reply, 200, await inspectSourcePolicyRuntime(state, resource));
  });
  app.get<{ Params: { resourceId: string }; Querystring: { nodeId?: string; groupId?: string; target?: string } }>("/api/source-policies/:resourceId/routes", async (request, reply) => {
    const state = await options.store.read(), resource = state.sourcePolicies.find(item => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "源地址出口映射不存在");
    const node = findNode(state, String(request.query.nodeId ?? ""));
    if (!resourceAppliesToNode(resource, node.id)) throw routeError(400, "此节点不在源地址出口映射的作用域内");
    const group = resource.groups.find(item => item.id === request.query.groupId);
    if (!group) throw routeError(400, "出口组不存在");
    const names = sourcePolicyNames(resource, group), base = { resourceId: resource.id, nodeId: node.id, family: "ipv4", table: names.table };
    if (!resource.enabled || !sourcePolicyForNode(resource, node)?.groups.some(item => item.id === group.id)) return jsonReply(reply, 200, { ...base, routes: [], truncated: false, limit: 200 });
    const result = await inspectProtocolRoutes(node, names.staticProtocol, "ipv4", "import", { table: names.table, tableOnly: true, target: request.query.target, limit: 200 });
    if (!result.ok) throw routeError(502, result.error ?? "源地址出口 BIRD 路由查询失败");
    return jsonReply(reply, 200, { ...base, routes: result.routes, truncated: result.truncated, limit: 200 });
  });

  app.get<{ Params: { resourceId: string } }>("/api/rpki/:resourceId/runtime", async (request, reply) => {
    const state = await options.store.read();
    const resource = state.rpki.find(item => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "RPKI 资源不存在");
    const instances = resource.sourceType === "server" ? [resource.name] : [resource.roa4Table ? `${resource.name}_v4` : null, resource.roa6Table ? `${resource.name}_v6` : null].filter((name): name is string => name !== null);
    const nodes: RpkiRuntimeResponse["nodes"] = await Promise.all(state.nodes.filter(node => resourceAppliesToNode(resource, node.id)).map(async node => ({
      nodeId: node.id, lastCheckedAt: new Date().toISOString(), protocols: await Promise.all(instances.map(async name => {
        const base = { name, channels: [], rtrState: null, raw: "", error: null };
        if (!resource.enabled) return { ...base, state: "disabled" as const };
        try {
          const result = await inspectProtocolDetails(node, name);
          if (!result.ok && !/no protocols? match(?:es)?|no such protocol/i.test(`${result.error} ${result.output}`)) throw new Error(result.error ?? "无法读取 RPKI 状态");
          return { ...base, ...parseRpkiRuntime(result.output, name, resource.sourceType === "server" ? "RPKI" : "Static"), raw: result.output };
        } catch (error) { return { ...base, state: "error" as const, error: error instanceof Error ? error.message : "节点检查失败" }; }
      })),
    })));
    return jsonReply(reply, 200, { resourceId: resource.id, nodes });
  });
  app.get<{ Params: { resourceId: string }; Querystring: { nodeId?: string; family?: string } }>("/api/rpki/:resourceId/roas", async (request, reply) => {
    const state = await options.store.read();
    const resource = state.rpki.find(item => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "RPKI 资源不存在");
    const node = findNode(state, String(request.query.nodeId ?? ""));
    if (!resourceAppliesToNode(resource, node.id)) throw routeError(400, "该节点不在 RPKI 作用域内");
    const family = request.query.family;
    if (family !== "ipv4" && family !== "ipv6") throw routeError(400, "请选择合法地址族");
    const table = family === "ipv4" ? resource.roa4Table : resource.roa6Table;
    if (!table) throw routeError(400, "此 RPKI 未启用该地址族");
    const base = { resourceId: resource.id, nodeId: node.id, family, table };
    if (!resource.enabled) return jsonReply(reply, 200, { ...base, entries: [], truncated: false, limit: 200 });
    try { return jsonReply(reply, 200, { ...base, ...await inspectRoaTable(node, table, family) }); }
    catch (error) { throw routeError(502, error instanceof Error ? error.message : "ROA 查询失败"); }
  });

  for (const kind of ["directs", "kernels"] as const) {
    app.get<{ Params: { resourceId: string } }>(`/api/${kind}/:resourceId/runtime`, async (request, reply) => {
      const state = await options.store.read();
      const resource = (kind === "directs" ? state.directProtocols : state.kernelProtocols).find(item => item.id === request.params.resourceId);
      if (!resource) throw routeError(404, "协议资源不存在");
      const families = [...(resource.ipv4 ? ["ipv4" as const] : []), ...(resource.ipv6 ? ["ipv6" as const] : [])];
      const names = kind === "directs" ? [{ name: resource.name, family: families.length === 2 ? "dual" as const : families[0]! }]
        : families.map(family => ({ name: families.length === 2 ? `${resource.name}${family === "ipv4" ? "4" : "6"}` : resource.name, family }));
      const nodes: SystemProtocolRuntimeResponse["nodes"] = await Promise.all(state.nodes.filter(node => resourceAppliesToNode(resource, node.id)).map(async node => ({
        nodeId: node.id, lastCheckedAt: new Date().toISOString(), protocols: await Promise.all(names.map(async instance => {
          const base = { ...instance, imported: null, exported: null, error: null, raw: "" };
          if (!resource.enabled) return { ...base, state: "disabled" as const };
          try {
            const result = await inspectProtocolDetails(node, instance.name);
            if (!result.ok && !/no protocols? match(?:es)?|no such protocol/i.test(`${result.error} ${result.output}`)) throw new Error(result.error ?? "无法读取协议状态");
            return { ...base, ...parseSystemProtocolRuntime(result.output, instance.name, kind === "directs" ? "Direct" : "Kernel"), raw: result.output };
          } catch (error) { return { ...base, state: "error" as const, error: error instanceof Error ? error.message : "节点检查失败" }; }
        })),
      })));
      return jsonReply(reply, 200, { resourceId: resource.id, nodes });
    });
    app.get<{ Params: { resourceId: string }; Querystring: { nodeId?: string; family?: string; direction?: string; target?: string } }>(`/api/${kind}/:resourceId/routes`, async (request, reply) => {
      const state = await options.store.read();
      const resource = (kind === "directs" ? state.directProtocols : state.kernelProtocols).find(item => item.id === request.params.resourceId);
      if (!resource) throw routeError(404, "协议资源不存在");
      const node = findNode(state, String(request.query.nodeId ?? ""));
      if (!resourceAppliesToNode(resource, node.id)) throw routeError(400, "该节点不在资源作用域内");
      const family = request.query.family;
      if ((family !== "ipv4" && family !== "ipv6") || !resource[family]) throw routeError(400, "请选择已启用的地址族");
      const direction = request.query.direction ?? "import";
      if ((direction !== "import" && direction !== "export") || (kind === "directs" && direction !== "import")) throw routeError(400, "查询方向不合法");
      const name = kind === "kernels" && resource.ipv4 && resource.ipv6 ? `${resource.name}${family === "ipv4" ? "4" : "6"}` : resource.name;
      const table = "tables" in resource ? resource.tables?.[family]?.name ?? (family === "ipv4" ? "master4" : "master6") : family === "ipv4" ? "master4" : "master6";
      if (!resource.enabled) return jsonReply(reply, 200, { resourceId: resource.id, nodeId: node.id, family, table, routes: [], truncated: false, limit: 200 });
      const result = await inspectProtocolRoutes(node, name, family, direction, { table, target: request.query.target });
      if (!result.ok) throw routeError(502, result.error ?? "无法读取协议路由");
      return jsonReply(reply, 200, { resourceId: resource.id, nodeId: node.id, family, table, routes: result.routes, truncated: result.truncated, limit: result.limit });
    });
  }

  app.get<{ Params: { resourceId: string } }>("/api/statics/:resourceId/runtime", async (request, reply) => {
    const state = await options.store.read();
    const resource = state.staticProtocols.find(item => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "Static 资源不存在");
    const node = findNode(state, resource.nodeId);
    const base = { resourceId: resource.id, nodeId: node.id, lastCheckedAt: new Date().toISOString(), table: resource.table?.name ?? (resource.family === "ipv4" ? "master4" : "master6"), imported: null, exported: null, error: null, raw: "" };
    if (!resource.enabled) return jsonReply(reply, 200, { ...base, state: "disabled" });
    try {
      const result = await inspectProtocolDetails(node, resource.name);
      if (!result.ok && !/no protocols? match(?:es)?|no such protocol/i.test(`${result.error} ${result.output}`)) throw new Error(result.error ?? "无法读取 Static 状态");
      return jsonReply(reply, 200, { ...base, ...parseStaticRuntime(result.output, resource.name), raw: result.output });
    } catch (error) {
      return jsonReply(reply, 200, { ...base, state: "error", error: error instanceof Error ? error.message : "节点检查失败" });
    }
  });

  app.get<{ Params: { resourceId: string }; Querystring: { target?: string } }>("/api/statics/:resourceId/routes", async (request, reply) => {
    const state = await options.store.read();
    const resource = state.staticProtocols.find(item => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "Static 资源不存在");
    const node = findNode(state, resource.nodeId);
    const table = resource.table?.name ?? (resource.family === "ipv4" ? "master4" : "master6");
    if (!resource.enabled) return jsonReply(reply, 200, { resourceId: resource.id, nodeId: node.id, family: resource.family, table, routes: [], truncated: false, limit: 200 });
    const result = await inspectProtocolRoutes(node, resource.name, resource.family, "import", { table, target: request.query.target });
    if (!result.ok) throw routeError(502, result.error || "无法读取 Static 路由");
    return jsonReply(reply, 200, { resourceId: resource.id, nodeId: node.id, family: resource.family, table, routes: result.routes, truncated: result.truncated, limit: result.limit });
  });

  app.get("/api/pipes/tables", async (_request, reply) => jsonReply(reply, 200, { tables: knownPipeTables(await options.store.read()) }));

  app.get<{ Params: { resourceId: string } }>("/api/pipes/:resourceId/runtime", async (request, reply) => {
    const state = await options.store.read();
    const resource = state.pipeProtocols.find((item) => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "Pipe 资源不存在");
    const nodes = await Promise.all(state.nodes.filter((node) => resourceAppliesToNode(resource, node.id)).map(async (node): Promise<PipeRuntimeResponse["nodes"][number]> => {
      const empty = { table: null, state: null, imported: null, exported: null };
      if (!resource.enabled) return { nodeId: node.id, lastCheckedAt: new Date().toISOString(), ok: true, state: "disabled", primary: { ...empty }, peer: { ...empty }, error: null, raw: "" };
      try {
        const result = await inspectProtocolDetails(node, resource.name);
        if (!result.ok && !/no protocols? match(?:es)?|no such protocol/i.test(`${result.error} ${result.output}`)) throw new Error(result.error ?? "无法读取 Pipe 状态");
        return { nodeId: node.id, lastCheckedAt: new Date().toISOString(), ok: true, ...parsePipeRuntime(result.output, resource.name), error: null, raw: result.output };
      } catch (error) {
        return { nodeId: node.id, lastCheckedAt: new Date().toISOString(), ok: false, state: "error", primary: { ...empty }, peer: { ...empty }, error: error instanceof Error ? error.message : "节点查询失败", raw: "" };
      }
    }));
    return jsonReply(reply, 200, { resourceId: resource.id, lastCheckedAt: new Date().toISOString(), nodes });
  });

  app.get<{ Params: { resourceId: string }; Querystring: { nodeId?: string; side?: string; target?: string } }>("/api/pipes/:resourceId/routes", async (request, reply) => {
    const state = await options.store.read();
    const resource = state.pipeProtocols.find((item) => item.id === request.params.resourceId);
    if (!resource) throw routeError(404, "Pipe 资源不存在");
    const node = findNode(state, String(request.query.nodeId ?? ""));
    if (!resourceAppliesToNode(resource, node.id)) throw routeError(400, "该节点不在 Pipe 的作用域内");
    const side = request.query.side;
    if (side !== "primary" && side !== "peer") throw routeError(400, "路由表侧必须是 primary 或 peer");
    const table = side === "primary" ? resource.table.name : resource.peerTable.name;
    const result = await inspectProtocolRoutes(node, resource.name, resource.family, "import", { table, tableOnly: true, target: request.query.target });
    if (!result.ok) throw routeError(502, result.error || "无法读取 Pipe 路由表");
    return jsonReply(reply, 200, { resourceId: resource.id, nodeId: node.id, family: resource.family, side, table, routes: result.routes, truncated: result.truncated, limit: result.limit });
  });

  app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/runtime", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.nodeId)) throw routeError(404, "接口不存在");
    const state = await options.store.read();
    const node = findNode(state, request.params.nodeId);
    const payload: DashboardRuntimeResponse = {
      nodeId: node.id,
      runtime: await inspectNode(node),
      sessions: state.sessions.filter((session) => session.nodeId === node.id),
      config: configForNode(state, node),
      events: options.getEvents(),
    };
    return jsonReply(reply, 200, payload);
  });

  app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/interfaces", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.nodeId)) throw routeError(404, "接口不存在");
    const state = await options.store.read();
    const node = findNode(state, request.params.nodeId);
    const result = node.transport === "agent"
      ? await executeNodeRpc(node, "system.interfaces", {}, 15_000)
      : await executeNodeCommand(
        node,
        "interfaces_raw=$(ip -o link show 2>/dev/null); interfaces_status=$?; [ \"$interfaces_status\" -eq 0 ] || exit \"$interfaces_status\"; printf '%s\\n' \"$interfaces_raw\" | sed -n 's/^[0-9]*: \\([^:@]*\\).*$/\\1/p'",
        { timeout: 10_000 },
      );
    if (!result.ok) throw routeError(502, result.stderr || "无法读取节点接口");
    const interfaces = result.stdout.split(/\r?\n/).map((item: string) => item.trim())
      .filter((item: string) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item));
    return jsonReply(reply, 200, { nodeId: node.id, interfaces: [...new Set(interfaces)] });
  });

  app.get<{
    Params: { nodeId: string };
    Querystring: { target?: string };
  }>("/api/nodes/:nodeId/route-path", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.nodeId)) throw routeError(404, "接口不存在");
    const state = await options.store.read();
    const node = findNode(state, request.params.nodeId);
    const target = String(request.query.target ?? "").trim();
    if (!target) throw routeError(400, "目标 IP 地址不能为空");
    const result = await inspectRoutePath(node, target);
    const payload: RoutePathResponse = {
      node: { id: node.id, name: node.name },
      target: result.target,
      family: result.family,
      table: result.table,
      reachable: result.reachable,
      error: result.error,
      routes: result.routes,
      truncated: result.truncated,
      limit: result.limit,
    };
    return jsonReply(reply, 200, payload);
  });

  app.get<{ Params: { domainId: string } }>("/api/ospf/:domainId/runtime", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.domainId)) throw routeError(404, "接口不存在");
    const state = await options.store.read();
    const domain = state.ospfDomains.find((item) => item.id === request.params.domainId);
    if (!domain) throw routeError(404, "OSPF 域不存在");
    const protocolNames = { v2: ospfProtocolName(domain, "ospfv2"), v3: ospfProtocolName(domain, "ospfv3") };
    const nodeIds = ospfDomainNodeIds(domain);
    const results = await Promise.all(nodeIds.map(async (nodeId) => {
      let node: ManagedNode;
      try {
        node = findNode(state, nodeId);
      } catch (error) {
        return {
          nodeId,
          name: nodeId,
          runtime: emptyOspfRuntime(error instanceof Error ? error.message : "受管节点不存在"),
        };
      }
      return { nodeId, name: node.name, runtime: await inspectOspfRuntimeBounded(node, protocolNames, options.ospfRuntimeTimeoutMs ?? OSPF_RUNTIME_NODE_TIMEOUT_MS, options.inspectOspfRuntime) };
    }));
    return jsonReply(reply, 200, { domainId: domain.id, lastCheckedAt: new Date().toISOString(), nodes: results });
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { family?: string; direction?: string; page?: string; pageSize?: string };
  }>("/api/sessions/:sessionId/routes", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.sessionId)) throw routeError(404, "接口不存在");
    const family = String(request.query.family ?? "").toLowerCase();
    const direction = String(request.query.direction ?? "").toLowerCase();
    if (family !== "ipv4" && family !== "ipv6") throw routeError(400, "路由地址族必须是 ipv4 或 ipv6");
    if (direction !== "import" && direction !== "export") throw routeError(400, "路由方向必须是 import 或 export");
    const page = request.query.page === undefined ? 1 : Number(request.query.page);
    const pageSize = request.query.pageSize === undefined ? 200 : Number(request.query.pageSize);
    if (!Number.isSafeInteger(page) || page < 1 || page > 5_000) throw routeError(400, "路由页码必须是 1 到 5000 之间的整数");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw routeError(400, "每页路由数量必须是 1 到 200 之间的整数");
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset) || offset > 1_000_000) throw routeError(400, "路由页码超出可查询范围");
    const state = await options.store.read();
    const session = state.sessions.find((item) => item.id === request.params.sessionId);
    if (!session) throw routeError(404, "会话不存在");
    if (!session.enabled) throw routeError(409, "会话配置已停用，无法读取路由明细");
    const channel = session.channels[family];
    if (!channel.enabled) throw routeError(409, `会话未启用 ${family === "ipv4" ? "IPv4" : "IPv6"} Channel`);
    const node = findNode(state, session.nodeId);
    const result = await inspectProtocolRoutes(node, session.protocolName, family, direction, { table: channel.table, limit: pageSize, offset });
    if (!result.ok) throw routeError(502, result.error || "无法读取 BIRD 路由明细");
    const payload: RouteDetailsResponse = {
      session: { id: session.id, protocolName: session.protocolName },
      family,
      direction,
      table: result.table ?? channel.table ?? (family === "ipv4" ? "master4" : "master6"),
      routes: result.routes,
      truncated: result.truncated,
      limit: result.limit,
      page,
      pageSize,
    };
    return jsonReply(reply, 200, payload);
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/protocol", async (request, reply) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.params.sessionId)) throw routeError(404, "接口不存在");
    const state = await options.store.read();
    const session = state.sessions.find((item) => item.id === request.params.sessionId);
    if (!session) throw routeError(404, "会话不存在");
    if (!session.enabled) return jsonReply(reply, 200, {
      session: { id: session.id, protocolName: session.protocolName },
      ok: true, output: "配置已停用；不会生成或加载此 BGP 协议。", error: null,
    } satisfies ProtocolDetailsResponse);
    const node = findNode(state, session.nodeId);
    const result = await inspectProtocolDetails(node, session.protocolName);
    const payload: ProtocolDetailsResponse = {
      session: { id: session.id, protocolName: session.protocolName },
      ok: result.ok,
      output: result.output,
      error: result.error,
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
    const stateForLock = await options.store.read();
    const sessionForLock = stateForLock.sessions.find((item) => item.id === request.params.sessionId);
    if (!sessionForLock) throw routeError(404, "会话不存在");
    const control = await options.withNodeOperationLock(sessionForLock.nodeId, async () => {
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
