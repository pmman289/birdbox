import type { ChangeEvent, NodeRuntime, ProtocolRuntime } from "../packages/contracts/src/api.js";
import type {
  BgpSession,
  CidrDefine,
  Inventory,
  ManagedNode,
  Peer,
} from "../packages/contracts/src/inventory.js";
import {
  applyStagedConfig,
  inspectNode,
  normalizeSession,
  rollbackNode,
  stageAndValidate,
  validateInventory,
} from "./bird.js";
import { protocolFor } from "./dashboard-service.js";
import type { ActiveDeploymentJournal, DeploymentService } from "./deployment-service.js";
import { fail, optionalRecord, record, safeErrorMessage, type UnknownRecord } from "./errors.js";
import { configForNode, findNode, findPeer, findPolicyResource } from "./inventory-domain.js";
import type { InventoryStore } from "./store.js";

interface PreparedSession {
  inventory: Inventory;
  node: ManagedNode;
  peer: Peer;
  exportDefines: Record<"ipv4" | "ipv6", CidrDefine | null>;
  session: BgpSession;
  config: string;
}

interface StagedSession extends PreparedSession {
  validation: Awaited<ReturnType<typeof stageAndValidate>>;
  valid: boolean;
}

interface SessionApplicationServiceOptions {
  store: InventoryStore;
  deploymentService: DeploymentService;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  makeId(prefix: string): string;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
}

export class SessionApplicationService {
  readonly #options: SessionApplicationServiceOptions;

  constructor(options: SessionApplicationServiceOptions) {
    this.#options = options;
  }

