import type { ChangeEvent, IbgpPreviewSide, SourcePolicyManualPlan, SourcePolicyRuleInstruction } from "../packages/contracts/src/api.js";
import type {
  BgpSession,
  Inventory,
  IbgpDomain,
  ManagedNode,
  PolicyCollection,
  SourcePolicyEgress,
  OspfDomain,
  DirectProtocol,
  KernelProtocol,
} from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import { resourceSingleNodeId } from "../packages/contracts/src/resource-scope.js";
import type { MutationService } from "./application-contracts.js";
import {
  normalizeNode,
  normalizePeer,
  normalizeRPKI,
  normalizeStaticProtocol,
  prepareSourcePolicyEgress,
  renderSourcePolicyEgress,
  sourcePolicyGatewayConflicts,
  sourcePolicyManagedRules,
  sourcePolicyManagedRulesForNode,
  sourcePolicyForNode,
  sourcePolicyRules,
  sourcePolicyManualPlan,
  stageAndValidate,
  validateInventory,
  executeNodeRpc,
} from "./bird.js";
import { normalizeDirectProtocol, normalizeKernelProtocol } from "./bird-system-protocols.js";
import { normalizeSession } from "./bird-session.js";
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
import { resolveIrrAsSet, type IrrResolveRequest } from "./irr-as-set.js";
import type { NodeOnboardingService } from "./node-onboarding-service.js";
import { resourceChangeNodeIds, resourceNodeIds, uniqueNodeIds } from "./resource-impact.js";
import { expandIbgpDomain, normalizeIbgpDomain } from "./ibgp-domain.js";
import { normalizeOspfDomain, ospfDomainNodeIds } from "./ospf.js";
import type { SessionApplicationService } from "./session-application-service.js";
import type { InventoryStore } from "./store.js";
import { logger } from "./logger.js";
import { restoreSecretPlaceholders } from "./inventory-redaction.js";

interface ResourceApplicationServiceOptions {
  store: InventoryStore;
  deploymentService: DeploymentService;
  nodeOnboarding: NodeOnboardingService;
  sessions: SessionApplicationService;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result, options?: { allowPendingJournal?: boolean; waitForActive?: boolean }): Promise<Result>;
  makeId(prefix: string): string;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
}

