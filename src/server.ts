import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { AuthStore } from "./auth.js";
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
let shuttingDown = false;
let deploymentService: DeploymentService;

async function withDeploymentLock<Result>(
  operation: () => Promise<Result> | Result,
  { allowPendingJournal = false }: { allowPendingJournal?: boolean } = {},
): Promise<Result> {
  if (shuttingDown) fail(503, "服务正在关闭，暂不接受新的部署");
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

const addEvent = eventLog.add.bind(eventLog);
const getEvents = eventLog.list.bind(eventLog);
const makeId = (prefix: string): string =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

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
await deploymentService.initialize();

const pendingDeployment = (await deploymentService.readJournal()).active;
const recoveryNodes = pendingDeployment
  ? [...pendingDeployment.forwardTargets, ...pendingDeployment.rollbackTargets].map((target) => target.node)
  : [];
await controllerSshIdentity.initialize(recoveryNodes);
await deploymentService.recover();

const app = await createHttpApplication({
  publicDirectory,
  appVersion,
  authStore,
  store,
  secureCookieSetting,
  ping: () => database.ping(),
  isDeploymentLocked: () => deploymentLocked,
  loadDashboard: async (nodeId, peerId) => dashboardService.load(await store.read(), nodeId, peerId),
  withDeploymentLock,
  mutationService,
  addEvent,
  getEvents,
});

await app.listen({ port, host });
console.log(`Birdbox Demo listening on http://${host}:${port}`);

async function runIrrSchedule(): Promise<void> {
  if (irrSchedulerStopped || activeIrrSchedule) return;
  activeIrrSchedule = (async () => {
    const inventory = await store.read();
    const now = Date.now();
    for (const define of inventory.defines) {
      if (irrSchedulerStopped) break;
      if (define.type === "expression" || define.entrySource.kind !== "irr-as-set" || !define.enabled) continue;
      const dueAt = define.sync.nextRefreshAt ? Date.parse(define.sync.nextRefreshAt) : 0;
      if (Number.isFinite(dueAt) && dueAt > now) continue;
      try { await mutationService.syncIrrDefine(define.id); } catch (error) { console.error(`AS-SET Define ${define.id} 自动同步失败`, error); }
    }
  })().finally(() => { activeIrrSchedule = null; });
  await activeIrrSchedule;
}
const irrScheduleTimer = setInterval(() => void runIrrSchedule(), irrSchedulerIntervalMs);
irrScheduleTimer.unref();
void runIrrSchedule();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  irrSchedulerStopped = true;
  clearInterval(irrScheduleTimer);
  console.log(`Received ${signal}, shutting down`);
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
    console.error(error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