  async preview(body: Record<string, unknown>) {
    const staged = await this.#options.withDeploymentLock(async () =>
      this.#stageSession(await this.#options.store.read(), body),
    );
    return {
      status: staged.valid ? 200 : 422,
      payload: {
        valid: staged.valid,
        session: staged.session,
        config: staged.config,
        validation: staged.validation,
        events: this.#options.getEvents(),
      },
    };
  }

  async apply(body: Record<string, unknown>) {
    let staged: StagedSession | null = null;
    let applied = false;
    let committed = false;
    let journal: ActiveDeploymentJournal | null = null;
    return this.#options.withDeploymentLock(async () => {
      try {
        const currentInventory = await this.#options.store.read();
        staged = await this.#stageSession(currentInventory, body);
        if (!staged.valid) {
          return {
            status: 422,
            payload: {
              error: "候选配置检查失败",
              ...staged,
              events: this.#options.getEvents(),
            },
          };
        }
        journal = await this.#options.deploymentService.beginJournal(
          currentInventory,
          staged.inventory,
          [staged.node.id],
          [staged.node],
        );
        applied = true;
        const result = await applyStagedConfig(staged.node);
        if (!result.ok) fail(500, result.stderr || result.stdout || "BIRD 配置应用失败");
        await this.#options.store.replace(currentInventory, staged.inventory);
        committed = true;
        await this.#options.deploymentService.clearJournal(journal);
        journal = null;
        if (!staged.session.enabled) {
          this.#options.addEvent("success", `会话 ${staged.session.protocolName} 已停用`, staged.node.id);
          return {
            status: 200,
            payload: {
              applied: true,
              enabled: false,
              established: false,
              session: staged.session,
              config: staged.config,
              status: null,
              events: this.#options.getEvents(),
            },
          };
        }
        const status = await waitForProtocol(staged.node, staged.session.protocolName);
        this.#options.addEvent(
          status.protocol.established ? "success" : "warning",
          status.protocol.established
            ? `与 ${staged.peer.name} 的 BGP 会话已 Established`
            : `配置已应用，正在等待 ${staged.peer.name}`,
          staged.node.id,
        );
        return {
          status: status.protocol.established ? 200 : 202,
          payload: {
            applied: true,
            enabled: true,
            established: status.protocol.established,
            session: staged.session,
            config: staged.config,
            status,
            events: this.#options.getEvents(),
          },
        };
      } catch (error) {
        this.#options.addEvent("error", safeErrorMessage(error), staged?.node?.id ?? null);
        if (applied && !committed && staged?.node) {
          let journalMarkedForRollback = false;
          if (journal) {
            try {
              await this.#options.deploymentService.setJournalDirection(journal, "rollback");
              journalMarkedForRollback = true;
            } catch (journalError) {
              console.error(journalError);
            }
          }
          const rollback = await rollbackNode(staged.node);
          this.#options.addEvent(
            rollback.ok ? "warning" : "error",
            rollback.ok ? "已回滚受管节点" : `受管节点回滚失败：${rollback.stderr || rollback.stdout}`,
            staged.node.id,
          );
          if (rollback.ok && journal && journalMarkedForRollback) {
            try {
              await this.#options.deploymentService.clearJournal(journal);
              journal = null;
            } catch (journalError) {
              console.error(journalError);
            }
          }
        }
        throw error;
      }
    });
  }

  async delete(sessionId: string) {
    let applied = false;
    let committed = false;
    let node: ManagedNode | null = null;
    let journal: ActiveDeploymentJournal | null = null;
    return this.#options.withDeploymentLock(async () => {
      try {
        const state = await this.#options.store.read();
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) fail(404, "会话不存在");
        if (session.managedBy?.kind === "ibgp-domain") fail(409, "该会话由 iBGP 域托管，请在 iBGP 域工作区删除邻接");
        node = findNode(state, session.nodeId);
        const candidate = validateInventory({
          ...state,
          sessions: state.sessions.filter((item) => item.id !== session.id),
        });
        const validation = await stageAndValidate(node, configForNode(candidate, node));
        if (!validation.ok) fail(422, validation.stderr || "候选配置检查失败");
        journal = await this.#options.deploymentService.beginJournal(state, candidate, [node.id], [node]);
        applied = true;
        const result = await applyStagedConfig(node);
        if (!result.ok) fail(500, result.stderr || result.stdout || "BIRD 配置应用失败");
        await this.#options.store.replace(state, candidate);
        committed = true;
        await this.#options.deploymentService.clearJournal(journal);
        journal = null;
        this.#options.addEvent("success", `已移除会话 ${session.protocolName}`, node.id);
        return { status: 200, payload: { inventory: candidate, events: this.#options.getEvents() } };
      } catch (error) {
        if (applied && !committed && node) {
          let journalMarkedForRollback = false;
          if (journal) {
            try {
              await this.#options.deploymentService.setJournalDirection(journal, "rollback");
              journalMarkedForRollback = true;
            } catch (journalError) {
              console.error(journalError);
            }
          }
          const rollback = await rollbackNode(node);
          if (!rollback.ok) {
            this.#options.addEvent("error", `${node.name} 回滚失败：${rollback.stderr || rollback.stdout}`, node.id);
          } else if (journal && journalMarkedForRollback) {
            try {
              await this.#options.deploymentService.clearJournal(journal);
              journal = null;
            } catch (journalError) {
              console.error(journalError);
            }
          }
        }
        throw error;
      }
    });
  }

  #prepareSession(state: Inventory, payloadValue: unknown): PreparedSession {
    const payload = record(payloadValue, "会话参数不能为空");
    const node = findNode(state, String(payload.nodeId ?? ""));
    const peer = findPeer(state, String(payload.peerId ?? ""));
    if (peer.nodeId !== node.id) fail(400, "所选 Peer 不属于该节点");
    if (peer.managedBy?.kind === "ibgp-domain") fail(409, "该会话由 iBGP 域托管，请在 iBGP 域工作区同时修改双方配置");
    const requestedChannels = payload.channels
      && typeof payload.channels === "object"
      && !Array.isArray(payload.channels)
      ? payload.channels as UnknownRecord
      : {
          ipv4: {
            ...optionalRecord(payload.ipv4),
            enabled: true,
            exportDefineId: payload.exportDefineId ?? payload.prefixListId ?? null,
            importPolicy: payload.importPolicy,
            exportPolicy: payload.exportPolicy,
          },
          ipv6: { enabled: true },
        };
    const exportDefines: Record<"ipv4" | "ipv6", CidrDefine | null> = { ipv4: null, ipv6: null };
    for (const family of ["ipv4", "ipv6"] as const) {
      const requestedDefineId = optionalRecord(requestedChannels[family]).exportDefineId;
      const exportDefine = requestedDefineId === null
        || requestedDefineId === undefined
        || requestedDefineId === ""
        ? null
        : findPolicyResource(state, "defines", String(requestedDefineId));
      const expectedType = family === "ipv4" ? "cidr4" : "cidr6";
      if (
        exportDefine
        && (!("type" in exportDefine) || exportDefine.type !== expectedType || !exportDefine.enabled)
      ) {
        fail(400, `所选 Define 不是可用的 ${family.toUpperCase()} CIDR 类型`);
      }
      if (exportDefine && exportDefine.nodeId !== null && exportDefine.nodeId !== node.id) {
        fail(400, "所选 CIDR Define 对该节点不可用");
      }
      exportDefines[family] = exportDefine;
    }
    const existing = state.sessions.find((item) => item.nodeId === node.id && item.peerId === peer.id);
    const session = normalizeSession({
      id: existing?.id ?? this.#options.makeId("session"),
      nodeId: node.id,
      peerId: peer.id,
      protocolName: payload.protocolName,
      localAddress: payload.localAddress,
      localAsn: payload.localAsn,
      localPort: payload.localPort,
      sessionType: "ebgp",
      bgp: payload.bgp,
      channels: requestedChannels,
      enabled: payload.enabled !== false,
    });
    const candidate = structuredClone(state);
    const index = candidate.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) candidate.sessions[index] = session;
    else candidate.sessions.push(session);
    const inventory = validateInventory(candidate);
    return {
      inventory,
      node,
      peer,
      exportDefines,
      session,
      config: configForNode(inventory, node),
    };
  }

  async #stageSession(state: Inventory, payload: unknown): Promise<StagedSession> {
    const prepared = this.#prepareSession(state, payload);
    const validation = await stageAndValidate(prepared.node, prepared.config);
    return { ...prepared, validation, valid: validation.ok };
  }
}

async function waitForProtocol(
  node: ManagedNode,
  protocolName: string,
  timeoutMs = 25000,
): Promise<{ runtime: NodeRuntime; protocol: ProtocolRuntime }> {
  const deadline = Date.now() + timeoutMs;
  let runtime = await inspectNode(node);
  let protocol = protocolFor(runtime, protocolName);
  while (true) {
    if (protocol.established || Date.now() >= deadline) return { runtime, protocol };
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runtime = await inspectNode(node);
    protocol = protocolFor(runtime, protocolName);
  }
}
