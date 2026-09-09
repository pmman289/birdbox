import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { DeploymentReport } from "../packages/contracts/src/api.js";
import type { Inventory, ManagedNode } from "../packages/contracts/src/inventory.js";
import {
  applyStagedConfig,
  normalizeNode,
  rollbackNode,
  stageAndValidate,
  validateInventory,
} from "./bird.js";
import type { StateDatabase } from "./database.js";
import { uniqueNodeIds } from "./resource-impact.js";
import type { InventoryStore } from "./store.js";
import type { NodeConfigBundle } from "./config-bundle.js";
import { errorContext, logger } from "./logger.js";

type UnknownRecord = Record<string, unknown>;
type DeploymentDirection = "forward" | "rollback";

interface DeploymentTarget {
  node: ManagedNode;
  config: NodeConfigBundle;
}

export interface DeploymentHooks {
  apply?(node: ManagedNode, inventory: Inventory): Promise<void>;
  rollback?(node: ManagedNode, inventory: Inventory): Promise<void>;
}

export interface ActiveDeploymentJournal {
  id: string;
  direction: DeploymentDirection;
  before: Inventory;
  after: Inventory;
  forwardTargets: DeploymentTarget[];
  rollbackTargets: DeploymentTarget[];
}

interface DeploymentJournal {
  version: 1;
  active: ActiveDeploymentJournal | null;
}

interface DeploymentServiceOptions {
  database: StateDatabase;
  store: InventoryStore;
  withDeploymentLock<Result>(
    operation: () => Promise<Result> | Result,
    options?: { allowPendingJournal?: boolean },
  ): Promise<Result>;
  configForNode(inventory: Inventory, node: ManagedNode): NodeConfigBundle;
  emptyConfigForNode(node: ManagedNode): NodeConfigBundle;
  findNode(inventory: Inventory, nodeId: string): ManagedNode;
  validationError(config: string, diagnostic: unknown, fallback: string): string;
  addEvent(level: string, message: unknown, nodeId?: string | null): unknown;
  fail(status: number, message: string): never;
}

const DEPLOYMENT_JOURNAL_KEY = "deployment_journal";
const EMPTY_DEPLOYMENT_JOURNAL: DeploymentJournal = Object.freeze({ version: 1, active: null });
const INVENTORY_COMMIT_RETRIES = 3;

export class DeploymentService {
  readonly #options: DeploymentServiceOptions;

  constructor(options: DeploymentServiceOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    await this.#options.database.createState(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL);
  }

  async readJournal(): Promise<DeploymentJournal> {
    const record = await this.#options.database.readState<unknown>(DEPLOYMENT_JOURNAL_KEY);
    return this.#validateJournal(record?.value ?? EMPTY_DEPLOYMENT_JOURNAL);
  }

