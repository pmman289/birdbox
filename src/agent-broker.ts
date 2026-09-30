import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { StateDatabase } from "./database.js";
import { AGENT_METHODS, AGENT_PROTOCOL_VERSION, type AgentRegistration, type AgentTask, type AgentTaskResult } from "./agent-protocol.js";
import { logger } from "./logger.js";

export interface AgentBrokerOptions {
  database: StateDatabase;
  makeId?: (prefix: string) => string;
  onEvent?: (level: string, message: string, nodeId?: string | null) => void;
}

interface CredentialRecord { nodeId: string; tokenHash: string; createdAt: string; revokedAt: string | null; }
interface AgentState {
  nodeId: string;
  connected: boolean;
  registeredAt: string;
  lastSeenAt: string;
  agentVersion: string;
  protocolVersion: number;
  capabilities: string[];
  platform: string | null;
  architecture: string | null;
  hostname: string | null;
}
interface PendingTask { task: AgentTask; resolve: (result: AgentTaskResult) => void; timer: NodeJS.Timeout; }
type PollWaiter = (task: AgentTask | null) => void;

export interface AgentBatchUpgradeInput {
  nodeId: string;
  params: Record<string, unknown>;
}

export interface AgentBatchUpgradeItem {
  nodeId: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result?: AgentTaskResult;
}

export interface AgentBatchUpgradeJob {
  id: string;
  status: "running" | "completed";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentNodeId: string | null;
  items: AgentBatchUpgradeItem[];
}

const CREDENTIALS_KEY = "agent_credentials";
const MAX_TASKS_PER_NODE = 32;
// Runtime/status reads are best-effort. They must not be allowed to occupy an
// entire node queue while configuration and recovery operations are waiting.
const MAX_BACKGROUND_TASKS_PER_NODE = 8;
const MAX_TASK_PARAMETER_BYTES = 16 * 1024 * 1024;

const BACKGROUND_METHODS = new Set([
  "system.info",
  "system.interfaces",
  "bird.inspect",
  "bird.protocol",
  "bird.routes",
  "bird.ospf",
  "bird.access",
]);

function taskPriority(method: string): number {
  return BACKGROUND_METHODS.has(method) ? 10 : 0;
}

