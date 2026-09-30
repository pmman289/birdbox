import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { AuthStore } from "./auth.js";
import { AgentBroker } from "./agent-broker.js";
import { renderBirdConfig } from "./bird.js";
import { ChangeEventLog } from "./change-event-log.js";
import { ControllerSshIdentity } from "./controller-ssh.js";
import { DashboardService } from "./dashboard-service.js";
import { createDatabaseFromEnvironment } from "./database.js";
import { DeploymentService } from "./deployment-service.js";
import { fail } from "./errors.js";
import { createHttpApplication } from "./http/application.js";
import { configBundleForNode, findNode, staticValidationError } from "./inventory-domain.js";
import { NodeOnboardingService } from "./node-onboarding-service.js";
import { createResourceApplicationService } from "./resource-application-service.js";
import { SessionApplicationService } from "./session-application-service.js";
import { resolveApplicationRoot } from "./application-root.js";
import { InventoryStore } from "./store.js";
import { configureAgentBroker } from "./node-executor.js";
import { errorContext, logger } from "./logger.js";
import { createDeploymentRecoveryRunner } from "./deployment-recovery.js";

function normalizeListenHost(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\0\r\n]/.test(normalized)) throw new Error("BIRDBOX_HOST 不合法");
  return normalized;
}

function normalizeListenPort(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 65535) {
    throw new Error("BIRDBOX_PORT 必须是 1 到 65535 之间的整数");
  }
  return normalized;
}

function normalizeEnvironmentBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} 必须是 true 或 false`);
}

function normalizeTrustProxy(value: unknown): boolean | string | number | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return normalized;
}

function normalizePublicUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value ?? "")); } catch { throw new Error("BIRDBOX_PUBLIC_URL 必须是完整的 http(s):// URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BIRDBOX_PUBLIC_URL 只支持 http 或 https");
  if (url.username || url.password || url.search || url.hash) throw new Error("BIRDBOX_PUBLIC_URL 不能包含凭据、查询或片段");
  if (["0.0.0.0", "[::]"].includes(url.hostname)) throw new Error("BIRDBOX_PUBLIC_URL 不能使用监听地址 0.0.0.0/::");
  if (/^(127\.|localhost$|\[::1\]$)/.test(url.hostname)) logger.warn("BIRDBOX_PUBLIC_URL 指向回环地址，远端 Agent 将无法连接", { publicUrl: url.origin });
  if (url.protocol === "http:" && !/^(127\.|localhost$|\[::1\]$)/.test(url.hostname)) logger.warn("BIRDBOX_PUBLIC_URL 使用明文 HTTP，生产环境请使用 HTTPS", { publicUrl: url.origin });
  return url.toString().replace(/\/$/, "");
}

function normalizeShutdownTimeout(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 30000 || normalized > 1800000) {
    throw new Error("BIRDBOX_SHUTDOWN_TIMEOUT_MS 必须是 30000 到 1800000 之间的整数");
  }
  return normalized;
}

function normalizeIrrSchedulerInterval(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 250 || normalized > 3_600_000) {
    throw new Error("BIRDBOX_IRR_SCHEDULER_INTERVAL_MS 必须是 250 到 3600000 之间的整数");
  }
  return normalized;
}

const rootDirectory = resolveApplicationRoot(import.meta.url);
const publicDirectory = path.join(rootDirectory, "public");
const packageDocument = JSON.parse(await fs.readFile(path.join(rootDirectory, "package.json"), "utf8")) as { version?: unknown };
const appVersion = typeof packageDocument.version === "string" ? packageDocument.version : "dev";
const dataDirectory = process.env.BIRDBOX_DATA_DIR ?? path.join(rootDirectory, "data");
const nodesPath = process.env.BIRDBOX_NODES_FILE ?? path.join(rootDirectory, "config", "nodes.json");
const host = normalizeListenHost(process.env.BIRDBOX_HOST ?? "0.0.0.0");
const port = normalizeListenPort(process.env.BIRDBOX_PORT ?? 3000);
const publicUrl = normalizePublicUrl(process.env.BIRDBOX_PUBLIC_URL ?? `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`);
const trustProxy = normalizeTrustProxy(process.env.BIRDBOX_TRUST_PROXY);
const secureCookieSetting = normalizeEnvironmentBoolean(
  process.env.BIRDBOX_SECURE_COOKIE,
  "BIRDBOX_SECURE_COOKIE",
);
const shutdownTimeoutMs = normalizeShutdownTimeout(
  process.env.BIRDBOX_SHUTDOWN_TIMEOUT_MS ?? 1800000,
);
const irrSchedulerIntervalMs = normalizeIrrSchedulerInterval(
  process.env.BIRDBOX_IRR_SCHEDULER_INTERVAL_MS ?? 60_000,
);
const controllerSshDirectory = path.join(dataDirectory, "ssh");
const controllerSshKeyPath = process.env.BIRDBOX_SSH_KEY_PATH
  ?? path.join(controllerSshDirectory, "id_ed25519");
const controllerKnownHostsPath = process.env.BIRDBOX_KNOWN_HOSTS_PATH
  ?? path.join(controllerSshDirectory, "known_hosts");

const database = createDatabaseFromEnvironment();
const authStore = new AuthStore({ database, dataDir: dataDirectory });
const store = new InventoryStore({
  database,
  dataDir: dataDirectory,
  nodesPath,
  legacySessionPath: path.join(dataDirectory, "session.json"),
});
const eventLog = new ChangeEventLog();

let deploymentLocked = false;
let activeDeployment: Promise<unknown> | null = null;
const nodeOperationLocks = new Set<string>();
let shuttingDown = false;
let deploymentService: DeploymentService;
let recoveryState: "idle" | "pending" | "failed" = "idle";

async function withDeploymentLock<Result>(
  operation: () => Promise<Result> | Result,
  { allowPendingJournal = false }: { allowPendingJournal?: boolean } = {},
): Promise<Result> {
  if (shuttingDown) fail(503, "服务正在关闭，暂不接受新的部署");
  if (!allowPendingJournal && recoveryState !== "idle") {
    fail(503, recoveryState === "failed"
      ? "未完成部署恢复失败，系统正在重试；恢复完成前暂不接受变更"
      : "存在尚未完成的部署恢复任务，恢复完成前暂不接受变更");
  }
  if (deploymentLocked) fail(409, "另一个部署正在进行");
  deploymentLocked = true;
  const deployment = database.withLock("deployment", async () => {
    if (!allowPendingJournal && (await deploymentService.readJournal()).active) {
      fail(503, "存在尚未完成的部署恢复任务，请重启服务完成恢复");
    }
    return operation();
  });
  activeDeployment = deployment;
  try {
    return await deployment;
  } finally {
    if (activeDeployment === deployment) activeDeployment = null;
    deploymentLocked = false;
  }
}

/** Runtime operations such as enabling/disabling one protocol only lock that node. */
async function withNodeOperationLock<Result>(
  nodeId: string,
  operation: () => Promise<Result> | Result,
): Promise<Result> {
  const key = String(nodeId);
  if (!key || nodeOperationLocks.has(key)) fail(409, "该节点已有操作正在进行，请稍候");
  nodeOperationLocks.add(key);
  try {
    return await operation();
  } finally {
    nodeOperationLocks.delete(key);
  }
}

const addEvent = eventLog.add.bind(eventLog);
const getEvents = eventLog.list.bind(eventLog);
const makeId = (prefix: string): string =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const agentBroker = new AgentBroker({ database, makeId, onEvent: addEvent });

deploymentService = new DeploymentService({
  database,
  store,
  withDeploymentLock,
  configForNode: configBundleForNode,
  emptyConfigForNode: (node) => ({ main: renderBirdConfig(node, [], [], [], [], [], [], []), resources: [], removedResources: [] }),
  findNode,
  validationError: staticValidationError,
  addEvent,
  fail,
});
const controllerSshIdentity = new ControllerSshIdentity({
  store,
  sshDirectory: controllerSshDirectory,
  identityFile: controllerSshKeyPath,
  knownHostsFile: controllerKnownHostsPath,
});
const dashboardService = new DashboardService({ getEvents });
const nodeOnboarding = new NodeOnboardingService({
  store,
  deploymentService,
  withDeploymentLock,
  controllerPublicKey: () => controllerSshIdentity.publicKey,
  makeId,
  addEvent,
  getEvents,
  agentBroker,
  agentControllerUrl: publicUrl,
});
const sessions = new SessionApplicationService({
  store,
  deploymentService,
  withDeploymentLock,
  makeId,
  addEvent,
  getEvents,
});
const mutationService = createResourceApplicationService({
  store,
  deploymentService,
  nodeOnboarding,
  sessions,
  withDeploymentLock,
  makeId,
  addEvent,
  getEvents,
});
let irrSchedulerStopped = false;
let activeIrrSchedule: Promise<void> | null = null;

await database.initialize();
await authStore.initialize();
await store.initialize();
await agentBroker.initialize();
configureAgentBroker(agentBroker);
await deploymentService.initialize();

const pendingDeployment = (await deploymentService.readJournal()).active;
const recoveryNodes = pendingDeployment
  ? [...pendingDeployment.forwardTargets, ...pendingDeployment.rollbackTargets].map((target) => target.node)
  : [];
await controllerSshIdentity.initialize(recoveryNodes);
const recoveryRunner = createDeploymentRecoveryRunner({
  pending: Boolean(pendingDeployment),
  recover: () => deploymentService.recover(),
  onStateChange: (state) => { recoveryState = state; },
  onFailure: (error, retryInMs) => {
    logger.error("未完成部署恢复失败，稍后重试", { retryInMs, ...errorContext(error) });
    addEvent("error", `未完成部署恢复失败：${error instanceof Error ? error.message : String(error)}`);
  },
});
recoveryState = recoveryRunner.state;

const app = await createHttpApplication({
  publicDirectory,
  appVersion,
  authStore,
  store,
  secureCookieSetting,
  ping: () => database.ping(),
  isDeploymentLocked: () => deploymentLocked || recoveryState !== "idle",
  recoveryState: () => recoveryState,
  loadDashboard: async (nodeId, peerId) => dashboardService.load(await store.read(), nodeId, peerId),
  withDeploymentLock,
  withNodeOperationLock,
  mutationService,
  addEvent,
  getEvents,
  agentBroker,
  database,
  metricsToken: process.env.BIRDBOX_METRICS_TOKEN?.trim() || null,
  agentBinaryPath: process.env.BIRDBOX_AGENT_BINARY_PATH ?? (process.env.NODE_ENV === "production" ? "/usr/local/lib/birdbox-agent" : path.join(rootDirectory, "agent", "bin", "birdbox-agent")),
  agentPublicUrl: publicUrl,
  trustProxy,
});

await app.listen({ port, host });
logger.info("Birdbox 服务已启动", { host, port, version: appVersion });

if (pendingDeployment) void recoveryRunner.run();
else await recoveryRunner.run();

async function runIrrSchedule(): Promise<void> {
  if (irrSchedulerStopped || activeIrrSchedule) return;
  activeIrrSchedule = (async () => {
    let inventory;
    try {
      inventory = await store.read();
    } catch (error) {
      logger.error("AS-SET 调度读取库存失败，等待下一个周期", errorContext(error));
      return;
    }
    const now = Date.now();
    for (const define of inventory.defines) {
      if (irrSchedulerStopped) break;
      if (define.type === "expression" || define.entrySource.kind !== "irr-as-set" || !define.enabled) continue;
      const dueAt = define.sync.nextRefreshAt ? Date.parse(define.sync.nextRefreshAt) : 0;
      if (Number.isFinite(dueAt) && dueAt > now) continue;
      try {
        logger.info("开始同步 AS-SET Define", { defineId: define.id });
        await mutationService.syncIrrDefine(define.id);
        logger.info("AS-SET Define 同步完成", { defineId: define.id });
      } catch (error) {
        logger.error("AS-SET Define 同步失败", { defineId: define.id, ...errorContext(error) });
      }
    }
  })().finally(() => { activeIrrSchedule = null; });
  await activeIrrSchedule;
}
const scheduleIrr = (): void => { void runIrrSchedule().catch((error) => logger.error("AS-SET 调度异常", errorContext(error))); };
const irrScheduleTimer = setInterval(scheduleIrr, irrSchedulerIntervalMs);
irrScheduleTimer.unref();
scheduleIrr();

process.on("unhandledRejection", (reason) => {
  logger.error("未处理的 Promise 拒绝", errorContext(reason));
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  recoveryRunner.stop();
  irrSchedulerStopped = true;
  clearInterval(irrScheduleTimer);
  logger.info("Birdbox 服务开始关闭", { signal });
  const forcedExit = setTimeout(() => process.exit(1), shutdownTimeoutMs);
  forcedExit.unref();
  const serverClosed = app.close();
  app.server.closeIdleConnections?.();
  try {
    const deployment = activeDeployment;
    if (deployment) await deployment.catch(() => undefined);
    if (activeIrrSchedule) await activeIrrSchedule.catch(() => undefined);
    app.server.closeIdleConnections?.();
    await serverClosed;
    await database.close();
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    logger.error("Birdbox 服务关闭失败", errorContext(error));
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