export function createResourceApplicationService(
  options: ResourceApplicationServiceOptions,
): MutationService {
  const store = options.store;
  const events = (): ChangeEvent[] => options.getEvents();
  const makeId = options.makeId;
  const event = (level: string, message: unknown, nodeId?: string | null): ChangeEvent => {
    logger.info("记录资源变更", {
      level,
      nodeId: nodeId ?? null,
      message: String(message ?? "").slice(0, 500),
    });
    return options.addEvent(level, message, nodeId);
  };
  const withDeploymentLock = options.withDeploymentLock;
  const mutateAndApply = options.deploymentService.mutateAndApply.bind(options.deploymentService);

  function irrRequest(body: Record<string, unknown>): IrrResolveRequest {
    const entrySource = body.entrySource && typeof body.entrySource === "object" && !Array.isArray(body.entrySource)
      ? body.entrySource as Record<string, unknown>
      : body;
    return {
      family: String(body.type) === "cidr6" || Number(body.family) === 6 ? 6 : 4,
      asSet: String(entrySource.asSet ?? ""),
      server: String(entrySource.server ?? "rr.ntt.net"),
      databases: Array.isArray(entrySource.databases) ? entrySource.databases.map(String) : String(entrySource.databases ?? "").split(","),
      prefixLimit: Number(entrySource.prefixLimit ?? 10_000),
      allowMoreSpecific: entrySource.allowMoreSpecific === true,
    };
  }

  function sourceSignature(source: unknown): string {
    return JSON.stringify(source);
  }

  async function materializeIrrBody(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = body.entrySource && typeof body.entrySource === "object" && !Array.isArray(body.entrySource)
      ? body.entrySource as Record<string, unknown>
      : null;
    if (source?.kind !== "irr-as-set") return body;
    const result = await resolveIrrAsSet(irrRequest(body));
    const now = new Date();
    const interval = Number(source.refreshIntervalSeconds ?? 86400);
    return {
      ...body,
      entries: result.entries,
      sync: {
        status: "ready",
        lastAttemptAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        nextRefreshAt: new Date(now.getTime() + interval * 1000).toISOString(),
        error: null,
        contentHash: result.contentHash,
      },
    };
  }

  function domainNodeIds(domain: IbgpDomain): string[] {
    return uniqueNodeIds(domain.members.map((member) => member.nodeId));
  }

  // Legacy domains kept a member snapshot. Expose newly managed nodes in the
  // workspace without creating sessions or mutating persisted state.
  function domainWithCurrentNodes(domain: IbgpDomain, nodes: readonly ManagedNode[]): IbgpDomain {
    const members = [...domain.members];
    const known = new Set(members.map((member) => member.nodeId));
    for (const node of nodes) {
      if (known.has(node.id)) continue;
      // normalizeIbgpDomain requires a valid address. For a node without an
      // explicit IGP address, use its existing router ID as a display-only
      // fallback; the user can replace it before saving an adjacency.
      members.push({ nodeId: node.id, address: node.igpAddress ?? node.routerId });
      known.add(node.id);
    }
    return members.length === domain.members.length
      ? domain
      : normalizeIbgpDomain({ ...domain, members });
  }

  function assertDomainUnique(state: Inventory, id: string, name: string, excludedId: string | null = null): void {
    if (state.ibgpDomains.some((item) => item.id !== excludedId && item.id === id)) fail(409, "iBGP 域 ID 已存在");
    if (state.ibgpDomains.some((item) => item.id !== excludedId && item.name === name)) fail(409, "iBGP 域名称已存在");
  }

  function materializeDomain(input: Record<string, unknown>, previous: IbgpDomain | null = null): IbgpDomain {
    const restoredInput = previous ? restoreSecretPlaceholders(input, previous) : input;
    const base = { ...(previous ?? {}), ...restoredInput } as Record<string, unknown>;
    const members = Array.isArray(base.members) ? base.members : previous?.members ?? [];
    const requested = Array.isArray(base.adjacencies) ? base.adjacencies : [];
    const seed = normalizeIbgpDomain({
      ...base,
      id: previous?.id ?? base.id ?? makeId("ibgp"),
      members,
      adjacencies: [],
    });
    const previousByPair = new Map((previous?.adjacencies ?? []).map((adjacency) => [
      `${adjacency.leftNodeId}:${adjacency.rightNodeId}`,
      adjacency,
    ]));
    const pairs = requested;
    const adjacencies = pairs.map((value, index) => {
      const pair = value as Record<string, unknown>;
      const leftNodeId = String(pair.leftNodeId ?? "");
      const rightNodeId = String(pair.rightNodeId ?? "");
      const old = previousByPair.get(`${leftNodeId}:${rightNodeId}`) ?? previousByPair.get(`${rightNodeId}:${leftNodeId}`);
      const rawId = old?.id ?? pair.id ?? makeId("ibgp_adj");
      const id = String(rawId || `${seed.id}_adj_${index + 1}`);
      return {
        id,
        leftNodeId,
        rightNodeId,
        enabled: pair.enabled !== false,
        leftSessionId: String(pair.leftSessionId ?? old?.leftSessionId ?? `${id}_left`),
        rightSessionId: String(pair.rightSessionId ?? old?.rightSessionId ?? `${id}_right`),
      };
    });
    return normalizeIbgpDomain({ ...seed, adjacencies });
  }

  function sessionUpdates(body: Record<string, unknown>, existing: BgpSession[]): BgpSession[] {
    const updates = Array.isArray(body.sessionUpdates) ? body.sessionUpdates : [];
    const byId = new Map(existing.map((session) => [session.id, session]));
    for (const value of updates) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const id = String(item.id ?? "");
      const previous = byId.get(id);
      if (previous) {
        byId.set(id, normalizeSession(restoreSecretPlaceholders({
          ...previous,
          ...item,
          id,
          nodeId: previous.nodeId,
          peerId: previous.peerId,
          localAsn: previous.localAsn,
          sessionType: "ibgp",
          managedBy: previous.managedBy,
        }, previous)));
      }
    }
    return [...byId.values()];
  }

  function expandDomainWithUpdates(
    domain: IbgpDomain,
    nodes: ManagedNode[],
    body: Record<string, unknown>,
    existing: BgpSession[] = [],
  ) {
    const initial = expandIbgpDomain(domain, nodes, existing);
    return expandIbgpDomain(domain, nodes, sessionUpdates(body, initial.sessions));
  }

  function materializeOspf(input: Record<string, unknown>, previous: OspfDomain | null = null): OspfDomain {
    const restoredInput = previous ? restoreSecretPlaceholders(input, previous) : input;
    return normalizeOspfDomain({ ...(previous ?? {}), ...restoredInput, id: previous?.id ?? input.id ?? makeId("ospf") });
  }

  function stripUnknownOspfLayout(domain: OspfDomain): OspfDomain {
    const nodeIds = new Set(domain.nodeConfigs.map((config) => config.nodeId));
    domain.layout = Object.fromEntries(
      Object.entries(domain.layout).filter(([nodeId]) => nodeIds.has(nodeId)),
    );
    return domain;
  }

  async function ospfCandidate(body: Record<string, unknown>) {
    const current = await store.read();
    const id = body.id === undefined || body.id === "" ? makeId("ospf") : String(body.id);
    const previous = current.ospfDomains.find((item) => item.id === id) ?? null;
    const domain = stripUnknownOspfLayout(materializeOspf({ ...body, id }, previous));
    const candidate = structuredClone(current);
    const index = candidate.ospfDomains.findIndex((item) => item.id === id);
    if (index >= 0) candidate.ospfDomains[index] = domain;
    else candidate.ospfDomains.push(domain);
    const inventory = validateInventory(candidate);
    // Removing a member also deploys a configuration to that former member.
    // Include it in preview/preflight so the preview covers the entire write.
    const affected = uniqueNodeIds(previous ? ospfDomainNodeIds(previous) : [], ospfDomainNodeIds(domain));
    return { domain, inventory, affected };
  }

  function bgpProtocolBlock(config: string, protocolName: string): string {
    const marker = `protocol bgp ${protocolName} {`;
    const start = config.indexOf(marker);
    if (start < 0) return "";
    let depth = 0;
    let opened = false;
    for (let index = start; index < config.length; index += 1) {
      const character = config[index];
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") {
        depth -= 1;
        if (opened && depth === 0) return config.slice(start, index + 1);
      }
    }
    return config.slice(start);
  }

  async function preflightPolicyResource(
    stateInput: Inventory,
    collection: PolicyCollection,
    resourceId: string,
  ): Promise<void> {
    const probe = structuredClone(stateInput);
    const resource = findPolicyResource(probe, collection, resourceId);
    resource.enabled = true;
    const state = validateInventory(probe);
    const nodes = resourceNodeIds(state, resource).map((nodeId) => findNode(state, nodeId));
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
    const nodes = resourceNodeIds(state, resource).map((nodeId) => findNode(state, nodeId));
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

  async function preflightSourcePolicy(stateInput: Inventory, resourceId: string): Promise<void> {
    const probe = structuredClone(stateInput);
    const resource = probe.sourcePolicies.find((item) => item.id === resourceId);
    if (!resource) fail(404, "源地址出口映射不存在");
    resource.enabled = true;
    const state = validateInventory(probe);
    const nodes = resourceNodeIds(state, resource).map((nodeId) => findNode(state, nodeId));
    for (const node of nodes) {
      const validation = await stageAndValidate(node, configForNode(state, node));
      if (!validation.ok) fail(422, validation.stderr || `${resource.label} 的 BIRD 语法检查失败`);
    }
  }

  function sourcePolicyPlans(
    state: Inventory,
    current: SourcePolicyEgress | null,
    previous: SourcePolicyEgress | null,
    operation: SourcePolicyManualPlan["operation"],
  ): SourcePolicyManualPlan[] {
    return state.nodes.filter((node) =>
      (current !== null && resourceAppliesToNode(current, node.id))
      || (previous !== null && resourceAppliesToNode(previous, node.id)),
    ).map((node) => {
      const sourcePolicy = current !== null && current.enabled && resourceAppliesToNode(current, node.id) ? current : null;
      const internalDefineNames = sourcePolicy?.internalDefineIds.map((defineId) => {
        const define = state.defines.find((item) => item.id === defineId);
        if (!define || define.type !== "cidr4") fail(409, `源地址出口映射引用的 Define ${defineId} 不可用`);
        return define.name;
      }) ?? [];
      const nodeManagedRules = sourcePolicyManagedRulesForNode(
        state.sourcePolicies.filter((item) => item.enabled && resourceAppliesToNode(item, node.id)),
        node,
      );
      const nodeScopedSourcePolicy = sourcePolicy ? sourcePolicyForNode(sourcePolicy, node) : null;
      return sourcePolicyManualPlan(
        node,
        current,
        previous,
        operation,
        nodeScopedSourcePolicy ? renderSourcePolicyEgress(nodeScopedSourcePolicy, internalDefineNames) : "",
        nodeManagedRules,
      );
    });
  }

  function assertSourcePolicyAgentScope(state: Inventory, resource: SourcePolicyEgress, previous: SourcePolicyEgress | null): void {
    for (const nodeId of resourceNodeIds(state, resource)) {
      const node = findNode(state, nodeId);
      if (node.transport !== "ssh") continue;
      if (previous && resourceAppliesToNode(previous, node.id)) continue;
      fail(409, `新源地址出口映射不能选择旧 SSH 节点“${node.name}”，请先升级该节点为 Agent`);
    }
  }

  function assertSourcePolicyGatewaySafety(
    state: Inventory,
    resource: SourcePolicyEgress,
    previous: SourcePolicyEgress | null,
  ): void {
    // Existing inventories are intentionally allowed to load and be upgraded.
    // Only a newly introduced gateway/source conflict is rejected, so legacy
    // nodes can still be promoted to Agent and repaired by the exception rule.
    const afterConflicts = new Map<string, ReturnType<typeof sourcePolicyGatewayConflicts>[number]>();
    const beforeResources = previous
      ? state.sourcePolicies.map((item) => item.id === resource.id ? previous : item)
      : state.sourcePolicies.filter((item) => item.id !== resource.id);
    const nodes = resourceNodeIds(state, resource);
    for (const nodeId of nodes) {
      const after = state.sourcePolicies.filter((item) => item.enabled && resourceAppliesToNode(item, nodeId));
      const before = beforeResources.filter((item) => item.enabled && resourceAppliesToNode(item, nodeId));
      for (const conflict of sourcePolicyGatewayConflicts(after)) {
        if (conflict.gatewayResourceId !== resource.id && conflict.sourceResourceId !== resource.id) continue;
        const key = `${nodeId}|${conflict.gatewayResourceId}|${conflict.gatewayGroupId}|${conflict.sourceResourceId}|${conflict.sourceGroupId}|${conflict.source}`;
        afterConflicts.set(key, conflict);
      }
      const beforeKeys = new Set(sourcePolicyGatewayConflicts(before).map((conflict) =>
        `${nodeId}|${conflict.gatewayResourceId}|${conflict.gatewayGroupId}|${conflict.sourceResourceId}|${conflict.sourceGroupId}|${conflict.source}`));
      for (const [key, conflict] of afterConflicts) {
        if (beforeKeys.has(key)) continue;
        fail(400, `出口地址 ${conflict.gateway} 落在源 CIDR ${conflict.source} 内（节点 ${nodeId}），请拆分源 CIDR 或更换出口地址`);
      }
      afterConflicts.clear();
    }
  }

  function sourcePolicyRulesForNode(
    node: ManagedNode,
    inventory: Inventory,
    previous: SourcePolicyEgress | null,
  ): { removeRules: SourcePolicyRuleInstruction[]; rules: SourcePolicyRuleInstruction[] } {
    const active = inventory.sourcePolicies.filter((item) => item.enabled && resourceAppliesToNode(item, node.id));
    const rules = sourcePolicyManagedRulesForNode(active, node);
    const removeRules = previous && previous.enabled && resourceAppliesToNode(previous, node.id)
      ? sourcePolicyManagedRules([previous])
      : [];
    return { removeRules, rules };
  }

  async function applySourcePolicyRules(node: ManagedNode, inventory: Inventory, previous: SourcePolicyEgress | null): Promise<void> {
    if (node.transport !== "agent") return;
    const { removeRules, rules } = sourcePolicyRulesForNode(node, inventory, previous);
    const result = await executeNodeRpc(node, "network.ip_rules", {
      removeRules: removeRules.map(({ priority, source, destination, table, kind }) => ({ priority, source, destination, table, kind })),
      rules: rules.map(({ priority, source, destination, table, kind }) => ({ priority, source, destination, table, kind })),
    }, 60_000);
    if (!result.ok) fail(502, result.stderr || result.stdout || `${node.name} 的 Agent 系统规则下发失败`);
  }

  return {
    createNodeSetupScript: (body) => options.nodeOnboarding.createSetupScript(body),
    getNodeSetupScript: (deliveryToken) => options.nodeOnboarding.getSetupScript(deliveryToken),
    createNodeAgentUpgradeScript: (nodeId) => options.nodeOnboarding.createAgentUpgradeScript(nodeId),
    promoteNodeToAgent: (nodeId) => options.nodeOnboarding.promoteToAgent(nodeId),
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
        "transport", "sshUser", "sshIdentity", "deploymentMode",
        "mainConfigPath", "generatedConfigPath", "socketPath",
      ];
      if (immutableDeploymentFields.some((field) => updated[field] !== previous[field])) {
        fail(409, "节点的管理方式、SSH 用户、部署模式和配置路径不可直接修改；请先删除节点并重新添加");
      }
      draft.nodes[index] = updated;
      return updated;
    }, () => [nodeId]);
    event("success", `已更新受管节点 ${node.name}`, node.id);
    return { status: 200, payload: { node, inventory: state, deployment, events: events() } };
  },

  async deleteNode(nodeId, force) {
    const { state, node, forced } = await options.nodeOnboarding.decommission(nodeId, force);
    event(forced ? "warning" : "success", forced
      ? `已强制删除受管节点 ${node.name}；远端配置和控制器公钥仍需手动清理`
      : `已清理远端配置并删除受管节点 ${node.name}`, nodeId);
    return {
      status: 200,
      payload: {
        inventory: state,
        cleanupRequired: forced,
        deployment: { applied: !forced, nodeIds: [node.id], nodes: [{ id: node.id, name: node.name }], sessions: [] },
        events: events(),
      },
    };
  },

  async createDirect(body) {
    const resource = normalizeDirectProtocol({ ...body, id: makeId("direct") });
    const { state, deployment } = await mutateAndApply((draft) => {
      findNode(draft, resource.nodeId);
      draft.directProtocols.push(resource);
      validateInventory(draft);
      return resource;
    }, () => [resource.nodeId]);
    event("success", `已添加 Direct 资源 ${resource.label}`, resource.nodeId);
    return { status: 201, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async updateDirect(resourceId, body) {
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.directProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Direct 资源不存在");
      const previous = draft.directProtocols[index]!;
      const updated = normalizeDirectProtocol({ ...previous, ...body, id: resourceId });
      affectedNodeIds = uniqueNodeIds([previous.nodeId, updated.nodeId]);
      draft.directProtocols[index] = updated;
      validateInventory(draft);
      return updated;
    }, () => affectedNodeIds);
    event("success", `已更新 Direct 资源 ${resource.label}`, resource.nodeId);
    return { status: 200, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async deleteDirect(resourceId) {
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.directProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Direct 资源不存在");
      const target = draft.directProtocols[index]!;
      draft.directProtocols.splice(index, 1);
      return target;
    }, (target) => [target.nodeId]);
    event("success", `已删除 Direct 资源 ${resource.label}`, resource.nodeId);
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async createKernel(body) {
    const resource = normalizeKernelProtocol({ ...body, id: makeId("kernel") });
    const { state, deployment } = await mutateAndApply((draft) => {
      for (const nodeId of resource.nodeIds ?? draft.nodes.map((node) => node.id)) findNode(draft, nodeId);
      draft.kernelProtocols.push(resource);
      validateInventory(draft);
      return resource;
    }, (_result, inventory) => resource.nodeIds ?? inventory.nodes.map((node) => node.id));
    event("success", `已添加 Kernel 资源 ${resource.label}`);
    return { status: 201, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async updateKernel(resourceId, body) {
    let affected: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.kernelProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Kernel 资源不存在");
      const previous = draft.kernelProtocols[index]!;
      const updated = normalizeKernelProtocol({ ...previous, ...body, id: resourceId });
      for (const nodeId of updated.nodeIds ?? draft.nodes.map((node) => node.id)) findNode(draft, nodeId);
      draft.kernelProtocols[index] = updated;
      affected = uniqueNodeIds([...(previous.nodeIds ?? draft.nodes.map((node) => node.id)), ...(updated.nodeIds ?? draft.nodes.map((node) => node.id))]);
      validateInventory(draft);
      return updated;
    }, () => affected);
    event("success", `已更新 Kernel 资源 ${resource.label}`);
    return { status: 200, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async deleteKernel(resourceId) {
    let affected: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.kernelProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Kernel 资源不存在");
      const target = draft.kernelProtocols[index]!;
      affected = target.nodeIds ?? draft.nodes.map((node) => node.id);
      draft.kernelProtocols.splice(index, 1);
      return target;
    }, () => affected);
    event("success", `已删除 Kernel 资源 ${resource.label}`);
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async createPeer(nodeId, body) {
    const peer = normalizePeer({ ...body, id: makeId("peer"), nodeId, managedBy: undefined });
    const { state } = await withDeploymentLock(() => store.mutate((draft) => {
      findNode(draft, nodeId);
      draft.peers.push(peer);
    }));
    event("success", `已添加外部 Peer ${peer.name}`, nodeId);
    return { status: 201, payload: { peer, inventory: state, events: events() } };
  },

  async updatePeer(peerId, body) {
    const { state, result: peer, deployment } = await mutateAndApply((draft) => {
      const index = draft.peers.findIndex((item) => item.id === peerId);
      if (index < 0) fail(404, "远端 Peer 不存在");
      const previous = draft.peers[index];
      if (!previous) fail(404, "远端 Peer 不存在");
      if (previous.managedBy?.kind === "ibgp-domain") fail(409, "该 Peer 由 iBGP 管理，请在 iBGP 管理中修改");
      const updated = normalizePeer({
        ...previous,
        ...restoreSecretPlaceholders(body, previous),
        id: peerId,
        nodeId: previous.nodeId,
        managedBy: undefined,
      });
      draft.peers[index] = updated;
      return updated;
    }, (updated) => [updated.nodeId]);
    event("success", `已更新外部 Peer ${peer.name}`, peer.nodeId);
    return { status: 200, payload: { peer, inventory: state, deployment, events: events() } };
  },

  async deletePeer(peerId) {
    const { state, result: peer } = await withDeploymentLock(() => store.mutate((draft) => {
      const target = findPeer(draft, peerId);
      if (target.managedBy?.kind === "ibgp-domain") fail(409, "该 Peer 由 iBGP 管理，请在 iBGP 管理中删除邻接");
      if (draft.sessions.some((item) => item.peerId === target.id)) fail(409, "请先移除该 Peer 的会话");
      draft.peers = draft.peers.filter((item) => item.id !== target.id);
      return target;
    }));
    if (!peer) fail(500, "删除 Peer 后未返回资源");
    event("success", `已删除外部 Peer ${peer.name}`, peer.nodeId);
    return { status: 200, payload: { inventory: state, events: events() } };
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
      payload: { resource: state.staticProtocols.find((item) => item.id === resource.id), inventory: state, deployment, events: events() },
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
      payload: { resource: state.staticProtocols.find((item) => item.id === resource.id), inventory: state, deployment, events: events() },
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
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async createRpki(body) {
    const resource = normalizeRPKI({ ...body, id: makeId("rpki") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      draft.rpki.push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightRPKIResource(candidate, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 RPKI 资源 ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 201, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async updateRpki(resourceId, body) {
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft.rpki.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      const previous = draft.rpki[index];
      if (!previous) fail(404, "RPKI 资源不存在");
      const scopeCompatibleBody = Object.hasOwn(body, "nodeId") && !Object.hasOwn(body, "nodeIds")
        ? { ...body, nodeIds: body.nodeId }
        : body;
      const updated = normalizeRPKI({
        ...previous,
        ...restoreSecretPlaceholders(scopeCompatibleBody, previous),
        id: resourceId,
      });
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
    event("success", `已更新 RPKI 资源 ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 200, payload: { resource, inventory: state, deployment, events: events() } };
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
    event("success", `已删除 RPKI 资源 ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async getSourcePolicyPlan(resourceId, nodeId) {
    const state = await store.read();
    const resource = state.sourcePolicies.find((item) => item.id === resourceId);
    if (!resource) fail(404, "源地址出口映射不存在");
    const plans = sourcePolicyPlans(state, resource, resource, "reconcile");
    const plan = nodeId === null ? plans[0] : plans.find((item) => item.nodeId === nodeId);
    if (!plan) fail(404, "该节点不在源地址出口映射的下发范围内");
    return { status: 200, payload: { plan } };
  },

  async previewSourcePolicy(body) {
    const requestedId = body.id === undefined || body.id === null || body.id === "" ? null : String(body.id);
    const state = await store.read();
    const existing = requestedId === null
      ? null
      : state.sourcePolicies.find((item) => item.id === requestedId) ?? null;
    if (requestedId !== null && !existing) fail(404, "源地址出口映射不存在");
    let previewSequence = 0;
    const previewId = existing?.id ?? "source_policy_preview";
    const preview = prepareSourcePolicyEgress(
      { ...body, id: previewId },
      existing,
      state.sourcePolicies,
      (prefix) => prefix + "_preview_" + (++previewSequence),
    );
    const draft = structuredClone(state);
    const existingIndex = draft.sourcePolicies.findIndex((item) => item.id === preview.id);
    if (existingIndex >= 0) draft.sourcePolicies[existingIndex] = preview;
    else draft.sourcePolicies.push(preview);
    const validated = validateInventory(draft);
    const current = validated.sourcePolicies.find((item) => item.id === preview.id);
    if (!current) fail(500, "源地址出口映射预览生成失败");
    assertSourcePolicyAgentScope(validated, current, existing);
    assertSourcePolicyGatewaySafety(validated, current, existing);
    const manualPlans = sourcePolicyPlans(validated, current, existing, existing ? "update" : "create");
    return { status: 200, payload: { resource: current, manualPlans } };
  },

  async createSourcePolicy(body) {
    let current: SourcePolicyEgress | null = null;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const created = prepareSourcePolicyEgress({ ...body, id: makeId("source_policy") }, null, draft.sourcePolicies, makeId);
      assertSourcePolicyAgentScope(draft, created, null);
      draft.sourcePolicies.push(created);
      current = created;
      const candidate = validateInventory(draft);
      assertSourcePolicyGatewaySafety(candidate, created, null);
      if (!created.enabled) await preflightSourcePolicy(candidate, created.id);
      return created;
    }, (created, inventory) => resourceNodeIds(inventory, created), {
      apply: async (node, inventory) => applySourcePolicyRules(node, inventory, null),
      rollback: async (node, inventory) => applySourcePolicyRules(node, inventory, current),
    });
    const applied = state.sourcePolicies.find((item) => item.id === resource.id) ?? resource;
    const manualPlans = sourcePolicyPlans(state, applied, null, "create");
    event("success", `已添加源地址出口映射 ${applied.label}`);
    return { status: 201, payload: { resource: applied, inventory: state, deployment, manualPlans, events: events() } };
  },

  async updateSourcePolicy(resourceId, body) {
    let affectedNodeIds: string[] = [];
    let previous: SourcePolicyEgress | null = null;
    let updatedForSync: SourcePolicyEgress | null = null;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft.sourcePolicies.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "源地址出口映射不存在");
      const existing = draft.sourcePolicies[index];
      if (!existing) fail(404, "源地址出口映射不存在");
      previous = structuredClone(existing);
      const updated = prepareSourcePolicyEgress({ ...body, id: resourceId }, existing, draft.sourcePolicies, makeId);
      assertSourcePolicyAgentScope(draft, updated, existing);
      draft.sourcePolicies[index] = updated;
      updatedForSync = updated;
      affectedNodeIds = resourceChangeNodeIds(draft, existing, updated);
      const candidate = validateInventory(draft);
      assertSourcePolicyGatewaySafety(candidate, updated, previous);
      if (!updated.enabled) await preflightSourcePolicy(candidate, resourceId);
      return updated;
    }, () => affectedNodeIds, {
      apply: async (node, inventory) => applySourcePolicyRules(node, inventory, previous),
      rollback: async (node, inventory) => applySourcePolicyRules(node, inventory, updatedForSync),
    });
    const applied = state.sourcePolicies.find((item) => item.id === resource.id) ?? resource;
    const manualPlans = sourcePolicyPlans(state, applied, previous, "update");
    event("success", `已更新源地址出口映射 ${applied.label}`);
    return { status: 200, payload: { resource: applied, inventory: state, deployment, manualPlans, events: events() } };
  },

  async deleteSourcePolicy(resourceId) {
    let affectedNodeIds: string[] = [];
    let deletedForSync: SourcePolicyEgress | null = null;
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.sourcePolicies.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "源地址出口映射不存在");
      const target = draft.sourcePolicies[index];
      if (!target) fail(404, "源地址出口映射不存在");
      affectedNodeIds = resourceNodeIds(draft, target);
      deletedForSync = target;
      draft.sourcePolicies.splice(index, 1);
      return target;
    }, () => affectedNodeIds, {
      apply: async (node, inventory) => applySourcePolicyRules(node, inventory, deletedForSync),
      rollback: async (node, inventory) => applySourcePolicyRules(node, inventory, null),
    });
    const manualPlans = sourcePolicyPlans(state, null, resource, "delete");
    event("warning", `已删除源地址出口映射 ${resource.label}；请完成待办的系统规则清理`);
    return { status: 200, payload: { inventory: state, deployment, manualPlans, events: events() } };
  },

  async createPolicy(collection, body) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    const idPrefix = collection === "functions" ? "function" : collection === "filters" ? "filter" : "define";
    const materialized = collection === "defines" ? await materializeIrrBody(body) : body;
    const resource = normalizePolicyResource(collection, { ...materialized, id: makeId(idPrefix) });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      policyResources(draft, collection).push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightPolicyResource(candidate, collection, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 ${kind} ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 201, payload: { resource, inventory: state, deployment, events: events() } };
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
    event("success", `已调整 ${kind} ${resource.name} 的声明顺序`, resourceSingleNodeId(resource));
    return { status: 200, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async updatePolicy(collection, resourceId, body) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    let affectedNodeIds: string[] = [];
    const materializedBody = collection === "defines" ? await materializeIrrBody(body) : body;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const resources = policyResources(draft, collection);
      const index = resources.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, `${kind} 不存在`);
      const previous = resources[index];
      if (!previous) fail(404, `${kind} 不存在`);
      const scopeCompatibleBody = Object.hasOwn(materializedBody, "nodeId")
        && !Object.hasOwn(materializedBody, "nodeIds")
        ? { ...materializedBody, nodeIds: materializedBody.nodeId }
        : materializedBody;
      const updated = normalizePolicyResource(collection, { ...previous, ...scopeCompatibleBody, id: resourceId });
      if ((collection === "defines" || collection === "functions") && updated.name !== previous.name && resourceReferencesSymbol(draft, previous.name, resourceId)) {
        fail(409, `请先更新引用 ${kind} ${previous.name} 的资源`);
      }
      resources[index] = updated;
      affectedNodeIds = resourceChangeNodeIds(draft, previous, updated);
      const candidate = validateInventory(draft);
      if (!updated.enabled) await preflightPolicyResource(candidate, collection, resourceId);
      return updated;
    }, () => affectedNodeIds);
    event("success", `已更新 ${kind} ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 200, payload: { resource, inventory: state, deployment, events: events() } };
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
      const referencedByKernel = draft.kernelProtocols.some((kernel) => {
        const exportPolicies = kernel.exportPolicies
          ? Object.values(kernel.exportPolicies).filter((item) => item.mode === "visual").map((item) => item.policy)
          : [kernel.exportPolicy];
        const policies = [kernel.importPolicy, ...exportPolicies];
        return collection === "filters"
          ? policies.some((policy) => policy.filterId === target.id)
          : collection === "functions"
            ? policies.some((policy) => policy.steps.some((step) => step.type === "function" && step.functionId === target.id))
            : false;
      });
      if (referencedByKernel) fail(409, `请先从 Kernel 资源中移除该 ${kind}`);
      const referencedByOspf = draft.ospfDomains.some((domain) => domain.nodeConfigs.some((config) => {
        if (!config.enabled) return false;
        if (collection === "defines") {
          return (["ospfv2", "ospfv3"] as const).some((version) => {
            const policy = config.exportPolicies[version];
            return policy.mode !== "custom" && policy.formAction === "cidr" && config.exportDefineIds[version] === target.id;
          });
        }
        return Object.values(config.importPolicies).concat(Object.values(config.exportPolicies)).some((policy) =>
          collection === "filters"
            ? policy.mode === "custom" && policy.filterId === target.id
            : policy.mode === "combined" && policy.steps.some((step) => step.type === "function" && step.functionId === target.id),
        );
      }));
      if (referencedByOspf) fail(409, `请先从 OSPF 域中移除该 ${kind}`);
      if (collection === "defines" && draft.staticProtocols.some((item) => item.defineId === target.id)) {
        fail(409, "请先从 Static 资源中移除该 Define");
      }
      if ((collection === "defines" || collection === "functions") && resourceReferencesSymbol(draft, target.name, target.id)) {
        fail(409, `请先更新引用 ${kind} ${target.name} 的资源`);
      }
      const resources = policyResources(draft, collection);
      const index = resources.findIndex((item) => item.id === target.id);
      if (index >= 0) resources.splice(index, 1);
      return target;
    }, () => affectedNodeIds);
    event("success", `已删除 ${kind} ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async resolveIrrDefine(body) {
    const result = await resolveIrrAsSet(irrRequest(body));
    return { status: 200, payload: { entries: result.entries, count: result.entries.length, contentHash: result.contentHash } };
  },

  async syncIrrDefine(resourceId) {
    const before = await store.read();
    const define = before.defines.find((item) => item.id === resourceId);
    if (!define || define.type === "expression") fail(404, "CIDR Define 不存在");
    if (define.entrySource.kind !== "irr-as-set") fail(409, "该 Define 不是 AS-SET 自动来源");
    const signature = sourceSignature(define.entrySource);
    let resolved;
    try {
      resolved = await resolveIrrAsSet({
        family: define.type === "cidr4" ? 4 : 6,
        ...define.entrySource,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await mutateAndApply((draft) => {
        const current = draft.defines.find((item) => item.id === resourceId);
        if (!current || current.type === "expression" || current.entrySource.kind !== "irr-as-set") return null;
        const failedAt = new Date();
        current.sync = {
          ...current.sync,
          status: "error",
          lastAttemptAt: failedAt.toISOString(),
          nextRefreshAt: new Date(failedAt.getTime() + current.entrySource.refreshIntervalSeconds * 1000).toISOString(),
          error: message.slice(0, 2048),
        };
        return null;
      }, []);
      event("error", `AS-SET Define ${define.name} 同步失败：${message}`, resourceSingleNodeId(define));
      throw error;
    }
    const now = new Date();
    let changed = false;
    let deployed: Awaited<ReturnType<typeof mutateAndApply>>;
    try {
      deployed = await mutateAndApply((draft) => {
      const current = draft.defines.find((item) => item.id === resourceId);
      if (!current || current.type === "expression" || current.entrySource.kind !== "irr-as-set") fail(409, "Define 在同步期间已被修改");
      if (sourceSignature(current.entrySource) !== signature) fail(409, "AS-SET 来源在同步期间已被修改，请重新同步");
      changed = current.sync.contentHash !== resolved.contentHash;
      current.entries = resolved.entries;
      current.sync = {
        status: "ready",
        lastAttemptAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        nextRefreshAt: new Date(now.getTime() + current.entrySource.refreshIntervalSeconds * 1000).toISOString(),
        error: null,
        contentHash: resolved.contentHash,
      };
      return current;
      }, (_result, inventory) => changed ? resourceNodeIds(inventory, define) : []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as { code?: string }).code !== "DEPLOYMENT_LOCKED") {
        try {
          await mutateAndApply((draft) => {
            const current = draft.defines.find((item) => item.id === resourceId);
            if (!current || current.type === "expression" || current.entrySource.kind !== "irr-as-set") return null;
            const failedAt = new Date();
            const retryMs = Math.min(current.entrySource.refreshIntervalSeconds * 1000, 15 * 60 * 1000);
            current.sync = { ...current.sync, status: "error", lastAttemptAt: failedAt.toISOString(), nextRefreshAt: new Date(failedAt.getTime() + retryMs).toISOString(), error: `部署失败：${message}`.slice(0, 2048) };
            return null;
          }, []);
        } catch (stateError) { logger.error("AS-SET 同步失败状态写入失败", { error: String(stateError) }); }
      }
      event("error", `AS-SET Define ${define.name} 部署失败，继续使用上一版前缀：${message}`, resourceSingleNodeId(define));
      throw error;
    }
    const { state, result: resource, deployment } = deployed;
    if (changed) event("success", `AS-SET Define ${define.name} 已更新为 ${resolved.entries.length} 条前缀`, resourceSingleNodeId(define));
    return { status: 200, payload: { resource, inventory: state, deployment, changed, events: events() } };
  },

  async listIbgpDomains() {
    const state = await store.read();
    const domains = state.ibgpDomains.map((domain) => domainWithCurrentNodes(domain, state.nodes));
    return { status: 200, payload: { domains, inventory: { ...state, ibgpDomains: domains } } };
  },

  async previewIbgpDomain(body) {
    return withDeploymentLock(async () => {
      const current = await store.read();
      const requestedId = body.id === undefined || body.id === "" ? null : String(body.id);
      const previous = requestedId === null ? null : current.ibgpDomains.find((item) => item.id === requestedId) ?? null;
      const domain = materializeDomain({ ...body, ...(previous ? { id: previous.id } : { id: requestedId ?? makeId("ibgp") }) }, previous);
      assertDomainUnique(current, domain.id, domain.name, previous?.id ?? null);
      const oldSessions = previous
        ? current.sessions.filter((session) => session.managedBy?.domainId === domain.id)
        : [];
      const candidate = structuredClone(current);
      const domainIndex = candidate.ibgpDomains.findIndex((item) => item.id === domain.id);
      if (domainIndex >= 0) candidate.ibgpDomains.splice(domainIndex, 1);
      candidate.peers = candidate.peers.filter((peer) => peer.managedBy?.domainId !== domain.id);
      candidate.sessions = candidate.sessions.filter((session) => session.managedBy?.domainId !== domain.id);
      const expanded = expandDomainWithUpdates(domain, candidate.nodes, body, oldSessions);
      candidate.ibgpDomains.push(domain);
      candidate.peers.push(...expanded.peers);
      candidate.sessions.push(...expanded.sessions);
      const inventory = validateInventory(candidate);
      const configs = new Map<string, { config: string; validation: Awaited<ReturnType<typeof stageAndValidate>> }>();
      for (const nodeId of domainNodeIds(domain)) {
        const node = findNode(inventory, nodeId);
        const config = configForNode(inventory, node);
        const validation = await stageAndValidate(node, config);
        configs.set(node.id, { config, validation });
      }
      const sides: IbgpPreviewSide[] = expanded.sessions.map((session) => {
        const node = findNode(inventory, session.nodeId);
        const entry = configs.get(node.id);
        const adjacency = domain.adjacencies.find((item) => item.id === session.managedBy?.adjacencyId);
        const side = adjacency?.leftSessionId === session.id ? "left" : "right";
        return {
          side,
          nodeId: node.id,
          nodeName: node.name,
          session,
          config: bgpProtocolBlock(entry?.config ?? "", session.protocolName),
          validation: entry?.validation ?? { ok: false, stdout: "", stderr: "未执行配置检查", code: "VALIDATION_NOT_RUN" },
        };
      });
      return {
        status: 200,
        payload: {
          valid: [...configs.values()].every((entry) => entry.validation.ok),
          domain,
          sessions: expanded.sessions,
          sides,
        },
      };
    });
  },

  async createIbgpDomain(body) {
    const domain = materializeDomain({ ...body, id: body.id ?? makeId("ibgp") });
    const { state, deployment } = await mutateAndApply((draft) => {
      assertDomainUnique(draft, domain.id, domain.name);
      const expanded = expandDomainWithUpdates(domain, draft.nodes, body);
      draft.ibgpDomains.push(domain);
      draft.peers.push(...expanded.peers);
      draft.sessions.push(...expanded.sessions);
      return domain;
    }, () => domainNodeIds(domain));
    event("success", `已创建 iBGP 域 ${domain.name}`);
    return { status: 201, payload: { domain: state.ibgpDomains.find((item) => item.id === domain.id), inventory: state, deployment, events: events() } };
  },

  async updateIbgpDomain(domainId, body) {
    let affectedNodeIds: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply((draft) => {
      const index = draft.ibgpDomains.findIndex((item) => item.id === domainId);
      if (index < 0) fail(404, "iBGP 域不存在");
      const previous = draft.ibgpDomains[index];
      if (!previous) fail(404, "iBGP 域不存在");
      const updated = materializeDomain({ ...body, id: domainId }, previous);
      assertDomainUnique(draft, updated.id, updated.name, domainId);
      const oldSessions = draft.sessions.filter((session) => session.managedBy?.domainId === domainId);
      const preserved = sessionUpdates(body, oldSessions);
      draft.peers = draft.peers.filter((peer) => peer.managedBy?.domainId !== domainId);
      draft.sessions = draft.sessions.filter((session) => session.managedBy?.domainId !== domainId);
      const expanded = expandDomainWithUpdates(updated, draft.nodes, body, preserved);
      draft.ibgpDomains[index] = updated;
      draft.peers.push(...expanded.peers);
      draft.sessions.push(...expanded.sessions);
      affectedNodeIds = uniqueNodeIds(domainNodeIds(previous), domainNodeIds(updated));
      return updated;
    }, () => affectedNodeIds);
    event("success", `已更新 iBGP 域 ${domain.name}`);
    return { status: 200, payload: { domain, inventory: state, deployment, events: events() } };
  },

  async deleteIbgpDomain(domainId) {
    let affectedNodeIds: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply((draft) => {
      const index = draft.ibgpDomains.findIndex((item) => item.id === domainId);
      if (index < 0) fail(404, "iBGP 域不存在");
      const target = draft.ibgpDomains[index];
      if (!target) fail(404, "iBGP 域不存在");
      affectedNodeIds = domainNodeIds(target);
      draft.ibgpDomains.splice(index, 1);
      draft.peers = draft.peers.filter((peer) => peer.managedBy?.domainId !== domainId);
      draft.sessions = draft.sessions.filter((session) => session.managedBy?.domainId !== domainId);
      return target;
    }, () => affectedNodeIds);
    event("success", `已删除 iBGP 域 ${domain.name}`);
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async updateIbgpDomainLayout(domainId, body) {
    const { state, result: domain } = await withDeploymentLock(() => store.mutate((draft) => {
      const target = draft.ibgpDomains.find((item) => item.id === domainId);
      if (!target) fail(404, "iBGP 域不存在");
      if (!body.layout || typeof body.layout !== "object" || Array.isArray(body.layout)) fail(400, "拓扑布局必须是对象");
      target.layout = normalizeIbgpDomain({ ...target, layout: body.layout }).layout;
      return target;
    }));
    return { status: 200, payload: { domain, inventory: state } };
  },

  async listOspfDomains() {
    const state = await store.read();
    return { status: 200, payload: { domains: state.ospfDomains, layout: state.ospfLayout, inventory: state } };
  },

  async updateOspfLayout(body) {
    const { state } = await withDeploymentLock(() => store.mutate((draft) => {
      if (!body.layout || typeof body.layout !== "object" || Array.isArray(body.layout)) fail(400, "拓扑布局必须是对象");
      const nodeIds = new Set(draft.nodes.map((node) => node.id));
      const updates = Object.fromEntries(Object.entries(body.layout).filter(([nodeId]) => nodeIds.has(nodeId)));
      draft.ospfLayout = { ...draft.ospfLayout, ...updates };
    }), { waitForActive: true });
    return { status: 200, payload: { layout: state.ospfLayout, inventory: state } };
  },

  async previewOspfDomain(body) {
    return withDeploymentLock(async () => {
      const { domain, inventory, affected } = await ospfCandidate(body);
      const configs = [] as Array<{ nodeId: string; config: string; validation: Awaited<ReturnType<typeof stageAndValidate>> }>;
      for (const nodeId of affected) {
        const node = findNode(inventory, nodeId);
        const config = configForNode(inventory, node);
        configs.push({ nodeId, config, validation: await stageAndValidate(node, config) });
      }
      return { status: 200, payload: { valid: configs.every((item) => item.validation.ok), domain, configs } };
    });
  },

  async renderOspfDomain(body) {
    const { domain, inventory, affected } = await ospfCandidate(body);
    const configs = affected.map((nodeId) => ({ nodeId, config: configForNode(inventory, findNode(inventory, nodeId)) }));
    return { status: 200, payload: { domain, configs } };
  },

  async createOspfDomain(body) {
    const domain = stripUnknownOspfLayout(materializeOspf({ ...body, id: body.id ?? makeId("ospf") }));
    const { state, deployment } = await mutateAndApply((draft) => {
      if (draft.ospfDomains.some((item) => item.id === domain.id)) fail(409, "OSPF 域 ID 已存在");
      if (draft.ospfDomains.some((item) => item.name === domain.name)) fail(409, "OSPF 域名称已存在");
      draft.ospfDomains.push(domain);
      return domain;
    }, () => ospfDomainNodeIds(domain));
    event("success", `已创建 OSPF 域 ${domain.name}`);
    return { status: 201, payload: { domain: state.ospfDomains.find((item) => item.id === domain.id), inventory: state, deployment, events: events() } };
  },

  async updateOspfDomain(domainId, body) {
    let affected: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply((draft) => {
      const index = draft.ospfDomains.findIndex((item) => item.id === domainId);
      if (index < 0) fail(404, "OSPF 域不存在");
      const previous = draft.ospfDomains[index];
      if (!previous) fail(404, "OSPF 域不存在");
      const updated = stripUnknownOspfLayout(materializeOspf({ ...body, id: domainId }, previous));
      if (draft.ospfDomains.some((item) => item.id !== domainId && item.name === updated.name)) fail(409, "OSPF 域名称已存在");
      draft.ospfDomains[index] = updated;
      affected = uniqueNodeIds(ospfDomainNodeIds(previous), ospfDomainNodeIds(updated));
      return updated;
    }, () => affected);
    event("success", `已更新 OSPF 域 ${domain.name}`);
    return { status: 200, payload: { domain, inventory: state, deployment, events: events() } };
  },

  async deleteOspfDomain(domainId) {
    let affected: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply((draft) => {
      const index = draft.ospfDomains.findIndex((item) => item.id === domainId);
      if (index < 0) fail(404, "OSPF 域不存在");
      const target = draft.ospfDomains[index];
      if (!target) fail(404, "OSPF 域不存在");
      affected = ospfDomainNodeIds(target); draft.ospfDomains.splice(index, 1); return target;
    }, () => affected);
    event("success", `已删除 OSPF 域 ${domain.name}`);
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  async updateOspfDomainLayout(domainId, body) {
    const { state, result: domain } = await withDeploymentLock(() => store.mutate((draft) => {
      const target = draft.ospfDomains.find((item) => item.id === domainId);
      if (!target) fail(404, "OSPF 域不存在");
      if (!body.layout || typeof body.layout !== "object" || Array.isArray(body.layout)) fail(400, "拓扑布局必须是对象");
      const layout = Object.fromEntries(
        Object.entries(body.layout).filter(([nodeId]) => target.nodeConfigs.some((config) => config.nodeId === nodeId)),
      );
      // Layout updates are intentionally incremental. This keeps a partial
      // request (for example, one queued while the domain is hydrating) from
      // erasing coordinates that were already persisted for other nodes.
      target.layout = normalizeOspfDomain({
        ...target,
        layout: { ...target.layout, ...layout },
      }).layout;
      return target;
    }), { waitForActive: true });
    return { status: 200, payload: { domain, inventory: state } };
  },

    previewSession: (body) => options.sessions.preview(body),
    applySession: (body) => options.sessions.apply(body),
    deleteSession: (sessionId) => options.sessions.delete(sessionId),
  };
}