  async beginJournal(
    before: Inventory,
    after: Inventory,
    nodeIds: string[],
    fallbackNodes: ManagedNode[] = [],
  ): Promise<ActiveDeploymentJournal> {
    const forwardTargets = this.#targets(after, nodeIds, fallbackNodes);
    const rollbackTargets = this.#targets(before, nodeIds, fallbackNodes);
    this.#markRemovedResources(forwardTargets, rollbackTargets);
    this.#markRemovedResources(rollbackTargets, forwardTargets);
    const active: ActiveDeploymentJournal = {
      id: `deployment_${randomUUID()}`,
      direction: "forward",
      before,
      after,
      forwardTargets,
      rollbackTargets,
    };
    await this.#options.database.mutateState<DeploymentJournal, void>(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL, (current) => {
      const journal = this.#validateJournal(current);
      if (journal.active) this.#options.fail(503, "存在尚未完成的部署恢复任务，请重启服务完成恢复");
      return { value: { version: 1, active } };
    });
    logger.info("已创建部署恢复记录", { deploymentId: active.id, nodeCount: forwardTargets.length, nodeIds: forwardTargets.map((target) => target.node.id).join(",") });
    return active;
  }

  async setJournalDirection(active: ActiveDeploymentJournal, direction: DeploymentDirection): Promise<void> {
    await this.#options.database.mutateState<DeploymentJournal, void>(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL, (current) => {
      const journal = this.#validateJournal(current);
      if (journal.active?.id !== active.id) throw new Error("部署恢复日志已被意外替换");
      return { value: { version: 1, active: { ...journal.active, direction } } };
    });
  }

  async clearJournal(active: ActiveDeploymentJournal): Promise<void> {
    await this.#options.database.mutateState<DeploymentJournal, void>(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL, (current) => {
      const journal = this.#validateJournal(current);
      if (journal.active?.id !== active.id) throw new Error("部署恢复日志已被意外替换");
      return { value: { version: 1, active: null } };
    });
  }

  async recover(): Promise<void> {
    return this.#options.withDeploymentLock(async () => {
      const journal = await this.readJournal();
      const active = journal.active;
      if (!active) return;
      logger.warn("开始恢复未完成部署", { deploymentId: active.id, direction: active.direction });
      const actual = await this.#options.store.read();
      const desired = active.direction === "forward" ? active.after : active.before;
      const opposite = active.direction === "forward" ? active.before : active.after;
      if (!isDeepStrictEqual(actual, desired) && !isDeepStrictEqual(actual, opposite)) {
        throw new Error("库存与未完成部署日志均不匹配；拒绝自动覆盖，请从备份恢复");
      }
      const needsRemoteReplay = active.direction === "rollback" || !isDeepStrictEqual(actual, desired);
      if (needsRemoteReplay) {
        const targets = active.direction === "forward" ? active.forwardTargets : active.rollbackTargets;
        for (const target of targets) {
          const validation = await stageAndValidate(target.node, target.config);
          if (!validation.ok) throw new Error(validation.stderr || validation.stdout || `${target.node.name} 的恢复配置检查失败`);
        }
        for (const target of targets) {
          const applied = await applyStagedConfig(target.node, target.config);
          if (!applied.ok) throw new Error(applied.stderr || applied.stdout || `${target.node.name} 的恢复配置应用失败`);
        }
      }
      if (!isDeepStrictEqual(actual, desired)) await this.#options.store.replace(actual, desired);
      await this.clearJournal(active);
      this.#options.addEvent("warning", `已完成中断部署 ${active.id} 的${active.direction === "forward" ? "提交" : "回滚"}恢复`);
      logger.info("未完成部署恢复完成", { deploymentId: active.id, direction: active.direction });
    }, { allowPendingJournal: true });
  }

  async mutateAndApply<Result>(
    mutator: (draft: Inventory) => Promise<Result> | Result,
    nodeIdsForDraft: string[] | ((result: Result, inventory: Inventory) => string[]),
    hooks: DeploymentHooks = {},
  ): Promise<{ state: Inventory; result: Result; deployment: DeploymentReport }> {
    return this.#options.withDeploymentLock(async () => {
      for (let attempt = 0; attempt < INVENTORY_COMMIT_RETRIES; attempt += 1) {
        const attemptedNodes: ManagedNode[] = [];
        let committed = false;
        let journal: ActiveDeploymentJournal | null = null;
        let current: Inventory | null = null;
        try {
          logger.info("开始部署变更", { attempt: attempt + 1, maxAttempts: INVENTORY_COMMIT_RETRIES });
          current = await this.#options.store.read();
          const draft = structuredClone(current);
          const mutation = await mutator(draft);
          const inventory = validateInventory(draft);
          const nodeIds = uniqueNodeIds(typeof nodeIdsForDraft === "function" ? nodeIdsForDraft(mutation, inventory) : nodeIdsForDraft);
          const nodes = nodeIds.map((nodeId) => this.#options.findNode(inventory, nodeId));
          logger.info("开始检查部署候选配置", { nodeCount: nodes.length, nodeIds: nodeIds.join(",") });

          for (const node of nodes) {
            const config = this.#options.configForNode(inventory, node);
            const validation = await stageAndValidate(node, config);
            if (!validation.ok) this.#options.fail(422, this.#options.validationError(config.main, validation.stderr || validation.stdout, `${node.name} 的 BIRD 语法检查失败`));
          }
          if (nodes.length) journal = await this.beginJournal(current, inventory, nodeIds, nodes);
          for (const node of nodes) {
            attemptedNodes.push(node);
            const target = journal?.forwardTargets.find((item) => item.node.id === node.id);
            const applied = await applyStagedConfig(node, target?.config ?? this.#options.configForNode(inventory, node));
            if (!applied.ok) this.#options.fail(500, applied.stderr || applied.stdout || `${node.name} 的 BIRD 配置应用失败`);
            logger.info("节点配置已应用", { nodeId: node.id, nodeName: node.name });
            if (hooks.apply) await hooks.apply(node, inventory);
          }
          const state = await this.#options.store.replace(current, inventory);
          committed = true;
          if (journal) {
            await this.clearJournal(journal);
            journal = null;
          }
          logger.info("部署变更已提交", { nodeCount: nodes.length, nodeIds: nodeIds.join(",") });
          return { state, result: mutation, deployment: this.#report(inventory, nodeIds) };
        } catch (error) {
          const code = (error as Partial<{ code: unknown }>).code;
          const retryableConflict = code === "STATE_CONFLICT" && attempt + 1 < INVENTORY_COMMIT_RETRIES;
          const failureContext = { ...errorContext(error), attemptedNodeIds: attemptedNodes.map((node) => node.id).join(","), attempt: attempt + 1 };
          if (retryableConflict) logger.warn("部署提交检测到库存 revision 冲突，准备回滚并重试", failureContext);
          else logger.error("部署变更失败", failureContext);
          if (!committed) {
            let journalMarkedForRollback = false;
            if (journal) {
              try {
                await this.setJournalDirection(journal, "rollback");
                journalMarkedForRollback = true;
              } catch (journalError) {
                logger.error("部署回滚标记失败", { ...errorContext(journalError) });
              }
            }
            let rollbackSucceeded = true;
            for (const node of attemptedNodes.reverse()) {
              const target = journal?.forwardTargets.find((item) => item.node.id === node.id);
              const rollback = await rollbackNode(node, target?.config ?? { main: "", resources: [] });
              if (!rollback.ok) {
                rollbackSucceeded = false;
                this.#options.addEvent("error", `${node.name} 回滚失败：${rollback.stderr || rollback.stdout}`, node.id);
              }
              else logger.info("节点配置已回滚", { nodeId: node.id, nodeName: node.name });
              if (hooks.rollback) {
                try {
                  await hooks.rollback(node, current!);
                } catch (hookError) {
                  rollbackSucceeded = false;
                  this.#options.addEvent("error", `${node.name} 系统规则回滚失败：${hookError instanceof Error ? hookError.message : String(hookError)}`, node.id);
                }
              }
            }
            if (journal && journalMarkedForRollback && rollbackSucceeded) {
              try {
                await this.clearJournal(journal);
                journal = null;
              } catch (journalError) {
                logger.error("部署恢复记录清理失败", { ...errorContext(journalError) });
              }
            }
            if (code === "STATE_CONFLICT" && rollbackSucceeded && journal === null && attempt + 1 < INVENTORY_COMMIT_RETRIES) {
              logger.warn("库存 revision 在部署期间变化，已回滚远端并重试", { attempt: attempt + 1, nextAttempt: attempt + 2 });
              await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
              continue;
            }
          }
          throw error;
        }
      }
      throw new Error("部署重试次数超限");
    });
  }

  #targets(inventory: Inventory, nodeIds: string[], fallbackNodes: ManagedNode[]): DeploymentTarget[] {
    const fallbackById = new Map(fallbackNodes.map((node) => [node.id, node]));
    return uniqueNodeIds(nodeIds).map((nodeId) => {
      const inventoryNode = inventory.nodes.find((node) => node.id === nodeId);
      const node = inventoryNode ?? fallbackById.get(nodeId);
      if (!node) this.#options.fail(500, `部署日志无法解析节点 ${nodeId}`);
      return {
        node,
        config: inventoryNode ? this.#options.configForNode(inventory, inventoryNode) : this.#options.emptyConfigForNode(node),
      };
    });
  }

  #markRemovedResources(targets: DeploymentTarget[], previousTargets: DeploymentTarget[]): void {
    const previousByNode = new Map(previousTargets.map((target) => [target.node.id, target]));
    for (const target of targets) {
      const current = new Set(target.config.resources.map((resource) => resource.relativePath));
      target.config.removedResources = (previousByNode.get(target.node.id)?.config.resources ?? [])
        .map((resource) => resource.relativePath)
        .filter((relativePath) => !current.has(relativePath));
    }
  }

  #validateJournal(value: unknown): DeploymentJournal {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
    if (!input || input.version !== 1 || !Object.hasOwn(input, "active")) throw new Error("部署恢复日志格式不兼容");
    if (input.active === null) return { version: 1, active: null };
    const active = input.active && typeof input.active === "object" && !Array.isArray(input.active)
      ? input.active as UnknownRecord
      : null;
    if (!active || typeof active.id !== "string" || (active.direction !== "forward" && active.direction !== "rollback")) {
      throw new Error("部署恢复日志内容不合法");
    }
    const before = validateInventory(active.before);
    const after = validateInventory(active.after);
    const normalizeTargets = (targets: unknown): DeploymentTarget[] => {
      if (!Array.isArray(targets)) throw new Error("部署恢复日志缺少节点目标");
      const seen = new Set<string>();
      return targets.map((targetValue) => {
        const target = targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)
          ? targetValue as UnknownRecord
          : null;
        const node = normalizeNode(target?.node);
        const configValue = target?.config;
        const config = typeof configValue === "string"
          ? { main: configValue, resources: [] }
          : configValue && typeof configValue === "object" && !Array.isArray(configValue)
            ? configValue as unknown as NodeConfigBundle
            : null;
        if (seen.has(node.id) || !config || typeof config.main !== "string" || !Array.isArray(config.resources)
          || config.resources.some((resource) => !resource || typeof resource.relativePath !== "string" || typeof resource.content !== "string")) {
          throw new Error("部署恢复日志节点目标不合法");
        }
        config.removedResources = Array.isArray(config.removedResources) && config.removedResources.every((item) => typeof item === "string")
          ? config.removedResources : [];
        seen.add(node.id);
        return { node, config };
      });
    };
    return {
      version: 1,
      active: {
        id: active.id,
        direction: active.direction,
        before,
        after,
        forwardTargets: normalizeTargets(active.forwardTargets),
        rollbackTargets: normalizeTargets(active.rollbackTargets),
      },
    };
  }

  #report(inventory: Inventory, nodeIds: string[]): DeploymentReport {
    const ids = uniqueNodeIds(nodeIds);
    return {
      applied: true,
      nodeIds: ids,
      nodes: inventory.nodes.filter((node) => ids.includes(node.id)).map((node) => ({ id: node.id, name: node.name })),
      sessions: inventory.sessions
        .filter((session) => ids.includes(session.nodeId))
        .map((session) => ({ id: session.id, nodeId: session.nodeId, protocolName: session.protocolName })),
    };
  }
}
