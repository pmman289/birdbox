import type { ChangeEvent } from "../packages/contracts/src/api.js";
import type {
  Inventory,
  ManagedNode,
  PolicyCollection,
} from "../packages/contracts/src/inventory.js";
import type { MutationService } from "./application-contracts.js";
import {
  normalizeNode,
  normalizePeer,
  normalizeRPKI,
  normalizeStaticProtocol,
  stageAndValidate,
  validateInventory,
} from "./bird.js";
import type { DeploymentService } from "./deployment-service.js";
import { fail } from "./errors.js";
import {
  configForNode,
  findNode,
  findPeer,
  findPolicyResource,
  normalizePolicyResource,
  policyResources,
  resourceReferencesSymbol,
  staticValidationError,
} from "./inventory-domain.js";
import type { NodeOnboardingService } from "./node-onboarding-service.js";
import { resourceChangeNodeIds, resourceNodeIds, uniqueNodeIds } from "./resource-impact.js";
import type { SessionApplicationService } from "./session-application-service.js";
import type { InventoryStore } from "./store.js";

interface ResourceApplicationServiceOptions {
  store: InventoryStore;
  deploymentService: DeploymentService;
  nodeOnboarding: NodeOnboardingService;
  sessions: SessionApplicationService;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  makeId(prefix: string): string;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
}