function isBackgroundMethod(method: string): boolean {
  return BACKGROUND_METHODS.has(method);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AgentBroker {
  readonly #database: StateDatabase;
  readonly #makeId: (prefix: string) => string;
  readonly #onEvent: (level: string, message: string, nodeId?: string | null) => void;
  readonly #credentials = new Map<string, CredentialRecord>();
  readonly #agents = new Map<string, AgentState>();
  readonly #queues = new Map<string, AgentTask[]>();
  readonly #waiters = new Map<string, PollWaiter[]>();
  readonly #pending = new Map<string, PendingTask>();
  #batchUpgradeJob: AgentBatchUpgradeJob | null = null;
  #singleUpgradeRunning = false;

  constructor(options: AgentBrokerOptions) {
    this.#database = options.database;
    this.#makeId = options.makeId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#onEvent = options.onEvent ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    const state = await this.#database.readState<CredentialRecord[]>(CREDENTIALS_KEY);
    const records = Array.isArray(state?.value) ? state.value : [];
    for (const record of records) {
      if (record && typeof record.nodeId === "string" && typeof record.tokenHash === "string") this.#credentials.set(record.nodeId, record);
    }
    if (!state) await this.#database.createState(CREDENTIALS_KEY, []);
  }

  async #persistCredentials(): Promise<void> {
    await this.#database.mutateState<CredentialRecord[], null>(CREDENTIALS_KEY, [], (current) => ({
      value: [...this.#credentials.values()].map((item) => ({ ...item })),
      result: null,
    }));
  }

  async issueToken(nodeId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const record: CredentialRecord = { nodeId, tokenHash: hashToken(token), createdAt: new Date().toISOString(), revokedAt: null };
    this.#credentials.set(nodeId, record);
    await this.#persistCredentials();
    return token;
  }

  hasCredential(nodeId: string): boolean { return Boolean(this.#credentials.get(nodeId)?.revokedAt === null); }

  async rotateToken(nodeId: string): Promise<string> { return this.issueToken(nodeId); }

  async revoke(nodeId: string): Promise<void> {
    const record = this.#credentials.get(nodeId);
    if (!record) return;
    record.revokedAt = new Date().toISOString();
    await this.#persistCredentials();
    this.#agents.delete(nodeId);
    logger.info("已撤销 Agent 凭据", { nodeId });
  }

  authenticate(nodeId: string, token: string): boolean {
    if (!nodeId || typeof token !== "string" || token.length < 20) return false;
    const record = this.#credentials.get(nodeId);
    return Boolean(record && !record.revokedAt && sameHash(record.tokenHash, hashToken(token)));
  }

  async register(input: AgentRegistration): Promise<{ heartbeatIntervalSeconds: number; protocolVersion: number }> {
    if (!this.authenticate(input.nodeId, input.token)) throw new Error("Agent 凭据无效或已撤销");
    if (input.protocolVersion !== AGENT_PROTOCOL_VERSION) throw new Error("Agent 协议版本不兼容");
    const now = new Date().toISOString();
    const previous = this.#agents.get(input.nodeId);
    this.#agents.set(input.nodeId, {
      nodeId: input.nodeId,
      connected: true,
      registeredAt: previous?.registeredAt ?? now,
      lastSeenAt: now,
      agentVersion: String(input.agentVersion || "unknown").slice(0, 80),
      protocolVersion: input.protocolVersion,
      capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String).slice(0, 100) : [],
      platform: input.platform ? String(input.platform).slice(0, 80) : null,
      architecture: input.architecture ? String(input.architecture).slice(0, 80) : null,
      hostname: input.hostname ? String(input.hostname).slice(0, 255) : null,
    });
    if (!previous || previous.agentVersion !== String(input.agentVersion || "unknown").slice(0, 80)) {
      logger.info("Agent 已注册", { nodeId: input.nodeId, version: String(input.agentVersion || "unknown").slice(0, 80) });
      this.#onEvent("success", `Agent ${input.nodeId} 已注册`, input.nodeId);
    }
    return { heartbeatIntervalSeconds: 15, protocolVersion: AGENT_PROTOCOL_VERSION };
  }

  heartbeat(nodeId: string, token: string): void {
    if (!this.authenticate(nodeId, token)) throw new Error("Agent 凭据无效或已撤销");
    const state = this.#agents.get(nodeId);
    if (state) { state.connected = true; state.lastSeenAt = new Date().toISOString(); }
  }

  status(nodeId: string): AgentState | null {
    const item = this.#agents.get(nodeId);
    if (!item) return null;
    const connected = Date.now() - Date.parse(item.lastSeenAt) < 45_000;
    return { ...item, connected, capabilities: [...item.capabilities] };
  }
  statuses(): AgentState[] { return [...this.#agents.keys()].map((nodeId) => this.status(nodeId)!).filter(Boolean); }

  batchUpgradeStatus(): AgentBatchUpgradeJob | null {
    const job = this.#batchUpgradeJob;
    if (!job) return null;
    return {
      ...job,
      items: job.items.map((item) => ({
        ...item,
        // Upgrade output is diagnostic only. Keep polling responses bounded even
        // if an Agent returns a very large stdout/stderr payload.
        result: item.result ? {
          ...item.result,
          stdout: String(item.result.stdout ?? "").slice(0, 4096),
          stderr: String(item.result.stderr ?? "").slice(0, 4096),
        } : undefined,
      })),
    };
  }

  beginSingleUpgrade(): boolean {
    if (this.#singleUpgradeRunning || this.#batchUpgradeJob?.status === "running") return false;
    this.#singleUpgradeRunning = true;
    return true;
  }

  endSingleUpgrade(): void {
    this.#singleUpgradeRunning = false;
  }

  startBatchUpgrade(inputs: AgentBatchUpgradeInput[]): AgentBatchUpgradeJob {
    if (this.#batchUpgradeJob?.status === "running" || this.#singleUpgradeRunning) {
      const error = new Error("已有 Agent 批量升级任务正在执行") as Error & { code?: string };
      error.code = "BATCH_UPGRADE_RUNNING";
      throw error;
    }
    const now = new Date().toISOString();
    const items: AgentBatchUpgradeItem[] = inputs.map(({ nodeId }) => ({
      nodeId,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      error: null,
    }));
    this.#batchUpgradeJob = {
      id: this.#makeId("agent_batch_upgrade"),
      status: "running",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      currentNodeId: null,
      items,
    };
    void this.#runBatchUpgrade(inputs, this.#batchUpgradeJob);
    return this.batchUpgradeStatus()!;
  }

  async #runBatchUpgrade(inputs: AgentBatchUpgradeInput[], job: AgentBatchUpgradeJob): Promise<void> {
    job.startedAt = new Date().toISOString();
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]!;
      const item = job.items[index]!;
      job.currentNodeId = input.nodeId;
      if (!this.status(input.nodeId)?.connected) {
        item.status = "skipped";
        item.error = "Agent 当前未连接";
        item.finishedAt = new Date().toISOString();
        continue;
      }
      item.status = "running";
      item.startedAt = new Date().toISOString();
      try {
        const result = await this.dispatch(input.nodeId, "agent.self_upgrade", input.params, 10 * 60 * 1000);
        item.result = result;
        if (result.ok) item.status = "success";
        else {
          item.status = "failed";
          const detail = result.stderr || result.stdout || result.code;
          item.error = detail ? String(detail) : "Agent 升级失败";
          if (result.code === "AGENT_TIMEOUT") {
            for (let remaining = index + 1; remaining < job.items.length; remaining += 1) {
              const pending = job.items[remaining]!;
              pending.status = "skipped";
              pending.error = "前一节点升级超时，已暂停后续任务以避免并发下载";
              pending.finishedAt = new Date().toISOString();
            }
            break;
          }
        }
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "Agent 升级失败";
      } finally {
        item.finishedAt = new Date().toISOString();
      }
    }
    job.currentNodeId = null;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    const failed = job.items.filter((item) => item.status === "failed").length;
    const skipped = job.items.filter((item) => item.status === "skipped").length;
    this.#onEvent(failed ? "error" : skipped ? "warning" : "success", `Agent 批量升级任务 ${job.id} 已完成：成功 ${job.items.length - failed - skipped}，失败 ${failed}，跳过 ${skipped}`);
  }

  #takeTask(nodeId: string): AgentTask | null {
    const queue = this.#queues.get(nodeId);
    if (!queue) return null;
    this.#pruneQueue(nodeId);
    const current = this.#queues.get(nodeId);
    const task = current?.shift() ?? null;
    if (current && current.length === 0) this.#queues.delete(nodeId);
    return task;
  }

  #resolveDroppedTask(task: AgentTask, code: string, message: string): void {
    const pending = this.#pending.get(task.taskId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(task.taskId);
    pending.resolve({ taskId: task.taskId, nodeId: task.nodeId, ok: false, stdout: "", stderr: message, code });
  }

  #pruneQueue(nodeId: string, now = Date.now()): void {
    const queue = this.#queues.get(nodeId);
    if (!queue?.length) return;
    const retained: AgentTask[] = [];
    for (const task of queue) {
      if (Date.parse(task.deadlineAt) <= now) {
        this.#resolveDroppedTask(task, "TASK_EXPIRED", "Agent 任务已过期");
      } else {
        retained.push(task);
      }
    }
    if (retained.length) this.#queues.set(nodeId, retained);
    else this.#queues.delete(nodeId);
  }

  #dropBackgroundTasks(nodeId: string, count: number): number {
    const queue = this.#queues.get(nodeId);
    if (!queue?.length || count <= 0) return 0;
    let dropped = 0;
    const retained: AgentTask[] = [];
    for (const task of queue) {
      if (dropped < count && isBackgroundMethod(task.method)) {
        dropped += 1;
        this.#resolveDroppedTask(task, "TASK_PREEMPTED", "后台 Agent 任务已让位给高优先级操作");
      } else {
        retained.push(task);
      }
    }
    if (retained.length) this.#queues.set(nodeId, retained);
    else this.#queues.delete(nodeId);
    return dropped;
  }

  async poll(nodeId: string, token: string, waitMs = 25_000, signal?: AbortSignal): Promise<AgentTask | null> {
    if (!this.authenticate(nodeId, token)) throw new Error("Agent 凭据无效或已撤销");
    this.heartbeat(nodeId, token);
    const immediate = this.#takeTask(nodeId);
    if (immediate) return immediate;
    if (signal?.aborted) return null;
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(nodeId) ?? [];
      let settled = false;
      const waiter: PollWaiter = (task) => finish(task);
      const remove = (): void => {
        const current = this.#waiters.get(nodeId) ?? [];
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        if (current.length) this.#waiters.set(nodeId, current); else this.#waiters.delete(nodeId);
      };
      const finish = (task: AgentTask | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(task);
      };
      const onAbort = (): void => { remove(); finish(null); };
      waiters.push(waiter);
      this.#waiters.set(nodeId, waiters);
      const timer = setTimeout(() => {
        remove(); finish(null);
      }, Math.max(1000, Math.min(waitMs, 30_000)));
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  requeue(task: AgentTask): void {
    if (!this.#pending.has(task.taskId)) return;
    const queue = this.#queues.get(task.nodeId) ?? [];
    this.#queues.set(task.nodeId, [task, ...queue].sort((left, right) => taskPriority(left.method) - taskPriority(right.method)));
    logger.warn("Agent 任务投递失败，已重新入队", { nodeId: task.nodeId, taskId: task.taskId, method: task.method });
  }

  dispatch(nodeId: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<AgentTaskResult> {
    if (!AGENT_METHODS.has(method)) {
      logger.warn("拒绝未知 Agent 方法", { nodeId, method });
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: `不支持的 Agent 方法：${method}`, code: "METHOD_NOT_ALLOWED" });
    }
    if (isBackgroundMethod(method) && !this.status(nodeId)?.connected) {
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "Agent 当前未连接", code: "AGENT_OFFLINE" });
    }
    let serializedParams: string;
    try { serializedParams = JSON.stringify(params); } catch { return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "Agent 任务参数不可序列化", code: "INVALID_TASK" }); }
    if (Buffer.byteLength(serializedParams, "utf8") > MAX_TASK_PARAMETER_BYTES) {
      logger.warn("拒绝过大的 Agent 任务参数", { nodeId, method });
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "Agent 任务参数过大", code: "TASK_TOO_LARGE" });
    }
    const agent = this.#agents.get(nodeId);
    if (Buffer.byteLength(serializedParams, "utf8") > 1_900_000 && agent && !agent.capabilities.includes("task.large_payload")) {
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: `当前 Agent 版本（${agent.agentVersion}）无法接收超过 2 MiB 的配置，请先升级 Agent`, code: "AGENT_UPGRADE_REQUIRED" });
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10 * 60 * 1000) {
      logger.warn("拒绝不合法的 Agent 任务超时设置", { nodeId, method, timeoutMs });
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "Agent 任务超时设置不合法", code: "INVALID_TIMEOUT" });
    }
    this.#pruneQueue(nodeId);
    const queue = this.#queues.get(nodeId) ?? [];
    const pendingForNode = [...this.#pending.values()].filter((item) => item.task.nodeId === nodeId).length;
    const backgroundQueued = queue.reduce((count, task) => count + (isBackgroundMethod(task.method) ? 1 : 0), 0);
    const backgroundPending = [...this.#pending.values()]
      .filter((item) => item.task.nodeId === nodeId && isBackgroundMethod(item.task.method)).length;
    if (isBackgroundMethod(method) && backgroundPending >= MAX_BACKGROUND_TASKS_PER_NODE) {
      logger.info("丢弃过量后台 Agent 任务", { nodeId, method, queued: queue.length, backgroundQueued, backgroundPending });
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "后台状态查询已在队列中", code: "TASK_DEDUPED" });
    }
    if (pendingForNode >= MAX_TASKS_PER_NODE && !isBackgroundMethod(method)) {
      this.#dropBackgroundTasks(nodeId, pendingForNode - MAX_TASKS_PER_NODE + 1);
    }
    const currentQueue = this.#queues.get(nodeId) ?? [];
    const currentPending = [...this.#pending.values()].filter((item) => item.task.nodeId === nodeId).length;
    if (currentPending >= MAX_TASKS_PER_NODE) {
      logger.warn("Agent 任务队列已满", { nodeId, method, queued: currentQueue.length, pending: currentPending });
      return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "Agent 任务队列已满", code: "TASK_QUEUE_FULL" });
    }
    const now = Date.now();
    const task: AgentTask = { taskId: this.#makeId("agent_task"), nodeId, method, params, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + timeoutMs).toISOString() };
    const waiter = this.#waiters.get(nodeId)?.shift();
    const taskPromise = new Promise<AgentTaskResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(task.taskId);
        logger.warn("Agent 任务超时", { nodeId, method, taskId: task.taskId, timeoutMs });
        resolve({ taskId: task.taskId, nodeId, ok: false, stdout: "", stderr: "Agent 任务超时", code: "AGENT_TIMEOUT" });
      }, timeoutMs);
      timer.unref();
      this.#pending.set(task.taskId, { task, resolve, timer });
    });
    if (waiter) {
      if (!this.#waiters.get(nodeId)?.length) this.#waiters.delete(nodeId);
      waiter(task);
    } else {
      const nextQueue = [...(this.#queues.get(nodeId) ?? []), task]
        .sort((left, right) => taskPriority(left.method) - taskPriority(right.method));
      this.#queues.set(nodeId, nextQueue);
    }
    return taskPromise;
  }

  result(input: AgentTaskResult, token: string): void {
    if (!this.authenticate(input.nodeId, token)) throw new Error("Agent 凭据无效或已撤销");
    const pending = this.#pending.get(input.taskId);
    if (!pending || pending.task.nodeId !== input.nodeId) return;
    clearTimeout(pending.timer); this.#pending.delete(input.taskId);
    logger.info("收到 Agent 任务结果", { nodeId: input.nodeId, taskId: input.taskId, ok: input.ok, code: input.code === undefined ? null : String(input.code) });
    pending.resolve({ ...input, stdout: String(input.stdout ?? "").slice(0, 8 * 1024 * 1024), stderr: String(input.stderr ?? "").slice(0, 8 * 1024 * 1024) });
  }
}
