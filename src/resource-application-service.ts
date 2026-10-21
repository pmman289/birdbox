import { configDiff } from "./config-diff.js";
import { normalizePipeProtocol } from "./bird-pipe.js";
import { createHash, randomUUID } from "node:crypto";
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
  StaticRouteAction,
  RpkiSource,
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
import { rpkiReferences } from "./bird-rpki.js";
import { normalizeSession } from "./bird-session.js";
import type { DeploymentService } from "./deployment-service.js";
import { fail } from "./errors.js";
import {
  configForNode,
  configBundleForNode,
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
import { normalizeOspfDomain, ospfDomainNodeIds, toOspfDomainModel } from "./ospf.js";
import type { SessionApplicationService } from "./session-application-service.js";
import type { InventoryStore } from "./store.js";
import { logger } from "./logger.js";
import { restoreSecretPlaceholders } from "./inventory-redaction.js";
import { normalizeDefine } from "./bird-policy-resources.js";
import { defineReferences, policyResourceReferences } from "../packages/contracts/src/define-references.js";
import type { PolicyDefine } from "../packages/contracts/src/inventory.js";
import { normalizeIrrResolveRequest } from "./irr-as-set.js";

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

  const definePreviews = new Map<string, { resource: PolicyDefine; hash: string; revision: number | null; expiresAt: number }>();
  const defineHash = (resource: PolicyDefine): string => createHash("sha256").update(JSON.stringify(resource.type === "expression" ? resource : { ...resource, sync: undefined })).digest("hex");
  function assertDefineRevision(body: Record<string, unknown>, current: Inventory): void {
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== store.revisionOf(current)) {
      fail(409, "Define 草稿基于旧库存，编辑内容已保留，请加载最新版本并对比后重新预检", "STATE_CONFLICT");
    }
  }
  async function prepareDefine(body: Record<string, unknown>, resourceId?: string) {
    const current = await store.read();
    assertDefineRevision(body, current);
    const previous = resourceId ? current.defines.find(item => item.id === resourceId) : null;
    if (resourceId && !previous) fail(404, "Define 不存在");
    const token = body.previewId ? definePreviews.get(String(body.previewId)) : undefined;
    if (body.mode !== undefined && body.mode !== "apply") fail(400, "Define 保存模式不合法");
    if ((body.mode === "apply" || body.previewId !== undefined) && (!token || token.expiresAt < Date.now())) fail(409, "预检已失效，请重新预检当前草稿", "DEFINE_PREVIEW_STALE");
    if (token && token.revision !== store.revisionOf(current)) fail(409, "库存已变化，请加载最新版本并对比后重新预检", "STATE_CONFLICT");
    const id = resourceId ?? token?.resource.id ?? makeId("define");
    const input: Record<string, unknown> = { ...previous, ...body, ...(Object.hasOwn(body, "nodeId") && !Object.hasOwn(body, "nodeIds") ? { nodeIds: body.nodeId } : {}), id };
    let resource: PolicyDefine;
    if (token) {
      resource = normalizeDefine({ ...input, ...(token.resource.type !== "expression" ? { sync: token.resource.sync } : {}) });
      if (token.resource.id !== id || defineHash(resource) !== token.hash || (body.candidateHash !== undefined && body.candidateHash !== token.hash)) fail(409, "Define 草稿已变化，请重新预检", "DEFINE_PREVIEW_STALE");
      resource = structuredClone(token.resource);
    } else if (input.type !== "expression" && (input.entrySource as { kind?: string } | undefined)?.kind === "irr-as-set") {
      // Validate settings before doing network I/O. Never accept client-owned sync metadata.
      const seed = normalizeDefine({ ...input, entries: [input.type === "cidr6" ? "2001:db8::/32" : "192.0.2.0/24"], sync: {} });
      const reusable = body.refreshSnapshot !== true && previous && previous.type !== "expression" && previous.entrySource.kind === "irr-as-set"
        && previous.type === seed.type
        && JSON.stringify(normalizeIrrResolveRequest(irrRequest(previous as unknown as Record<string, unknown>))) === JSON.stringify(normalizeIrrResolveRequest(irrRequest(input)));
      const materialized = reusable ? { entries: previous.entries, sync: previous.sync } : await materializeIrrBody(input);
      resource = normalizeDefine({ ...input, entries: materialized.entries, sync: materialized.sync });
      if (reusable && resource.type !== "expression" && resource.entrySource.kind === "irr-as-set" && previous.entrySource.kind === "irr-as-set" && resource.entrySource.refreshIntervalSeconds !== previous.entrySource.refreshIntervalSeconds) {
        resource.sync.nextRefreshAt = new Date(Date.now() + resource.entrySource.refreshIntervalSeconds * 1000).toISOString();
      }
    } else resource = normalizeDefine(input);
    if (previous && resource.name !== previous.name && resourceReferencesSymbol(current, previous.name, previous.id, previous)) fail(409, `请先更新引用 Define ${previous.name} 的资源`);
    return { current, previous, resource, revision: store.revisionOf(current) };
  }
  async function assertPreparedDefine(prepared: Awaited<ReturnType<typeof prepareDefine>>): Promise<void> {
    const latest = await store.read();
    if (prepared.revision !== store.revisionOf(latest)) fail(409, "库存在预检或同步期间已变化，请重新加载并对比，草稿已保留", "STATE_CONFLICT");
  }
  function defineConfigText(bundle: ReturnType<typeof configBundleForNode>): string {
    return [bundle.main, ...bundle.resources.map(file => `\n# 文件 ${file.relativePath}\n${file.content}`)].join("\n");
  }
  function defineDiff(before: string, after: string): string {
    if (before === after) return "无配置变化";
    const a = before.split("\n"), b = after.split("\n");
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const lines = ["--- 当前配置", "+++ 候选配置", ...a.slice(Math.max(0, start - 2), start).map(line => ` ${line}`), ...a.slice(start, endA).map(line => `-${line}`), ...b.slice(start, endB).map(line => `+${line}`), ...a.slice(endA, endA + 2).map(line => ` ${line}`)];
    return lines.length > 1000 ? [...lines.slice(0, 1000), `…差异共 ${lines.length} 行，仅展示前 1000 行；完整候选配置见下方`].join("\n") : lines.join("\n");
  }

  type SourcePolicyKind = "functions" | "filters";
  const policyPreviews = new Map<string, { kind: SourcePolicyKind; resource: ReturnType<typeof normalizePolicyResource>; hash: string; revision: number | null; expires: number }>();
  const policyHash = (resource: ReturnType<typeof normalizePolicyResource>) => createHash("sha256").update(JSON.stringify(resource)).digest("hex");
  function assertPolicyRevision(body: Record<string, unknown>, current: Inventory) {
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== store.revisionOf(current)) fail(409, "策略库存已变化，草稿已保留，请加载最新版本并对比后重新预检", "STATE_CONFLICT");
  }
  async function preparePolicy(kind: SourcePolicyKind, body: Record<string, unknown>, resourceId?: string) {
    const current = await store.read();
    assertPolicyRevision(body, current);
    const previous = resourceId ? policyResources(current, kind).find(item => item.id === resourceId) : null;
    if (resourceId && !previous) fail(404, "策略资源不存在");
    const token = body.previewId ? policyPreviews.get(String(body.previewId)) : undefined;
    if (body.mode !== undefined && body.mode !== "apply") fail(400, "策略保存模式不合法");
    if ((body.mode === "apply" || body.previewId !== undefined) && (!token || token.kind !== kind || token.expires < Date.now() || body.candidateHash !== token.hash || body.inventoryRevision !== token.revision)) fail(409, "策略预检已失效，请重新预检当前草稿", "POLICY_PREVIEW_STALE");
    if (token && token.revision !== store.revisionOf(current)) fail(409, "策略库存已变化，请对比后重新预检", "STATE_CONFLICT");
    const id = resourceId ?? token?.resource.id ?? makeId(kind === "functions" ? "function" : "filter");
    const input = { ...previous, ...body, ...(Object.hasOwn(body, "nodeId") && !Object.hasOwn(body, "nodeIds") ? { nodeIds: body.nodeId } : {}), id };
    const resource = normalizePolicyResource(kind, input);
    if (token && (token.resource.id !== id || policyHash(resource) !== token.hash)) fail(409, "策略草稿已变化，请重新预检", "POLICY_PREVIEW_STALE");
    if (previous && resource.name !== previous.name && resourceReferencesSymbol(current, previous.name, previous.id, previous)) fail(409, "请先更新引用该策略名称的资源");
    return { current, previous, resource, revision: store.revisionOf(current) };
  }
  async function assertPreparedPolicy(prepared: Awaited<ReturnType<typeof preparePolicy>>) {
    if (prepared.revision !== store.revisionOf(await store.read())) fail(409, "库存在预检期间已变化，草稿已保留，请对比后重新预检", "STATE_CONFLICT");
  }

  const sourcePreviews = new Map<string, { resource: SourcePolicyEgress; hash: string; revision: number | null; expires: number }>();
  const sourceHash = (resource: SourcePolicyEgress) => createHash("sha256").update(JSON.stringify(resource)).digest("hex");
  function assertSourceRevision(body: Record<string, unknown>, current: Inventory) {
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== store.revisionOf(current)) fail(409, "库存已变化，源地址出口草稿已保留，请加载最新版本并对比后重新预检", "STATE_CONFLICT");
  }
  async function prepareSourceCandidate(body: Record<string, unknown>, resourceId?: string, planning = false) {
    const current = await store.read();
    assertSourceRevision(body, current);
    const previous = resourceId ? current.sourcePolicies.find(item => item.id === resourceId) ?? null : null;
    if (resourceId && !previous) fail(404, "源地址出口映射不存在");
    if (body.mode !== undefined && body.mode !== "apply" && !(planning && body.mode === "plan")) fail(400, "源地址出口保存模式不合法");
    const token = body.previewId ? sourcePreviews.get(String(body.previewId)) : undefined;
    if ((body.mode === "apply" || body.previewId !== undefined) && (!token || token.expires < Date.now() || token.hash !== body.candidateHash || token.revision !== body.inventoryRevision)) fail(409, "源地址出口预检已失效，请重新预检当前草稿", "SOURCE_POLICY_PREVIEW_STALE");
    if (token && token.revision !== store.revisionOf(current)) fail(409, "库存在预检后已变化，请对比后重新预检", "STATE_CONFLICT");
    const id = resourceId ?? token?.resource.id ?? makeId("source_policy");
    const resource = prepareSourcePolicyEgress({ ...body, id }, previous, current.sourcePolicies, makeId);
    if (token && (token.resource.id !== id || sourceHash(resource) !== token.hash)) fail(409, "源地址出口草稿已变化，请重新预检", "SOURCE_POLICY_PREVIEW_STALE");
    return { current, previous, resource, revision: store.revisionOf(current) };
  }
  async function assertSourcePrepared(revision: number | null) {
    if (revision !== store.revisionOf(await store.read())) fail(409, "库存在预检期间已变化，草稿已保留，请加载最新版本并对比", "STATE_CONFLICT");
  }

  const rpkiPreviews = new Map<string, { resource: RpkiSource; hash: string; revision: number | null; expiresAt: number }>();
  const rpkiHash = (resource: RpkiSource): string => createHash("sha256").update(JSON.stringify(resource)).digest("hex");
  function assertRpkiRevision(body: Record<string, unknown>, current: Inventory): void {
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== store.revisionOf(current)) fail(409, "RPKI 库存已变化，请加载最新版本并对比，草稿已保留", "STATE_CONFLICT");
  }
  function prepareRpki(current: Inventory, body: Record<string, unknown>, resourceId?: string) {
    assertRpkiRevision(body, current);
    const previous = resourceId ? current.rpki.find(item => item.id === resourceId) : undefined;
    if (resourceId && !previous) fail(404, "RPKI 资源不存在");
    const token = body.previewId ? rpkiPreviews.get(String(body.previewId)) : undefined;
    if (body.mode !== undefined && body.mode !== "apply") fail(400, "RPKI 保存模式不合法");
    if ((body.mode === "apply" || body.previewId !== undefined) && (!token || token.expiresAt < Date.now() || body.inventoryRevision !== token.revision || body.candidateHash !== token.hash)) fail(409, "预检已失效，请重新预检当前 RPKI 草稿", "RPKI_PREVIEW_STALE");
    if (token && token.revision !== store.revisionOf(current)) fail(409, "RPKI 库存已变化，请加载最新版本并对比", "STATE_CONFLICT");
    const id = resourceId ?? token?.resource.id ?? makeId("rpki");
    const input = { ...previous, ...restoreSecretPlaceholders(body, token?.resource ?? previous), ...(Object.hasOwn(body, "nodeId") && !Object.hasOwn(body, "nodeIds") ? { nodeIds: body.nodeId } : {}), id };
    const resource = normalizeRPKI(input);
    if (token && (token.resource.id !== id || rpkiHash(resource) !== token.hash)) fail(409, "RPKI 草稿已变化，请重新预检", "RPKI_PREVIEW_STALE");
    for (const symbol of [previous?.name, previous?.roa4Table, previous?.roa6Table]) {
      if (symbol && ![resource.name, resource.roa4Table, resource.roa6Table].includes(symbol) && resourceReferencesSymbol(current, symbol)) fail(409, `请先更新引用 RPKI 符号 ${symbol} 的策略`);
    }
    return { previous, resource, revision: store.revisionOf(current) };
  }
  async function assertRpkiPrepared(revision: number | null): Promise<void> {
    if (revision !== store.revisionOf(await store.read())) fail(409, "RPKI 库存在预检期间已变化，请加载最新版本并对比", "STATE_CONFLICT");
  }

  type SystemKind = "directs" | "kernels";
  type SystemResource = DirectProtocol | KernelProtocol;
  const systemCollection = (kind: SystemKind) => kind === "directs" ? "directProtocols" as const : "kernelProtocols" as const;
  const systemLabel = (kind: SystemKind) => kind === "directs" ? "Direct" : "Kernel";
  const normalizeSystem = (kind: SystemKind, input: unknown): SystemResource => kind === "directs" ? normalizeDirectProtocol(input) : normalizeKernelProtocol(input);
  function mergeSystem(kind: SystemKind, previous: SystemResource | undefined, body: Record<string, unknown>, id: string): SystemResource {
    const input: Record<string, unknown> = { ...previous, ...body, id };
    if (kind === "kernels" && Object.hasOwn(body, "importPolicy") && !Object.hasOwn(body, "importPolicies")) delete input.importPolicies;
    return normalizeSystem(kind, input);
  }
  const systemPreviews = new Map<string, { kind: SystemKind; resource: SystemResource; hash: string; revision: number | null; expires: number }>();
  const systemHash = (resource: SystemResource) => createHash("sha256").update(JSON.stringify(resource)).digest("hex");
  async function assertSystemRevision(body: Record<string, unknown>): Promise<number | null> {
    const current = await store.read(), revision = store.revisionOf(current);
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== revision) fail(409, "库存已变化，草稿已保留，请加载最新版本并对比后重新预检", "STATE_CONFLICT");
    return revision;
  }
  function putSystemResource(state: Inventory, kind: SystemKind, resource: SystemResource): void {
    if (kind === "directs") state.directProtocols = [...state.directProtocols.filter(item => item.id !== resource.id), resource as DirectProtocol];
    else state.kernelProtocols = [...state.kernelProtocols.filter(item => item.id !== resource.id), resource as KernelProtocol];
  }
  async function preflightDisabledSystem(state: Inventory, kind: SystemKind, resource: SystemResource): Promise<void> {
    if (resource.enabled) return;
    const probe = structuredClone(state);
    putSystemResource(probe, kind, { ...resource, enabled: true });
    const candidate = validateInventory(probe);
    for (const nodeId of resourceNodeIds(candidate, resource)) {
      const node = findNode(candidate, nodeId), result = await stageAndValidate(node, configBundleForNode(candidate, node));
      if (!result.ok) fail(422, `${node.name}：${result.stderr || result.stdout || "停用资源预检失败"}`);
    }
  }
  async function saveSystem(kind: SystemKind, body: Record<string, unknown>, id?: string) {
    const token = body.previewId ? systemPreviews.get(String(body.previewId)) : undefined;
    const resourceId = id ?? token?.resource.id ?? makeId(kind === "directs" ? "direct" : "kernel");
    let affected: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async draft => {
      const revision = await assertSystemRevision(body);
      const previous = draft[systemCollection(kind)].find(item => item.id === resourceId);
      if (id && !previous) fail(404, `${systemLabel(kind)} 资源不存在`);
      if (!id && previous) fail(409, "资源已存在，请重新加载", "STATE_CONFLICT");
      const resource = mergeSystem(kind, previous, body, resourceId);
      if (body.mode !== undefined && body.mode !== "apply") fail(400, "保存模式不合法");
      if (body.mode === "apply" || body.previewId !== undefined) {
        if (!token || token.kind !== kind || token.expires < Date.now() || token.resource.id !== resourceId || systemHash(resource) !== token.hash || body.candidateHash !== token.hash) fail(409, "预检已失效或草稿已变化，请重新预检", "PROTOCOL_PREVIEW_STALE");
        if (token.revision !== revision) fail(409, "库存已变化，请对比后重新预检", "STATE_CONFLICT");
      }
      affected = resourceChangeNodeIds(draft, previous ?? resource, resource);
      if (!affected.length) fail(400, "请至少选择一个可用节点");
      putSystemResource(draft, kind, resource);
      const candidate = validateInventory(draft);
      await preflightDisabledSystem(candidate, kind, resource);
      return resource;
    }, () => affected);
    event("success", `已${id ? "更新" : "添加"} ${systemLabel(kind)} 资源 ${resource.label}`);
    return { status: id ? 200 : 201, payload: { resource, inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  }
  async function deleteSystem(kind: SystemKind, resourceId: string, body: Record<string, unknown>) {
    let affected: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async draft => {
      await assertSystemRevision(body);
      const resource = draft[systemCollection(kind)].find(item => item.id === resourceId);
      if (!resource) fail(404, `${systemLabel(kind)} 资源不存在`);
      affected = resourceNodeIds(draft, resource);
      if (kind === "directs") draft.directProtocols = draft.directProtocols.filter(item => item.id !== resourceId);
      else draft.kernelProtocols = draft.kernelProtocols.filter(item => item.id !== resourceId);
      return resource;
    }, () => affected);
    event("success", `已删除 ${systemLabel(kind)} 资源 ${resource.label}`);
    return { status: 200, payload: { inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  }

  const staticPreviews = new Map<string, { resourceId: string; signature: string; revision: number | null; expires: number }>();
  async function assertStaticCandidate(body: Record<string, unknown>, resource: ReturnType<typeof normalizeStaticProtocol>) {
    const current = await store.read();
    const revision = store.revisionOf(current);
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== revision) fail(409, "库存已变化，Static 编辑内容已保留，请重新预检并对比变更", "STATE_CONFLICT");
    if (body.previewId !== undefined) {
      const preview = staticPreviews.get(String(body.previewId));
      if (!preview || preview.expires < Date.now() || preview.resourceId !== resource.id || preview.signature !== JSON.stringify(resource)) fail(409, "Static 草稿已变化，请重新预检", "STATIC_PREVIEW_STALE");
      if (preview.revision !== revision) fail(409, "库存已变化，请重新预检并对比变更", "STATE_CONFLICT");
    }
  }

  const ospfPreviews = new Map<string, { domain: OspfDomain; hash: string; revision: number | null; expiresAt: number }>();
  function ospfCandidateHash(domain: OspfDomain): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "layout").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return createHash("sha256").update(JSON.stringify(canonical(normalizeOspfDomain(toOspfDomainModel(domain))))).digest("hex");
  }
  async function saveOspfDraft(body: Record<string, unknown>, domainId?: string) {
    return withDeploymentLock(async () => {
      const { domain } = await ospfCandidate({ ...body, ...(domainId ? { id: domainId } : {}) });
      const revision = await assertOspfRevision(body);
      const current = await store.read();
      if (current.ospfDomains.some((item) => item.id !== domain.id && item.name === domain.name)) fail(409, "OSPF 域名称已存在");
      await store.saveOspfDraft(domain, revision);
      return { status: 200, payload: { domain: toOspfDomainModel(domain), inventoryRevision: revision, draft: true, deployment: { applied: false, nodeIds: [], nodes: [], sessions: [] } } };
    });
  }
  async function saveOspf(body: Record<string, unknown>, domainId?: string) {
    const token = body.previewId ? ospfPreviews.get(String(body.previewId)) : undefined;
    let affected: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply(async draft => {
      // Check again under the deployment lock, including after a CAS retry.
      const revision = await assertOspfRevision(body);
      if (body.mode !== undefined && body.mode !== "apply") fail(400, "无效的 OSPF 保存模式");
      const id = domainId ?? token?.domain.id ?? (body.id ? String(body.id) : makeId("ospf"));
      const previous = draft.ospfDomains.find(item => item.id === id) ?? null;
      if (domainId && !previous) fail(404, "OSPF 域不存在");
      if (!domainId && previous) fail(409, "OSPF 域已存在，请重新加载", "STATE_CONFLICT");
      if (body.mode === "apply" || body.previewId !== undefined) {
        if (!token || token.expiresAt < Date.now() || token.domain.id !== id || body.candidateHash !== token.hash) fail(409, "预检已失效，请重新预检当前草稿", "OSPF_PREVIEW_STALE");
        if (token.revision !== revision) fail(409, "库存已变化，请对比后重新预检", "STATE_CONFLICT");
      }
      const input = token ? restoreSecretPlaceholders(body, toOspfDomainModel(token.domain)) : body;
      const updated = stripUnknownOspfLayout(materializeOspf({ ...input, id }, previous));
      if (token && ospfCandidateHash(updated) !== token.hash) fail(409, "草稿已变化，请重新预检", "OSPF_PREVIEW_STALE");
      if (draft.ospfDomains.some(item => item.id !== id && item.name === updated.name)) fail(409, "OSPF 域名称已存在");
      affected = uniqueNodeIds(previous ? ospfDomainNodeIds(previous) : [], ospfDomainNodeIds(updated));
      const index = draft.ospfDomains.findIndex(item => item.id === id);
      if (index < 0) draft.ospfDomains.push(updated);
      else draft.ospfDomains[index] = updated;
      return updated;
    }, () => affected);
    await store.deleteOspfDraft(domain.id);
    event("success", `已${domainId ? "更新" : "创建"} OSPF 域 ${domain.name}`);
    return { status: domainId ? 200 : 201, payload: { domain: toOspfDomainModel(domain), inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  }

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

  const ibgpPreviews = new Map<string, { domain: IbgpDomain; sessions: BgpSession[]; hash: string; revision: number | null; expiresAt: number }>();
  function ibgpHash(domain: IbgpDomain, sessions: BgpSession[]): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "layout").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return createHash("sha256").update(JSON.stringify(canonical({ domain, sessions }))).digest("hex");
  }
  function assertIbgpRevision(body: Record<string, unknown>, current: Inventory): void {
    if (body.inventoryRevision !== undefined && body.inventoryRevision !== store.revisionOf(current)) fail(409, "iBGP 库存已变化，草稿已保留，请加载最新版本并对比后重新预检", "STATE_CONFLICT");
  }
  function ibgpCandidate(current: Inventory, body: Record<string, unknown>, previous?: IbgpDomain, id?: string, existing?: BgpSession[]) {
    const domain = materializeDomain({ ...body, id: id ?? previous?.id ?? (body.id || makeId("ibgp")) }, previous ?? null);
    assertDomainUnique(current, domain.id, domain.name, previous?.id ?? null);
    const candidate = structuredClone(current);
    candidate.ibgpDomains = candidate.ibgpDomains.filter(item => item.id !== domain.id);
    candidate.peers = candidate.peers.filter(item => item.managedBy?.domainId !== domain.id);
    candidate.sessions = candidate.sessions.filter(item => item.managedBy?.domainId !== domain.id);
    const expanded = expandDomainWithUpdates(domain, candidate.nodes, body, existing ?? current.sessions.filter(item => item.managedBy?.domainId === domain.id));
    candidate.ibgpDomains.push(domain);
    candidate.peers.push(...expanded.peers);
    candidate.sessions.push(...expanded.sessions);
    const inventory = validateInventory(candidate);
    return { domain, sessions: expanded.sessions, inventory, affected: uniqueNodeIds(previous ? domainNodeIds(previous) : [], domainNodeIds(domain)) };
  }
  async function saveIbgp(body: Record<string, unknown>, domainId?: string) {
    const token = body.previewId ? ibgpPreviews.get(String(body.previewId)) : undefined;
    let affected: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply(async draft => {
      const current = await store.read();
      assertIbgpRevision(body, current);
      if (body.mode !== undefined && body.mode !== "apply") fail(400, "iBGP 保存模式不合法");
      const id = domainId ?? token?.domain.id ?? (body.id ? String(body.id) : makeId("ibgp"));
      const previous = draft.ibgpDomains.find(item => item.id === id);
      if (domainId && !previous) fail(404, "iBGP 域不存在");
      if (!domainId && previous) fail(409, "iBGP 域已存在，请重新加载", "STATE_CONFLICT");
      if (body.mode === "apply" || body.previewId !== undefined) {
        if (!token || token.expiresAt < Date.now() || token.domain.id !== id || body.candidateHash !== token.hash || body.inventoryRevision !== token.revision) fail(409, "iBGP 预检已失效，请重新预检当前草稿", "IBGP_PREVIEW_STALE");
        if (token.revision !== store.revisionOf(current)) fail(409, "iBGP 库存已变化，请加载最新版本并对比", "STATE_CONFLICT");
      }
      const restored = token ? restoreSecretPlaceholders(body, { ...token.domain, sessionUpdates: token.sessions }) : body;
      const candidate = ibgpCandidate(draft, restored, previous, id, token?.sessions);
      if (token && ibgpHash(candidate.domain, candidate.sessions) !== token.hash) fail(409, "iBGP 草稿已变化，请重新预检", "IBGP_PREVIEW_STALE");
      affected = candidate.affected;
      Object.assign(draft, candidate.inventory);
      return candidate.domain;
    }, () => affected);
    event("success", `已${domainId ? "更新" : "创建"} iBGP 域 ${domain.name}`);
    return { status: domainId ? 200 : 201, payload: { domain, inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  }

  function materializeOspf(input: Record<string, unknown>, previous: OspfDomain | null = null): OspfDomain {
    const restoredInput = previous ? restoreSecretPlaceholders(input, previous) : input;
    const candidate = { ...(previous ?? {}), ...restoredInput, id: previous?.id ?? input.id ?? makeId("ospf") } as Record<string, unknown>;
    // The editor may submit the compact shape for a structured saved domain.
    // Stale projections must not override its edited nodes and endpoints.
    if (Array.isArray(restoredInput.nodeConfigs) && !Array.isArray(restoredInput.members)) {
      delete candidate.members;
      delete candidate.areas;
    }
    return normalizeOspfDomain(candidate);
  }

  async function assertOspfRevision(body: Record<string, unknown>): Promise<number | null> {
    const current = await store.read();
    const revision = store.revisionOf(current);
    if (body.inventoryRevision !== undefined && (typeof body.inventoryRevision !== "number" || !Number.isInteger(body.inventoryRevision) || body.inventoryRevision !== revision)) {
      fail(409, "OSPF 草稿基于旧的库存版本，请重新加载或对比后再提交", "STATE_CONFLICT");
    }
    return revision;
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
    const expectedRevision = body.inventoryRevision;
    const actualRevision = store.revisionOf(current);
    if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision !== actualRevision)) {
      fail(409, "OSPF 草稿基于旧的库存版本，请重新加载或对比后再提交", "STATE_CONFLICT");
    }
    const id = body.id === undefined || body.id === "" ? makeId("ospf") : String(body.id);
    const previous = current.ospfDomains.find((item) => item.id === id) ?? null;
    const storedDraft = (await store.readOspfDrafts())[id]?.domain;
    const input = storedDraft ? restoreSecretPlaceholders(body, toOspfDomainModel(storedDraft)) : body;
    const domain = stripUnknownOspfLayout(materializeOspf({ ...input, id }, previous));
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
      const validation = await stageAndValidate(node, configBundleForNode(state, node));
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
      const validation = await stageAndValidate(node, configBundleForNode(state, node));
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
    const bundle = configBundleForNode(state, node);
    const validation = await stageAndValidate(node, bundle);
    if (!validation.ok) {
      fail(
        422,
        staticValidationError(
          bundle.main,
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
      const validation = await stageAndValidate(node, configBundleForNode(state, node));
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
    createNodeReinstallScript: (nodeId) => options.nodeOnboarding.createReinstallScript(nodeId),
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

  async getSystemProtocolContext(kind, resourceId) {
    const current = await store.read();
    const resource = resourceId ? current[systemCollection(kind)].find(item => item.id === resourceId) : null;
    return { status: 200, payload: { inventoryRevision: store.revisionOf(current), resource: resource ?? null } };
  },
  async previewSystemProtocol(kind, body) {
    return withDeploymentLock(async () => {
      const current = await store.read();
      await assertSystemRevision(body);
      const previous = typeof body.id === "string" ? current[systemCollection(kind)].find(item => item.id === body.id) : undefined;
      if (body.id !== undefined && !previous) fail(404, `${systemLabel(kind)} 资源不存在`);
      const resource = mergeSystem(kind, previous, body, previous?.id ?? makeId(kind === "directs" ? "direct" : "kernel"));
      const candidate = structuredClone(current);
      putSystemResource(candidate, kind, resource);
      const state = validateInventory(candidate), affected = resourceChangeNodeIds(current, previous ?? resource, resource);
      if (!affected.length) fail(400, "请至少选择一个可用节点");
      const probe = structuredClone(state);
      putSystemResource(probe, kind, { ...resource, enabled: true });
      const probeState = resource.enabled ? state : validateInventory(probe);
      const configs = await Promise.all(affected.map(async nodeId => {
        const node = findNode(state, nodeId), bundle = configBundleForNode(state, node);
        const validation = await stageAndValidate(node, resource.enabled ? bundle : configBundleForNode(probeState, node)).catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : "节点预检失败" }));
        const config = defineConfigText(bundle);
        return { nodeId, config, diff: defineDiff(defineConfigText(configBundleForNode(current, findNode(current, nodeId))), config), validation };
      }));
      const valid = configs.every(item => item.validation.ok), previewId = randomUUID(), candidateHash = systemHash(resource), revision = store.revisionOf(current);
      for (const [id, token] of systemPreviews) if (token.expires < Date.now()) systemPreviews.delete(id);
      if (systemPreviews.size >= 200) systemPreviews.delete(systemPreviews.keys().next().value!);
      if (valid) systemPreviews.set(previewId, { kind, resource, hash: candidateHash, revision, expires: Date.now() + 300_000 });
      return { status: 200, payload: { valid, previewId, candidateHash, inventoryRevision: revision, resource, configs } };
    });
  },
  createDirect: body => saveSystem("directs", body),
  updateDirect: (resourceId, body) => saveSystem("directs", body, resourceId),
  deleteDirect: (resourceId, body = {}) => deleteSystem("directs", resourceId, body),

  async previewPipe(body) {
    return withDeploymentLock(async () => {
      const current = await store.read();
      const previous = typeof body.id === "string" ? current.pipeProtocols.find((item) => item.id === body.id) : undefined;
      if (body.id !== undefined && !previous) fail(404, "Pipe 资源不存在");
      const resource = normalizePipeProtocol({ ...previous, ...body, id: previous?.id ?? makeId("pipe_preview") });
      const candidate = structuredClone(current);
      candidate.pipeProtocols = [...candidate.pipeProtocols.filter((item) => item.id !== resource.id), resource];
      const state = validateInventory(candidate);
      const affected = resourceChangeNodeIds(current, previous ?? resource, resource);
      const configs = await Promise.all(affected.map(async (nodeId) => {
        const node = findNode(state, nodeId);
        const bundle = configBundleForNode(state, node);
        const validation = await stageAndValidate(node, bundle).catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : "节点预检失败", code: "NODE_PREFLIGHT_ERROR" }));
        return { nodeId, config: bundle.main, validation };
      }));
      return { status: 200, payload: { valid: configs.every((item) => item.validation.ok), resource, configs } };
    });
  },

  async createPipe(body) {
    const resource = normalizePipeProtocol({ ...body, id: makeId("pipe") });
    const { state, deployment } = await mutateAndApply((draft) => {
      draft.pipeProtocols.push(resource);
      validateInventory(draft);
      return resource;
    }, (_result, state) => resourceNodeIds(state, resource));
    event("success", `已添加 Pipe ${resource.label}`);
    return { status: 201, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async updatePipe(resourceId, body) {
    let affected: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.pipeProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Pipe 资源不存在");
      const previous = draft.pipeProtocols[index]!;
      const updated = normalizePipeProtocol({ ...previous, ...body, id: resourceId });
      affected = resourceChangeNodeIds(draft, previous, updated);
      draft.pipeProtocols[index] = updated;
      validateInventory(draft);
      return updated;
    }, () => affected);
    event("success", `已更新 Pipe ${resource.label}`);
    return { status: 200, payload: { resource, inventory: state, deployment, events: events() } };
  },

  async deletePipe(resourceId) {
    const { state, deployment } = await mutateAndApply((draft) => {
      const resource = draft.pipeProtocols.find((item) => item.id === resourceId);
      if (!resource) fail(404, "Pipe 资源不存在");
      draft.pipeProtocols = draft.pipeProtocols.filter((item) => item.id !== resourceId);
      return resource;
    }, (resource, state) => resourceNodeIds(state, resource));
    event("success", "已删除 Pipe 资源");
    return { status: 200, payload: { inventory: state, deployment, events: events() } };
  },

  createKernel: body => saveSystem("kernels", body),
  updateKernel: (resourceId, body) => saveSystem("kernels", body, resourceId),
  deleteKernel: (resourceId, body = {}) => deleteSystem("kernels", resourceId, body),

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

  async previewStatic(body) {
    return withDeploymentLock(async () => {
      const current = await store.read();
      const previous = typeof body.id === "string" ? current.staticProtocols.find(item => item.id === body.id) : undefined;
      if (body.id !== undefined && !previous) fail(404, "Static 资源不存在");
      if (previous && body.nodeId !== undefined && body.nodeId !== previous.nodeId) fail(409, "Static 资源不可直接移动到其他节点");
      const input = { ...previous, ...body, id: previous?.id ?? makeId("static") };
      if (Object.hasOwn(body, "import") && !Object.hasOwn(body, "importPolicy")) delete input.importPolicy;
      if (previous && Object.hasOwn(body, "action") && !Object.hasOwn(body, "routeActions") && body.action !== null && body.action !== "") {
        input.routeActions = Object.fromEntries(Object.keys(previous.routeActions).map(prefix => [prefix, structuredClone(body.action) as StaticRouteAction]));
      }
      const resource = normalizeStaticProtocol(input);
      const candidate = structuredClone(current);
      const index = candidate.staticProtocols.findIndex(item => item.id === resource.id);
      if (index < 0) candidate.staticProtocols.push(resource);
      else candidate.staticProtocols[index] = resource;
      const state = validateInventory(candidate);
      const normalized = state.staticProtocols.find(item => item.id === resource.id)!;
      const node = findNode(state, resource.nodeId);
      const bundle = configBundleForNode(state, node);
      const previousConfig = configForNode(current, findNode(current, node.id));
      const probe = structuredClone(state);
      probe.staticProtocols.find(item => item.id === resource.id)!.enabled = true;
      const validation = await stageAndValidate(node, resource.enabled ? bundle : configBundleForNode(validateInventory(probe), node)).catch((e: unknown) => ({ ok: false, stdout: "", stderr: e instanceof Error ? e.message : "节点预检失败" }));
      const oldLines = previousConfig.split("\n"), newLines = bundle.main.split("\n");
      let start = 0;
      while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
      let oldEnd = oldLines.length, newEnd = newLines.length;
      while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
      const contextStart = Math.max(0, start - 3), after = Math.min(3, oldLines.length - oldEnd);
      const diff = previousConfig === bundle.main ? "无配置变化" : ["--- 当前配置", "+++ 候选配置", `@@ -${contextStart + 1},${oldEnd - contextStart + after} +${contextStart + 1},${newEnd - contextStart + after} @@`, ...oldLines.slice(contextStart, start).map(line => ` ${line}`), ...oldLines.slice(start, oldEnd).map(line => `-${line}`), ...newLines.slice(start, newEnd).map(line => `+${line}`), ...oldLines.slice(oldEnd, oldEnd + after).map(line => ` ${line}`)].join("\n");
      const previewId = randomUUID();
      for (const [id, preview] of staticPreviews) if (preview.expires < Date.now()) staticPreviews.delete(id);
      if (staticPreviews.size >= 200) staticPreviews.delete(staticPreviews.keys().next().value!);
      if (validation.ok) staticPreviews.set(previewId, { resourceId: normalized.id, signature: JSON.stringify(normalized), revision: store.revisionOf(current), expires: Date.now() + 300_000 });
      return { status: 200, payload: { valid: validation.ok, previewId, inventoryRevision: store.revisionOf(current), resource: normalized, configs: [{ nodeId: node.id, config: bundle.main, previousConfig, diff, validation }] } };
    });
  },

  async createStatic(body) {
    const reserved = body.previewId ? staticPreviews.get(String(body.previewId)) : undefined;
    const resource = normalizeStaticProtocol({ ...body, id: reserved?.resourceId ?? makeId("static") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      findNode(draft, resource.nodeId);
      draft.staticProtocols.push(resource);
      const candidate = validateInventory(draft);
      await assertStaticCandidate(body, candidate.staticProtocols.find(item => item.id === resource.id)!);
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
      if (Object.hasOwn(body, "import") && !Object.hasOwn(body, "importPolicy")) delete staticInput.importPolicy;
      if (Object.hasOwn(body, "action") && !Object.hasOwn(body, "routeActions") && body.action !== null && body.action !== "") {
        staticInput.routeActions = Object.fromEntries(
          Object.keys(previous.routeActions).map((prefix) => [prefix, structuredClone(body.action) as StaticRouteAction]),
        );
      }
      const updated = normalizeStaticProtocol(staticInput);
      draft.staticProtocols[index] = updated;
      const candidate = validateInventory(draft);
      await assertStaticCandidate(body, candidate.staticProtocols.find(item => item.id === resourceId)!);
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

  async getRpkiContext(resourceId) {
    const current = await store.read();
    const resource = current.rpki.find(item => item.id === resourceId) ?? null;
    return { status: 200, payload: { resource, inventoryRevision: store.revisionOf(current), references: resource ? rpkiReferences(current, resource) : [] } };
  },

  async previewRpki(body) {
    return withDeploymentLock(async () => {
      const current = await store.read();
      const { previous, resource, revision } = prepareRpki(current, body, body.id ? String(body.id) : undefined);
      const candidate = structuredClone(current);
      candidate.rpki = candidate.rpki.filter(item => item.id !== resource.id).concat(resource);
      const inventory = validateInventory(candidate);
      const affected = previous ? resourceChangeNodeIds(inventory, previous, resource) : resourceNodeIds(inventory, resource);
      const probe = structuredClone(inventory);
      probe.rpki.find(item => item.id === resource.id)!.enabled = true;
      const probeInventory = validateInventory(probe);
      const configs = await Promise.all(affected.map(async nodeId => {
        const node = findNode(inventory, nodeId), bundle = configBundleForNode(inventory, node);
        const config = defineConfigText(bundle);
        const validation = await stageAndValidate(node, resourceAppliesToNode(resource, nodeId) ? configBundleForNode(probeInventory, node) : bundle)
          .catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : "节点预检失败" }));
        return { nodeId, config, diff: defineDiff(defineConfigText(configBundleForNode(current, node)), config), validation };
      }));
      await assertRpkiPrepared(revision);
      const valid = configs.length > 0 && configs.every(item => item.validation.ok);
      const previewId = randomUUID(), candidateHash = rpkiHash(resource);
      for (const [id, item] of rpkiPreviews) if (item.expiresAt < Date.now()) rpkiPreviews.delete(id);
      if (rpkiPreviews.size >= 200) rpkiPreviews.delete(rpkiPreviews.keys().next().value!);
      if (valid) rpkiPreviews.set(previewId, { resource, hash: candidateHash, revision, expiresAt: Date.now() + 300_000 });
      return { status: 200, payload: { valid, previewId, candidateHash, resource, inventoryRevision: revision, references: rpkiReferences(inventory, resource), configs } };
    });
  },

  async createRpki(body) {
    const prepared = prepareRpki(await store.read(), body);
    const resource = prepared.resource;
    const { state, deployment } = await mutateAndApply(async draft => {
      await assertRpkiPrepared(prepared.revision);
      draft.rpki.push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightRPKIResource(candidate, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 RPKI 资源 ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 201, payload: { resource, inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  },

  async updateRpki(resourceId, body) {
    const prepared = prepareRpki(await store.read(), body, resourceId);
    const resource = prepared.resource;
    let affectedNodeIds: string[] = [];
    const { state, deployment } = await mutateAndApply(async draft => {
      await assertRpkiPrepared(prepared.revision);
      const index = draft.rpki.findIndex(item => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      affectedNodeIds = resourceChangeNodeIds(draft, draft.rpki[index]!, resource);
      draft.rpki[index] = resource;
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightRPKIResource(candidate, resourceId);
      return resource;
    }, () => affectedNodeIds);
    event("success", `已更新 RPKI 资源 ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 200, payload: { resource, inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  },

  async deleteRpki(resourceId, body = {}) {
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async draft => {
      assertRpkiRevision(body, await store.read());
      const index = draft.rpki.findIndex(item => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      const target = draft.rpki[index]!;
      affectedNodeIds = resourceNodeIds(draft, target);
      for (const symbol of [target.name, target.roa4Table, target.roa6Table]) {
        if (symbol && resourceReferencesSymbol(draft, symbol)) fail(409, `请先更新引用 RPKI 符号 ${symbol} 的策略`);
      }
      draft.rpki.splice(index, 1);
      return target;
    }, () => affectedNodeIds);
    event("success", `已删除 RPKI 资源 ${resource.name}`, resourceSingleNodeId(resource));
    return { status: 200, payload: { inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
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

  async getSourcePolicyContext(resourceId) {
    const current = await store.read();
    return { status: 200, payload: { resource: resourceId ? current.sourcePolicies.find(item => item.id === resourceId) ?? null : null, inventoryRevision: store.revisionOf(current) } };
  },

  async previewSourcePolicy(body) {
    const prepared = await prepareSourceCandidate(body, body.id ? String(body.id) : undefined, true);
    const preview = async () => {
      await assertSourcePrepared(prepared.revision);
      const { current, previous, resource, revision } = prepared;
      const candidate = structuredClone(current);
      const index = candidate.sourcePolicies.findIndex(item => item.id === resource.id);
      if (index < 0) candidate.sourcePolicies.push(resource); else candidate.sourcePolicies[index] = resource;
      const inventory = validateInventory(candidate);
      assertSourcePolicyAgentScope(inventory, resource, previous);
      assertSourcePolicyGatewaySafety(inventory, resource, previous);
      const manualPlans = sourcePolicyPlans(inventory, resource, previous, previous ? "update" : "create");
      // Automatic sketches never stage configuration or apply system rules.
      if (body.mode === "plan") return { status: 200, payload: { resource, inventoryRevision: revision, manualPlans } };
      const probe = structuredClone(inventory);
      probe.sourcePolicies.find(item => item.id === resource.id)!.enabled = true;
      const enabledProbe = validateInventory(probe);
      const affected = previous ? resourceChangeNodeIds(inventory, previous, resource) : resourceNodeIds(inventory, resource);
      const configs = await Promise.all(affected.map(async nodeId => {
        const node = findNode(inventory, nodeId), bundle = configBundleForNode(inventory, node);
        const config = defineConfigText(bundle);
        const validation = await stageAndValidate(node, resourceAppliesToNode(resource, nodeId) ? configBundleForNode(enabledProbe, node) : bundle)
          .catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
        return { nodeId, config, diff: configDiff(defineConfigText(configBundleForNode(current, node)), config), validation };
      }));
      await assertSourcePrepared(revision);
      const valid = configs.length > 0 && configs.every(item => item.validation.ok);
      const previewId = randomUUID(), candidateHash = sourceHash(resource);
      for (const [key, value] of sourcePreviews) if (value.expires < Date.now()) sourcePreviews.delete(key);
      if (sourcePreviews.size >= 200) sourcePreviews.delete(sourcePreviews.keys().next().value!);
      if (valid) sourcePreviews.set(previewId, { resource: structuredClone(resource), hash: candidateHash, revision, expires: Date.now() + 300_000 });
      return { status: 200, payload: { valid, resource, inventoryRevision: revision, previewId, candidateHash, configs, manualPlans } };
    };
    return body.mode === "plan" ? preview() : withDeploymentLock(preview);
  },

  async createSourcePolicy(body) {
    const prepared = await prepareSourceCandidate(body);
    let current: SourcePolicyEgress | null = null;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      await assertSourcePrepared(prepared.revision);
      const created = prepared.resource;
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
    return { status: 201, payload: { resource: applied, inventory: state, inventoryRevision: store.revisionOf(state), deployment, manualPlans, events: events() } };
  },

  async updateSourcePolicy(resourceId, body) {
    const prepared = await prepareSourceCandidate(body, resourceId);
    let affectedNodeIds: string[] = [];
    let previous: SourcePolicyEgress | null = null;
    let updatedForSync: SourcePolicyEgress | null = null;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      await assertSourcePrepared(prepared.revision);
      const index = draft.sourcePolicies.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "源地址出口映射不存在");
      const existing = draft.sourcePolicies[index];
      if (!existing) fail(404, "源地址出口映射不存在");
      previous = structuredClone(existing);
      const updated = prepared.resource;
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
    return { status: 200, payload: { resource: applied, inventory: state, inventoryRevision: store.revisionOf(state), deployment, manualPlans, events: events() } };
  },

  async deleteSourcePolicy(resourceId, body = {}) {
    let affectedNodeIds: string[] = [];
    let deletedForSync: SourcePolicyEgress | null = null;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      assertSourceRevision(body, await store.read());
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
    return { status: 200, payload: { inventory: state, inventoryRevision: store.revisionOf(state), deployment, manualPlans, events: events() } };
  },

  async getPolicyContext(kind, resourceId) {
    const current = await store.read();
    const resource = resourceId ? policyResources(current, kind).find(item => item.id === resourceId) ?? null : null;
    return { status: 200, payload: { resource, inventoryRevision: store.revisionOf(current), references: resource ? policyResourceReferences(current, resource, kind) : [] } };
  },
  async previewPolicy(kind, body) {
    const prepared = await preparePolicy(kind, body, body.id ? String(body.id) : undefined);
    return withDeploymentLock(async () => {
      await assertPreparedPolicy(prepared);
      const { current, previous, resource, revision } = prepared;
      const candidate = structuredClone(current);
      const resources = policyResources(candidate, kind);
      const index = resources.findIndex(item => item.id === resource.id);
      if (index < 0) resources.push(resource); else resources[index] = resource;
      const inventory = validateInventory(candidate);
      const probe = structuredClone(inventory);
      policyResources(probe, kind).find(item => item.id === resource.id)!.enabled = true;
      const enabledProbe = validateInventory(probe);
      const affected = previous ? resourceChangeNodeIds(inventory, previous, resource) : resourceNodeIds(inventory, resource);
      const configs = await Promise.all(affected.map(async nodeId => {
        const node = findNode(inventory, nodeId), bundle = configBundleForNode(inventory, node);
        const config = defineConfigText(bundle);
        const validation = await stageAndValidate(node, resourceAppliesToNode(resource, nodeId) ? configBundleForNode(enabledProbe, node) : bundle)
          .catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
        return { nodeId, config, diff: configDiff(defineConfigText(configBundleForNode(current, node)), config), validation };
      }));
      const valid = configs.length > 0 && configs.every(item => item.validation.ok);
      const previewId = randomUUID(), candidateHash = policyHash(resource);
      for (const [key, value] of policyPreviews) if (value.expires < Date.now()) policyPreviews.delete(key);
      if (policyPreviews.size >= 200) policyPreviews.delete(policyPreviews.keys().next().value!);
      if (valid) policyPreviews.set(previewId, { kind, resource, hash: candidateHash, revision, expires: Date.now() + 300_000 });
      return { status: 200, payload: { valid, resource, inventoryRevision: revision, previewId, candidateHash, configs, references: policyResourceReferences(inventory, resource, kind), changes: { added: [], removed: [], addedCount: 0, removedCount: 0 } } };
    });
  },

  async getDefineContext(resourceId) {
    const current = await store.read();
    const resource = resourceId ? current.defines.find(item => item.id === resourceId) ?? null : null;
    return { status: 200, payload: { inventoryRevision: store.revisionOf(current), resource, references: resource ? defineReferences(current, resource) : [] } };
  },

  async previewDefine(body) {
    const prepared = await prepareDefine(body, body.id ? String(body.id) : undefined);
    return withDeploymentLock(async () => {
      await assertPreparedDefine(prepared);
      const { current, previous, resource, revision } = prepared;
      const candidate = structuredClone(current);
      const index = candidate.defines.findIndex(item => item.id === resource.id);
      if (index < 0) candidate.defines.push(resource);
      else candidate.defines[index] = resource;
      const inventory = validateInventory(candidate);
      const affected = previous ? resourceChangeNodeIds(inventory, previous, resource) : resourceNodeIds(inventory, resource);
      const probe = structuredClone(inventory);
      if (!resource.enabled) probe.defines.find(item => item.id === resource.id)!.enabled = true;
      const probeInventory = validateInventory(probe);
      const configs = await Promise.all(affected.map(async nodeId => {
        const node = findNode(inventory, nodeId);
        const bundle = configBundleForNode(inventory, node);
        const config = defineConfigText(bundle);
        const validation = await stageAndValidate(node, resourceAppliesToNode(resource, nodeId) ? configBundleForNode(probeInventory, node) : bundle)
          .catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : "节点预检失败" }));
        return { nodeId, config, diff: defineDiff(defineConfigText(configBundleForNode(current, findNode(current, nodeId))), config), validation };
      }));
      const oldEntries = new Set(previous && previous.type !== "expression" ? previous.entries : []);
      const newEntries = new Set(resource.type !== "expression" ? resource.entries : []);
      const added = [...newEntries].filter(entry => !oldEntries.has(entry)), removed = [...oldEntries].filter(entry => !newEntries.has(entry));
      const valid = configs.length > 0 && configs.every(item => item.validation.ok);
      const previewId = randomUUID(), candidateHash = defineHash(resource);
      for (const [id, preview] of definePreviews) if (preview.expiresAt < Date.now()) definePreviews.delete(id);
      if (definePreviews.size >= 100) definePreviews.delete(definePreviews.keys().next().value!);
      if (valid) definePreviews.set(previewId, { resource, hash: candidateHash, revision, expiresAt: Date.now() + 300_000 });
      return { status: 200, payload: { valid, previewId, candidateHash, resource, inventoryRevision: revision, references: defineReferences(inventory, resource), changes: { added: added.slice(0, 200), removed: removed.slice(0, 200), addedCount: added.length, removedCount: removed.length }, configs } };
    });
  },

  async createPolicy(collection, body) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    const idPrefix = collection === "functions" ? "function" : collection === "filters" ? "filter" : "define";
    const preparedSource = collection !== "defines" ? await preparePolicy(collection, body) : null;
    const prepared = collection === "defines" ? await prepareDefine(body) : null;
    const resource = prepared?.resource ?? preparedSource?.resource ?? normalizePolicyResource(collection, { ...body, id: makeId(idPrefix) });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      if (prepared) await assertPreparedDefine(prepared);
      if (preparedSource) await assertPreparedPolicy(preparedSource);
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
    const preparedSource = collection !== "defines" ? await preparePolicy(collection, body, resourceId) : null;
    const prepared = collection === "defines" ? await prepareDefine(body, resourceId) : null;
    const materializedBody: Record<string, unknown> = prepared ? { ...prepared.resource } : preparedSource ? { ...preparedSource.resource } : body;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      if (prepared) await assertPreparedDefine(prepared);
      if (preparedSource) await assertPreparedPolicy(preparedSource);
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
      if ((collection === "defines" || collection === "functions") && updated.name !== previous.name && resourceReferencesSymbol(draft, previous.name, resourceId, previous)) {
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

  async deletePolicy(collection, resourceId, body = {}) {
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    let affectedNodeIds: string[] = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      if (collection === "defines") assertDefineRevision(body, await store.read());
      else assertPolicyRevision(body, await store.read());
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
      if (collection === "functions" || collection === "filters") {
        const referencedByPipe = draft.pipeProtocols.some((pipe) => [pipe.importPolicy, pipe.exportPolicy].some((policy) =>
          collection === "filters" ? policy.filterId === target.id : policy.steps.some((step) => step.type === "function" && step.functionId === target.id)));
        if (referencedByPipe) fail(409, `请先从 Pipe 资源中移除该 ${kind}`);
      }
      if (collection === "functions" || collection === "filters") {
        const referencedByStatic = draft.staticProtocols.some(item => item.importPolicy && (collection === "filters" ? item.importPolicy.filterId === target.id : item.importPolicy.steps.some(step => step.type === "function" && step.functionId === target.id)));
        if (referencedByStatic) fail(409, `请先从 Static 资源中移除该 ${kind}`);
      }
      const referencedByKernel = draft.kernelProtocols.some((kernel) => {
        const exportPolicies = kernel.exportPolicies
          ? Object.values(kernel.exportPolicies).filter((item) => item.mode === "visual").map((item) => item.policy)
          : [kernel.exportPolicy];
        const policies = [...Object.values(kernel.importPolicies ?? { legacy: kernel.importPolicy }), ...exportPolicies];
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
      if (collection === "defines" && draft.sourcePolicies.some(item => item.internalDefineIds.includes(target.id))) {
        fail(409, "请先从源地址出口映射中移除该 Define");
      }
      if ((collection === "defines" || collection === "functions") && resourceReferencesSymbol(draft, target.name, target.id, target)) {
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

  async syncIrrDefine(resourceId, body = {}) {
    const before = await store.read();
    if (body.inventoryRevision !== undefined) assertDefineRevision(body, before);
    const define = before.defines.find((item) => item.id === resourceId);
    if (!define || define.type === "expression") fail(404, "CIDR Define 不存在");
    if (define.entrySource.kind !== "irr-as-set") fail(409, "该 Define 不是 AS-SET 自动来源");
    const syncSignature = (resource: PolicyDefine) => JSON.stringify([resource.type, resource.nodeIds, resource.enabled, resource.type === "expression" ? null : resource.entrySource]);
    const signature = syncSignature(define);
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
        if (syncSignature(current) !== signature) return null;
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
      if (syncSignature(current) !== signature) fail(409, "AS-SET 来源、地址族或节点范围在同步期间已被修改，请重新同步");
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
            if (syncSignature(current) !== signature) return null;
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
    return { status: 200, payload: { domains, inventoryRevision: store.revisionOf(state), inventory: { ...state, ibgpDomains: domains } } };
  },

  async previewIbgpDomain(body) {
    return withDeploymentLock(async () => {
      const current = await store.read();
      assertIbgpRevision(body, current);
      const requestedId = body.id ? String(body.id) : undefined;
      const previous = current.ibgpDomains.find(item => item.id === requestedId);
      const candidate = ibgpCandidate(current, body, previous);
      const revision = store.revisionOf(current);
      const configs = await Promise.all(candidate.affected.map(async nodeId => {
        const node = findNode(candidate.inventory, nodeId);
        const bundle = configBundleForNode(candidate.inventory, node);
        const config = defineConfigText(bundle);
        const previousConfig = defineConfigText(configBundleForNode(current, findNode(current, nodeId)));
        let validation: Awaited<ReturnType<typeof stageAndValidate>>;
        try { validation = await stageAndValidate(node, bundle); }
        catch (cause) { validation = { ok: false, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), code: "NODE_CHECK_FAILED" }; }
        return { nodeId, nodeName: node.name, config, previousConfig, diff: configDiff(previousConfig, config), validation };
      }));
      const sides: IbgpPreviewSide[] = candidate.sessions.map(session => {
        const entry = configs.find(item => item.nodeId === session.nodeId)!;
        const adjacency = candidate.domain.adjacencies.find(item => item.id === session.managedBy?.adjacencyId)!;
        return { side: adjacency.leftSessionId === session.id ? "left" : "right", nodeId: session.nodeId, nodeName: entry.nodeName,
          session, config: bgpProtocolBlock(entry.config, session.protocolName), validation: entry.validation };
      });
      const valid = configs.every(item => item.validation.ok);
      const candidateHash = ibgpHash(candidate.domain, candidate.sessions);
      const previewId = randomUUID();
      if (valid) {
        for (const [key, value] of ibgpPreviews) if (value.expiresAt < Date.now()) ibgpPreviews.delete(key);
        if (ibgpPreviews.size >= 200) ibgpPreviews.delete(ibgpPreviews.keys().next().value!);
        ibgpPreviews.set(previewId, { domain: candidate.domain, sessions: candidate.sessions, hash: candidateHash, revision, expiresAt: Date.now() + 300_000 });
      }
      return { status: 200, payload: { valid, domain: candidate.domain, sessions: candidate.sessions, sides, configs, inventoryRevision: revision, previewId, candidateHash } };
    });
  },

  async createIbgpDomain(body) { return saveIbgp(body); },
  async updateIbgpDomain(domainId, body) { return saveIbgp(body, domainId); },

  async deleteIbgpDomain(domainId, body = {}) {
    let affectedNodeIds: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply(async draft => {
      assertIbgpRevision(body, await store.read());
      const index = draft.ibgpDomains.findIndex(item => item.id === domainId);
      const target = draft.ibgpDomains[index];
      if (!target) fail(404, "iBGP 域不存在");
      affectedNodeIds = domainNodeIds(target);
      draft.ibgpDomains.splice(index, 1);
      draft.peers = draft.peers.filter(peer => peer.managedBy?.domainId !== domainId);
      draft.sessions = draft.sessions.filter(session => session.managedBy?.domainId !== domainId);
      return target;
    }, () => affectedNodeIds);
    event("success", `已删除 iBGP 域 ${domain.name}`);
    return { status: 200, payload: { inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  },

  async updateIbgpDomainLayout(domainId, body) {
    // Layout persistence does not stage or deploy routing configuration.
    const { state, result: domain } = await store.mutate(draft => {
      const target = draft.ibgpDomains.find(item => item.id === domainId);
      if (!target) fail(404, "iBGP 域不存在");
      if (!body.layout || typeof body.layout !== "object" || Array.isArray(body.layout)) fail(400, "拓扑布局必须是对象");
      target.layout = normalizeIbgpDomain({ ...target, layout: body.layout }).layout;
      return target;
    });
    return { status: 200, payload: { domain, inventory: state, inventoryRevision: store.revisionOf(state) } };
  },

  async listOspfDomains() {
    const state = await store.read();
    const [drafts, layouts] = await Promise.all([store.readOspfDrafts(), store.readOspfLayouts()]);
    const domains = state.ospfDomains.map(domain => toOspfDomainModel({ ...domain, layout: { ...domain.layout, ...layouts[`domain:${domain.id}`] } }));
    for (const { domain } of Object.values(drafts)) if (!domains.some(item => item.id === domain.id)) domains.push(toOspfDomainModel(domain));
    const layout = validateInventory({ ...state, ospfLayout: { ...state.ospfLayout, ...layouts.global } }).ospfLayout;
    return { status: 200, payload: { domains, drafts, layout, inventoryRevision: store.revisionOf(state), inventory: state } };
  },

  async updateOspfLayout(body) {
    if (!body.layout || typeof body.layout !== "object" || Array.isArray(body.layout)) fail(400, "拓扑布局必须是对象");
    const state = await store.read();
    const layout = validateInventory({ ...state, ospfDomains: [], ospfLayout: body.layout }).ospfLayout;
    const saved = await store.saveOspfLayout("global", layout);
    return { status: 200, payload: { layout: saved, inventoryRevision: store.revisionOf(state) } };
  },

  async previewOspfDomain(body) {
    return withDeploymentLock(async () => {
      const { domain, inventory, affected } = await ospfCandidate(body);
      const current = await store.read();
      const configs = await Promise.all(affected.map(async nodeId => {
        const node = findNode(inventory, nodeId);
        const bundle = configBundleForNode(inventory, node);
        const config = defineConfigText(bundle);
        const previous = defineConfigText(configBundleForNode(current, findNode(current, nodeId)));
        const unified = configDiff(previous, config);
        return { nodeId, config,
          diff: { changed: previous !== config, added: unified.split("\n").filter(line => line.startsWith("+ ")).length, removed: unified.split("\n").filter(line => line.startsWith("- ")).length, unified },
          validation: await stageAndValidate(node, bundle).catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : "节点预检失败", code: "NODE_PREFLIGHT_ERROR" })),
        };
      }));
      const valid = configs.every((item) => item.validation.ok);
      const previewId = randomUUID();
      const candidateHash = ospfCandidateHash(domain);
      const now = Date.now();
      for (const [id, ticket] of ospfPreviews) if (ticket.expiresAt < now) ospfPreviews.delete(id);
      if (ospfPreviews.size >= 100) ospfPreviews.delete(ospfPreviews.keys().next().value!);
      if (valid) ospfPreviews.set(previewId, { domain, hash: candidateHash, revision: store.revisionOf(current), expiresAt: now + 300_000 });
      return {
        status: 200,
        payload: {
          valid, previewId, candidateHash, inventoryRevision: store.revisionOf(current),
          diagnostics: configs.flatMap((item) => item.validation.ok ? [] : [{ nodeId: item.nodeId, message: item.validation.stderr || item.validation.stdout || "节点预检失败", code: item.validation.code ?? null }]),
          domain: toOspfDomainModel(domain),
          configs,
        },
      };
    });
  },

  async renderOspfDomain(body) {
    const { domain, inventory, affected } = await ospfCandidate(body);
    const configs = affected.map((nodeId) => ({ nodeId, config: defineConfigText(configBundleForNode(inventory, findNode(inventory, nodeId))) }));
    return { status: 200, payload: { domain: toOspfDomainModel(domain), configs } };
  },

  async createOspfDomain(body) {
    return body.mode === "draft" ? saveOspfDraft(body) : saveOspf(body);
  },

  async updateOspfDomain(domainId, body) {
    return body.mode === "draft" ? saveOspfDraft(body, domainId) : saveOspf(body, domainId);
  },

  async deleteOspfDomain(domainId, body = {}) {
    if (!(await store.read()).ospfDomains.some(item => item.id === domainId)) {
      return withDeploymentLock(async () => {
        await assertOspfRevision(body);
        const current = await store.read();
        if (current.ospfDomains.some(item => item.id === domainId)) fail(409, "此域刚刚已应用，请对比后重新删除", "STATE_CONFLICT");
        if (!(await store.readOspfDrafts())[domainId]) fail(404, "OSPF 域不存在");
        await store.deleteOspfDraft(domainId);
        return { status: 200, payload: { inventory: current, inventoryRevision: store.revisionOf(current), deployment: { applied: false, nodeIds: [], nodes: [], sessions: [] }, events: events() } };
      });
    }
    let affected: string[] = [];
    const { state, result: domain, deployment } = await mutateAndApply(async (draft) => {
      await assertOspfRevision(body);
      const index = draft.ospfDomains.findIndex((item) => item.id === domainId);
      if (index < 0) fail(404, "OSPF 域不存在");
      const target = draft.ospfDomains[index];
      if (!target) fail(404, "OSPF 域不存在");
      affected = ospfDomainNodeIds(target); draft.ospfDomains.splice(index, 1); return target;
    }, () => affected);
    await store.deleteOspfDraft(domain.id);
    event("success", `已删除 OSPF 域 ${domain.name}`);
    return { status: 200, payload: { inventory: state, inventoryRevision: store.revisionOf(state), deployment, events: events() } };
  },

  async updateOspfDomainLayout(domainId, body) {
    const state = await store.read(), target = state.ospfDomains.find(item => item.id === domainId);
    if (!target) fail(404, "OSPF 域不存在");
    if (!body.layout || typeof body.layout !== "object" || Array.isArray(body.layout)) fail(400, "拓扑布局必须是对象");
    const layout = Object.fromEntries(Object.entries(body.layout).filter(([nodeId]) => target.nodeConfigs.some(config => config.nodeId === nodeId)));
    const normalized = normalizeOspfDomain({ ...target, layout }).layout;
    const saved = await store.saveOspfLayout(`domain:${domainId}`, normalized);
    return { status: 200, payload: { domain: toOspfDomainModel({ ...target, layout: { ...target.layout, ...saved } }), inventoryRevision: store.revisionOf(state) } };
  },

    previewSession: (body) => options.sessions.preview(body),
    getSessionContext: (nodeId, peerId) => options.sessions.editorContext(nodeId, peerId),
    applySession: (body) => options.sessions.apply(body),
    deleteSession: (sessionId, body) => options.sessions.delete(sessionId, body),
  };
}