export function createResourceApplicationService(
  options: ResourceApplicationServiceOptions,
): MutationService {
  const store = options.store;
  const events = options.getEvents();
  const makeId = options.makeId;
  const event = options.addEvent;
  const withDeploymentLock = options.withDeploymentLock;
  const mutateAndApply = options.deploymentService.mutateAndApply.bind(options.deploymentService);

  async function preflightPolicyResource(
    stateInput: Inventory,
    collection: PolicyCollection,
    resourceId: string,
  ): Promise<void> {
    const probe = structuredClone(stateInput);
    const resource = findPolicyResource(probe, collection, resourceId);
    resource.enabled = true;
    const state = validateInventory(probe);
    const nodes = resource.nodeId === null ? state.nodes : [findNode(state, resource.nodeId)];
    for (const node of nodes) {
      const validation = await stageAndValidate(node, configForNode(state, node));
      if (!validation.ok) fail(422, validation.stderr || `${resource.name} 的 BIRD 语法检查失败`);
    }
  }

  async function preflightRPKIResource(stateInput: Inventory, resourceId: string): Promise<void> {
    const probe = structuredClone(stateInput);
    const resource = probe.rpki.find((item) => item.id === resourceId);
    if (!resource) fail(404, "RPKI 资源不存在");
    resource.enabled = true;
    const state = validateInventory(probe);
    const nodes = resource.nodeId === null ? state.nodes : [findNode(state, resource.nodeId)];
    for (const node of nodes) {
      const validation = await stageAndValidate(node, configForNode(state, node));
      if (!validation.ok) fail(422, validation.stderr || `${resource.name} 的 BIRD 语法检查失败`);
    }
  }

  async function preflightStaticProtocol(stateInput: Inventory, resourceId: string): Promise<void> {
    const probe = structuredClone(stateInput);
    const resource = probe.staticProtocols.find((item) => item.id === resourceId);
    if (!resource) fail(404, "Static 资源不存在");
    resource.enabled = true;
    const state = validateInventory(probe);
    const node = findNode(state, resource.nodeId);
    const config = configForNode(state, node);
    const validation = await stageAndValidate(node, config);
    if (!validation.ok) {
      fail(
        422,
        staticValidationError(
          config,
          validation.stderr || validation.stdout,
          `${resource.name} 的 BIRD 语法检查失败`,
        ),
      );
    }
  }

  return {
    createNodeSetupScript: (body) => options.nodeOnboarding.createSetupScript(body),
    testNode: (body) => options.nodeOnboarding.test(body),
    createNode: (body) => options.nodeOnboarding.create(body),

  async updateNode(nodeId, body) {
    const { state, result: node, deployment } = await mutateAndApply((draft) => {
      const index = draft.nodes.findIndex((item) => item.id === nodeId);
      if (index < 0) fail(404, "受管节点不存在");
      const previous = draft.nodes[index];
      if (!previous) fail(404, "受管节点不存在");
      const updated = normalizeNode({ ...previous, ...body, id: nodeId });
      const immutableDeploymentFields: Array<keyof ManagedNode> = [
        "transport", "sshHost", "sshPort", "sshUser", "sshIdentity", "deploymentMode",
        "mainConfigPath", "generatedConfigPath", "socketPath",
      ];
      if (immutableDeploymentFields.some((field) => updated[field] !== previous[field])) {
        fail(409, "节点的 SSH 目标、部署模式和配置路径不可直接修改；请先删除节点并重新添加");
      }
      draft.nodes[index] = updated;
      return updated;
    }, () => [nodeId]);
    event("success", `已更新受管节点 ${node.name}`, node.id);
    return { status: 200, payload: { node, inventory: state, deployment, events } };
  },

  async deleteNode(nodeId, force) {
    const { state, node, forced } = await options.nodeOnboarding.decommission(nodeId, force);
    event(forced ? "warning" : "success", forced
      ? `已强制遗忘受管节点 ${node.name}；远端配置和控制器公钥仍需手动清理`
      : `已清理远端配置并删除受管节点 ${node.name}`, nodeId);
    return {
      status: 200,
      payload: {
        inventory: state,
        cleanupRequired: forced,
        deployment: { applied: !forced, nodeIds: [node.id], nodes: [{ id: node.id, name: node.name }], sessions: [] },
        events,
      },
    };
  },

  async createPeer(nodeId, body) {
    const peer = normalizePeer({ ...body, id: makeId("peer"), nodeId });
    const { state } = await withDeploymentLock(() => store.mutate((draft) => {
      findNode(draft, nodeId);
      draft.peers.push(peer);
    }));
    event("success", `已添加外部 Peer ${peer.name}`, nodeId);
    return { status: 201, payload: { peer, inventory: state, events } };
  },

  async updatePeer(peerId, body) {
    const { state, result: peer, deployment } = await mutateAndApply((draft) => {
      const index = draft.peers.findIndex((item) => item.id === peerId);
      if (index < 0) fail(404, "远端 Peer 不存在");
      const previous = draft.peers[index];
      if (!previous) fail(404, "远端 Peer 不存在");
      const updated = normalizePeer({ ...previous, ...body, id: peerId, nodeId: previous.nodeId });
      draft.peers[index] = updated;
      return updated;
    }, (updated) => [updated.nodeId]);
    event("success", `已更新外部 Peer ${peer.name}`, peer.nodeId);
    return { status: 200, payload: { peer, inventory: state, deployment, events } };
  },

  async deletePeer(peerId) {
    const { state, result: peer } = await withDeploymentLock(() => store.mutate((draft) => {
      const target = findPeer(draft, peerId);
      if (draft.sessions.some((item) => item.peerId === target.id)) fail(409, "请先移除该 Peer 的会话");
      draft.peers = draft.peers.filter((item) => item.id !== target.id);
      return target;
    }));
    if (!peer) fail(500, "删除 Peer 后未返回资源");
    event("success", `已删除外部 Peer ${peer.name}`, peer.nodeId);
    return { status: 200, payload: { inventory: state, events } };
  },

  async createStatic(body) {
    const resource = normalizeStaticProtocol({ ...body, id: makeId("static") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      findNode(draft, resource.nodeId);
      draft.staticProtocols.push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightStaticProtocol(candidate, resource.id);
      return resource;
    }, () => [resource.nodeId]);
    event("success", `已添加 Static 资源 ${resource.name}`, resource.nodeId);
    return {
      status: 201,
      payload: { resource: state.staticProtocols.find((item) => item.id === resource.id), inventory: state, deployment, events },
    };
  },

  async updateStatic(resourceId, body) {
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft.staticProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Static 资源不存在");
      const previous = draft.staticProtocols[index];
      if (!previous) fail(404, "Static 资源不存在");
      const nodeId = previous.nodeId;
      if (Object.hasOwn(body, "nodeId") && body.nodeId !== previous.nodeId) {
        fail(409, "Static 资源不可直接移动到其他节点；请删除后重新添加");
      }
      const staticInput = { ...previous, ...body, id: resourceId, nodeId };
      if (Object.hasOwn(body, "action") && !Object.hasOwn(body, "routeActions") && body.action !== null && body.action !== "") {
        staticInput.routeActions = Object.fromEntries(
          Object.keys(previous.routeActions).map((prefix) => [prefix, String(body.action)]),
        );
      }
      const updated = normalizeStaticProtocol(staticInput);
      draft.staticProtocols[index] = updated;
      const candidate = validateInventory(draft);
      if (!updated.enabled) await preflightStaticProtocol(candidate, resourceId);
      return updated;
    }, (updated) => [updated.nodeId]);
    event("success", `已更新 Static 资源 ${resource.name}`, resource.nodeId);
    return {
      status: 200,
      payload: { resource: state.staticProtocols.find((item) => item.id === resource.id), inventory: state, deployment, events },
    };
  },

  async deleteStatic(resourceId) {
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.staticProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Static 资源不存在");
      const target = draft.staticProtocols[index];
      if (!target) fail(404, "Static 资源不存在");
      draft.staticProtocols.splice(index, 1);
      return target;
    }, (deleted) => [deleted.nodeId]);
    event("success", `已删除 Static 资源 ${resource.name}`, resource.nodeId);
    return { status: 200, payload: { inventory: state, deployment, events } };
  },

  async createRpki(body) {
    const resource = normalizeRPKI({ ...body, id: makeId("rpki") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      draft.rpki.push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightRPKIResource(candidate, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 RPKI 资源 ${resource.name}`, resource.nodeId);
    return { status: 201, payload: { resource, inventory: state, deployment, events } };
  },

  async updateRpki(resourceId, body) {
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft.rpki.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      const previous = draft.rpki[index];
      if (!previous) fail(404, "RPKI 资源不存在");
      const nodeId = Object.hasOwn(body, "nodeId")
        ? (body.nodeId === null || body.nodeId === "" ? null : String(body.nodeId))
        : previous.nodeId;
      if (nodeId !== null) findNode(draft, nodeId);
      const updated = normalizeRPKI({ ...previous, ...body, id: resourceId, nodeId });
      for (const symbol of [previous.name, previous.roa4Table, previous.roa6Table]) {
        if (symbol && symbol !== updated.name && symbol !== updated.roa4Table && symbol !== updated.roa6Table && resourceReferencesSymbol(draft, symbol)) {
          fail(409, `请先更新引用 RPKI 符号 ${symbol} 的策略`);
        }
      }
      draft.rpki[index] = updated;
      affectedNodeIds = resourceChangeNodeIds(draft, previous, updated);
      const candidate = validateInventory(draft);
      if (!updated.enabled) await preflightRPKIResource(candidate, resourceId);
      return updated;
    }, () => affectedNodeIds);
    event("success", `已更新 RPKI 资源 ${resource.name}`, resource.nodeId);
    return { status: 200, payload: { resource, inventory: state, deployment, events } };
  },

  async deleteRpki(resourceId) {
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.rpki.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      const target = draft.rpki[index];
      if (!target) fail(404, "RPKI 资源不存在");
      affectedNodeIds = resourceNodeIds(draft, target);
      for (const symbol of [target.name, target.roa4Table, target.roa6Table]) {
        if (symbol && resourceReferencesSymbol(draft, symbol)) fail(409, `请先更新引用 RPKI 符号 ${symbol} 的策略`);
      }
      draft.rpki.splice(index, 1);
      return target;
    }, () => affectedNodeIds);
    event("success", `已删除 RPKI 资源 ${resource.name}`, resource.nodeId);
    return { status: 200, payload: { inventory: state, deployment, events } };
  },

  async createPolicy(collection, body) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    const idPrefix = collection === "functions" ? "function" : collection === "filters" ? "filter" : "define";
    const resource = normalizePolicyResource(collection, { ...body, id: makeId(idPrefix) });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      policyResources(draft, collection).push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightPolicyResource(candidate, collection, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 ${kind} ${resource.name}`, resource.nodeId);
    return { status: 201, payload: { resource, inventory: state, deployment, events } };
  },

  async movePolicy(collection, resourceId, direction) {
    const kind = collection === "functions" ? "Function" : "Define";
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const resources = policyResources(draft, collection);
      const index = resources.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, `${kind} 不存在`);
      const current = resources[index];
      if (!current) fail(404, `${kind} 不存在`);
      affectedNodeIds = resourceNodeIds(draft, current);
      const targetIndex = index + (direction === "up" ? -1 : 1);
      if (targetIndex < 0 || targetIndex >= resources.length) return current;
      const target = resources[targetIndex];
      if (!target) return current;
      resources[index] = target;
      resources[targetIndex] = current;
      const candidate = validateInventory(draft);
      const moved = policyResources(candidate, collection)[targetIndex];
      if (!moved) fail(404, `${kind} 不存在`);
      if (!moved.enabled) await preflightPolicyResource(candidate, collection, resourceId);
      affectedNodeIds = uniqueNodeIds(affectedNodeIds, resourceNodeIds(draft, current));
      return moved;
    }, () => affectedNodeIds);
    event("success", `已调整 ${kind} ${resource.name} 的声明顺序`, resource.nodeId);
    return { status: 200, payload: { resource, inventory: state, deployment, events } };
  },

  async updatePolicy(collection, resourceId, body) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const resources = policyResources(draft, collection);
      const index = resources.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, `${kind} 不存在`);
      const previous = resources[index];
      if (!previous) fail(404, `${kind} 不存在`);
      const nodeId = Object.hasOwn(body, "nodeId")
        ? (body.nodeId === null || body.nodeId === "" ? null : String(body.nodeId))
        : previous.nodeId;
      if (nodeId !== null) findNode(draft, nodeId);
      const updated = normalizePolicyResource(collection, { ...previous, ...body, id: resourceId, nodeId });
      if (collection === "defines" && updated.name !== previous.name && resourceReferencesSymbol(draft, previous.name, resourceId)) {
        fail(409, `请先更新引用 Define ${previous.name} 的资源`);
      }
      resources[index] = updated;
      affectedNodeIds = resourceChangeNodeIds(draft, previous, updated);
      const candidate = validateInventory(draft);
      if (!updated.enabled) await preflightPolicyResource(candidate, collection, resourceId);
      return updated;
    }, () => affectedNodeIds);
    event("success", `已更新 ${kind} ${resource.name}`, resource.nodeId);
    return { status: 200, payload: { resource, inventory: state, deployment, events } };
  },

  async deletePolicy(collection, resourceId) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const target = findPolicyResource(draft, collection, resourceId);
      affectedNodeIds = resourceNodeIds(draft, target);
      const referencedBySession = draft.sessions.some((session) => {
        const channels = Object.values(session.channels);
        const policies = channels.flatMap((channel) => [channel.importPolicy, channel.exportPolicy]);
        return collection === "functions"
          ? policies.some((policy) => policy.steps.some((step) => step.type === "function" && step.functionId === target.id))
          : collection === "filters"
            ? policies.some((policy) => policy.filterId === target.id)
            : channels.some((channel) => channel.exportDefineId === target.id);
      });
      if (referencedBySession) fail(409, `请先从会话中移除该 ${kind}`);
      if (collection === "defines" && draft.staticProtocols.some((item) => item.defineId === target.id)) {
        fail(409, "请先从 Static 资源中移除该 Define");
      }
      if (collection === "defines" && resourceReferencesSymbol(draft, target.name, target.id)) {
        fail(409, `请先更新引用 Define ${target.name} 的资源`);
      }
      const resources = policyResources(draft, collection);
      const index = resources.findIndex((item) => item.id === target.id);
      if (index >= 0) resources.splice(index, 1);
      return target;
    }, () => affectedNodeIds);
    event("success", `已删除 ${kind} ${resource.name}`, resource.nodeId);
    return { status: 200, payload: { inventory: state, deployment, events } };
  },

    previewSession: (body) => options.sessions.preview(body),
    applySession: (body) => options.sessions.apply(body),
    deleteSession: (sessionId) => options.sessions.delete(sessionId),
  };
}
