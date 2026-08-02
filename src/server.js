import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import {
  ACTIVE_BIRD_INCLUDE_AWK,
  applyStagedConfig,
  birdSourceReferencesSymbol,
  checkIncludeNodeAccess,
  configureManagedSsh,
  inspectNode,
  inspectProtocolRoutes,
  normalizeDefine,
  normalizeNode,
  normalizePeer,
  normalizePolicyFilter,
  normalizePolicyFunction,
  normalizeRPKI,
  normalizeSession,
  normalizeStaticProtocol,
  renderBirdConfig,
  rollbackNode,
  stageAndValidate,
  setProtocolState,
  validateInventory,
} from "./bird.js";
import { resourceChangeNodeIds, resourceNodeIds, uniqueNodeIds } from "./resource-impact.js";
import { AUTH_COOKIE_NAME, AUTH_SESSION_TTL_MS, AuthStore } from "./auth.js";
import { createDatabaseFromEnvironment } from "./database.js";
import { InventoryStore } from "./store.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataDir = process.env.BIRDBOX_DATA_DIR ?? path.join(rootDir, "data");
const nodesPath = process.env.BIRDBOX_NODES_FILE ?? path.join(rootDir, "config", "nodes.json");
const host = normalizeListenHost(process.env.BIRDBOX_HOST ?? "0.0.0.0");
const port = normalizeListenPort(process.env.BIRDBOX_PORT ?? 3000);
const execFileAsync = promisify(execFile);
const controllerSshDir = path.join(dataDir, "ssh");
const controllerSshKeyPath = process.env.BIRDBOX_SSH_KEY_PATH ?? path.join(controllerSshDir, "id_ed25519");
const controllerKnownHostsPath = process.env.BIRDBOX_KNOWN_HOSTS_PATH ?? path.join(controllerSshDir, "known_hosts");
const secureCookieSetting = normalizeEnvironmentBoolean(process.env.BIRDBOX_SECURE_COOKIE, "BIRDBOX_SECURE_COOKIE");
const shutdownTimeoutMs = normalizeShutdownTimeout(process.env.BIRDBOX_SHUTDOWN_TIMEOUT_MS ?? 1800000);
const database = createDatabaseFromEnvironment();
const authStore = new AuthStore({ database, dataDir });
const store = new InventoryStore({
  database,
  dataDir,
  nodesPath,
  legacySessionPath: path.join(dataDir, "session.json"),
});

let deploymentLocked = false;
let activeDeployment = null;
let shuttingDown = false;
let events = [];
const loginFailures = new Map();
let loginAttemptSequence = 0;
let lastLoginFailurePruneAt = 0;
let controllerPublicKey = "";

const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const MAX_LOGIN_FAILURE_KEYS = 10000;
const MAX_EVENT_MESSAGE_LENGTH = 8192;
const DEPLOYMENT_JOURNAL_KEY = "deployment_journal";
const EMPTY_DEPLOYMENT_JOURNAL = Object.freeze({ version: 1, active: null });

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

function normalizeListenHost(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\0\r\n]/.test(normalized)) throw new Error("BIRDBOX_HOST 不合法");
  return normalized;
}

function normalizeListenPort(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 65535) {
    throw new Error("BIRDBOX_PORT 必须是 1 到 65535 之间的整数");
  }
  return normalized;
}

function normalizeEnvironmentBoolean(value, label) {
  if (value === undefined || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} 必须是 true 或 false`);
}

function normalizeShutdownTimeout(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 30000 || normalized > 1800000) {
    throw new Error("BIRDBOX_SHUTDOWN_TIMEOUT_MS 必须是 30000 到 1800000 之间的整数");
  }
  return normalized;
}

function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

async function withDeploymentLock(operation, { allowPendingJournal = false } = {}) {
  if (shuttingDown) fail(503, "服务正在关闭，暂不接受新的部署");
  if (deploymentLocked) fail(409, "另一个部署正在进行");
  deploymentLocked = true;
  const deployment = database.withLock("deployment", async () => {
    if (!allowPendingJournal && (await readDeploymentJournal()).active) {
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

async function fileStat(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularFile(stat, label) {
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件且不能是符号链接`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} 必须属于 Birdbox 运行用户`);
}

async function ensureSecureDirectory(directory) {
  const existing = await fileStat(directory);
  if (!existing) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory} 必须是目录且不能是符号链接`);
  if (!existing || path.resolve(directory) === path.resolve(controllerSshDir)) {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${directory} 必须属于 Birdbox 运行用户`);
    await fs.chmod(directory, 0o700);
  }
}

function publicKeyIdentity(value) {
  const fields = String(value ?? "").trim().split(/\s+/);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1])) {
    throw new Error("Birdbox 控制器 SSH 公钥格式不合法");
  }
  return `${fields[0]} ${fields[1]}`;
}

async function ensureControllerSshIdentity(additionalNodes = []) {
  const inventory = await store.read();
  const managedNodes = [...new Map(
    [...inventory.nodes, ...additionalNodes]
      .filter((node) => node.transport === "ssh" && node.sshIdentity === "managed")
      .map((node) => [node.id, node]),
  ).values()];
  const identityRequired = managedNodes.length > 0;
  await ensureSecureDirectory(path.dirname(controllerSshKeyPath));
  await ensureSecureDirectory(path.dirname(controllerKnownHostsPath));

  let privateKeyStat = await fileStat(controllerSshKeyPath);
  if (!privateKeyStat) {
    if (identityRequired) throw new Error("已有受管节点，但 Birdbox 控制器 SSH 私钥缺失；拒绝静默轮换身份");
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "birdbox-controller", "-f", controllerSshKeyPath]);
    privateKeyStat = await fs.lstat(controllerSshKeyPath);
  }
  assertRegularFile(privateKeyStat, "Birdbox 控制器 SSH 私钥");
  await fs.chmod(controllerSshKeyPath, 0o600);

  const derived = publicKeyIdentity((await execFileAsync("ssh-keygen", ["-y", "-f", controllerSshKeyPath])).stdout);
  const publicKeyPath = `${controllerSshKeyPath}.pub`;
  const publicKeyStat = await fileStat(publicKeyPath);
  if (!publicKeyStat) {
    await fs.writeFile(publicKeyPath, `${derived} birdbox-controller\n`, { mode: 0o644, flag: "wx" });
  } else {
    assertRegularFile(publicKeyStat, "Birdbox 控制器 SSH 公钥");
    if (publicKeyIdentity(await fs.readFile(publicKeyPath, "utf8")) !== derived) {
      throw new Error("Birdbox 控制器 SSH 公私钥不匹配");
    }
  }
  await fs.chmod(publicKeyPath, 0o644);

  const knownHostsStat = await fileStat(controllerKnownHostsPath);
  if (!knownHostsStat) {
    if (identityRequired) throw new Error("已有受管节点，但 SSH known_hosts 缺失；拒绝丢失主机身份绑定");
    await fs.writeFile(controllerKnownHostsPath, "", { mode: 0o600, flag: "wx" });
  } else {
    assertRegularFile(knownHostsStat, "SSH known_hosts");
  }
  const knownHosts = await fs.readFile(controllerKnownHostsPath, "utf8");
  if (identityRequired && !knownHosts.trim()) throw new Error("已有受管节点，但 SSH known_hosts 为空；拒绝重新信任主机身份");
  for (const node of managedNodes) {
    const target = node.sshPort === 22 ? node.sshHost : `[${node.sshHost}]:${node.sshPort}`;
    try {
      await execFileAsync("ssh-keygen", ["-F", target, "-f", controllerKnownHostsPath]);
    } catch {
      throw new Error(`SSH known_hosts 缺少已有受管节点 ${node.name} 的主机身份；拒绝重新信任`);
    }
  }
  await fs.chmod(controllerKnownHostsPath, 0o600);
  controllerPublicKey = `${derived} birdbox-controller`;
  configureManagedSsh({ identityFile: controllerSshKeyPath, knownHostsFile: controllerKnownHostsPath });
}

function event(level, message, nodeId = null) {
  const fullMessage = String(message ?? "");
  const boundedMessage = fullMessage.length > MAX_EVENT_MESSAGE_LENGTH
    ? `${fullMessage.slice(0, MAX_EVENT_MESSAGE_LENGTH)}\n...消息已截断`
    : fullMessage;
  const entry = { timestamp: new Date().toISOString(), level, message: boundedMessage, nodeId };
  events = [...events.slice(-99), entry];
  return entry;
}

function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function isPublicError(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
}

function safeErrorMessage(error) {
  return isPublicError(error) ? error.message : "服务器内部错误";
}

function findNode(state, nodeId) {
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) fail(404, "受管节点不存在");
  return node;
}

function findPeer(state, peerId) {
  const peer = state.peers.find((item) => item.id === peerId);
  if (!peer) fail(404, "远端 Peer 不存在");
  return peer;
}

function findPolicyResource(state, collection, resourceId) {
  const resource = state[collection].find((item) => item.id === resourceId);
  if (!resource) fail(404, collection === "functions" ? "Function 不存在" : collection === "filters" ? "Filter 不存在" : "Define 不存在");
  return resource;
}

function nodePeers(state, nodeId) {
  return state.peers.filter((item) => item.nodeId === nodeId);
}

function nodeSessions(state, nodeId) {
  return state.sessions.filter((item) => item.nodeId === nodeId);
}

function nodePolicyResources(state, collection, nodeId, enabledOnly = false) {
  return state[collection].filter((item) =>
    (item.nodeId === null || item.nodeId === nodeId) && (!enabledOnly || item.enabled),
  );
}

function nodeRPKIResources(state, nodeId, enabledOnly = false) {
  return (state.rpki ?? []).filter((item) =>
    (item.nodeId === null || item.nodeId === nodeId) && (!enabledOnly || item.enabled),
  );
}

function nodeStaticProtocols(state, nodeId, enabledOnly = false) {
  return (state.staticProtocols ?? []).filter((item) =>
    item.nodeId === nodeId && (!enabledOnly || item.enabled),
  );
}

function ownedNodePolicyResources(state, nodeId) {
  return [...state.defines, ...state.functions, ...state.filters, ...(state.rpki ?? []), ...(state.staticProtocols ?? [])]
    .filter((item) => item.nodeId === nodeId);
}

function resourceReferencesSymbol(state, symbol, excludedId = null) {
  return [...state.defines, ...state.functions, ...state.filters].some((resource) =>
    resource.id !== excludedId && birdSourceReferencesSymbol(resource.value ?? resource.source ?? "", symbol),
  ) || (state.staticProtocols ?? []).some((resource) =>
    resource.id !== excludedId && birdSourceReferencesSymbol(resource.raw, symbol),
  );
}

function configForNode(state, node) {
  return renderBirdConfig(
    node,
    nodePeers(state, node.id),
    nodeSessions(state, node.id),
    nodePolicyResources(state, "functions", node.id),
    nodePolicyResources(state, "filters", node.id),
    nodePolicyResources(state, "defines", node.id),
    nodeRPKIResources(state, node.id),
    nodeStaticProtocols(state, node.id),
  );
}

function deploymentTargets(inventory, nodeIds, fallbackNodes = []) {
  const fallbackById = new Map(fallbackNodes.map((node) => [node.id, node]));
  return uniqueNodeIds(nodeIds).map((nodeId) => {
    const inventoryNode = inventory.nodes.find((node) => node.id === nodeId);
    const node = inventoryNode ?? fallbackById.get(nodeId);
    if (!node) fail(500, `部署日志无法解析节点 ${nodeId}`);
    return {
      node,
      config: inventoryNode
        ? configForNode(inventory, inventoryNode)
        : renderBirdConfig(node, [], [], [], [], [], [], []),
    };
  });
}

function validateDeploymentJournal(value) {
  if (!value || value.version !== 1 || !(Object.hasOwn(value, "active"))) {
    throw new Error("部署恢复日志格式不兼容");
  }
  if (value.active === null) return { version: 1, active: null };
  const active = value.active;
  if (!active || typeof active.id !== "string" || !["forward", "rollback"].includes(active.direction)) {
    throw new Error("部署恢复日志内容不合法");
  }
  const before = validateInventory(active.before);
  const after = validateInventory(active.after);
  const normalizeTargets = (targets) => {
    if (!Array.isArray(targets)) throw new Error("部署恢复日志缺少节点目标");
    const seen = new Set();
    return targets.map((target) => {
      const node = normalizeNode(target?.node);
      if (seen.has(node.id) || typeof target?.config !== "string") throw new Error("部署恢复日志节点目标不合法");
      seen.add(node.id);
      return { node, config: target.config };
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

async function readDeploymentJournal() {
  const record = await database.readState(DEPLOYMENT_JOURNAL_KEY);
  return validateDeploymentJournal(record?.value ?? EMPTY_DEPLOYMENT_JOURNAL);
}

async function beginDeploymentJournal(before, after, nodeIds, fallbackNodes = []) {
  const active = {
    id: `deployment_${randomUUID()}`,
    direction: "forward",
    before,
    after,
    forwardTargets: deploymentTargets(after, nodeIds, fallbackNodes),
    rollbackTargets: deploymentTargets(before, nodeIds, fallbackNodes),
  };
  await database.mutateState(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL, (current) => {
    const journal = validateDeploymentJournal(current);
    if (journal.active) fail(503, "存在尚未完成的部署恢复任务，请重启服务完成恢复");
    return { value: { version: 1, active } };
  });
  return active;
}

async function setDeploymentJournalDirection(active, direction) {
  await database.mutateState(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL, (current) => {
    const journal = validateDeploymentJournal(current);
    if (journal.active?.id !== active.id) throw new Error("部署恢复日志已被意外替换");
    return { value: { version: 1, active: { ...journal.active, direction } } };
  });
}

async function clearDeploymentJournal(active) {
  await database.mutateState(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL, (current) => {
    const journal = validateDeploymentJournal(current);
    if (journal.active?.id !== active.id) throw new Error("部署恢复日志已被意外替换");
    return { value: { version: 1, active: null } };
  });
}

async function recoverDeploymentJournal() {
  return withDeploymentLock(async () => {
    const journal = await readDeploymentJournal();
    const active = journal.active;
    if (!active) return;
    const actual = await store.read();
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
        const applied = await applyStagedConfig(target.node);
        if (!applied.ok) throw new Error(applied.stderr || applied.stdout || `${target.node.name} 的恢复配置应用失败`);
      }
    }
    if (!isDeepStrictEqual(actual, desired)) await store.replace(actual, desired);
    await clearDeploymentJournal(active);
    event("warning", `已完成中断部署 ${active.id} 的${active.direction === "forward" ? "提交" : "回滚"}恢复`);
  }, { allowPendingJournal: true });
}

function deploymentReport(inventory, nodeIds) {
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

async function mutateAndApply(mutator, nodeIdsForDraft) {
  return withDeploymentLock(async () => {
    const attemptedNodes = [];
    let committed = false;
    let current;
    let inventory;
    let deployment;
    let journal = null;
    try {
      current = await store.read();
      const draft = structuredClone(current);
      const mutation = await mutator(draft);
      inventory = validateInventory(draft);
      const nodeIds = uniqueNodeIds(typeof nodeIdsForDraft === "function" ? nodeIdsForDraft(mutation, inventory) : nodeIdsForDraft);
      const nodes = nodeIds.map((nodeId) => findNode(inventory, nodeId));

      for (const node of nodes) {
        const validation = await stageAndValidate(node, configForNode(inventory, node));
        if (!validation.ok) fail(422, validation.stderr || `${node.name} 的 BIRD 语法检查失败`);
      }
      if (nodes.length) journal = await beginDeploymentJournal(current, inventory, nodeIds, nodes);
      for (const node of nodes) {
        attemptedNodes.push(node);
        const applied = await applyStagedConfig(node);
        if (!applied.ok) fail(500, applied.stderr || applied.stdout || `${node.name} 的 BIRD 配置应用失败`);
      }
      const state = await store.replace(current, inventory);
      committed = true;
      if (journal) {
        await clearDeploymentJournal(journal);
        journal = null;
      }
      deployment = deploymentReport(inventory, nodeIds);
      return { state, result: mutation, deployment };
    } catch (error) {
      if (!committed) {
        let journalMarkedForRollback = false;
        if (journal) {
          try {
            await setDeploymentJournalDirection(journal, "rollback");
            journalMarkedForRollback = true;
          } catch (journalError) {
            console.error(journalError);
          }
        }
        let rollbackSucceeded = true;
        for (const node of attemptedNodes.reverse()) {
          const rollback = await rollbackNode(node);
          if (!rollback.ok) {
            rollbackSucceeded = false;
            event("error", `${node.name} 回滚失败：${rollback.stderr || rollback.stdout}`, node.id);
          }
        }
        if (journal && journalMarkedForRollback && rollbackSucceeded) {
          try {
            await clearDeploymentJournal(journal);
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

async function preflightPolicyResource(stateInput, collection, resourceId) {
  const probe = structuredClone(stateInput);
  const resource = findPolicyResource(probe, collection, resourceId);
  resource.enabled = true;
  const state = validateInventory(probe);
  const nodes = resource.nodeId === null
    ? state.nodes
    : [findNode(state, resource.nodeId)];
  for (const node of nodes) {
    const validation = await stageAndValidate(node, configForNode(state, node));
    if (!validation.ok) fail(422, validation.stderr || `${resource.name} 的 BIRD 语法检查失败`);
  }
}

async function preflightRPKIResource(stateInput, resourceId) {
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

async function preflightStaticProtocol(stateInput, resourceId) {
  const probe = structuredClone(stateInput);
  const resource = probe.staticProtocols.find((item) => item.id === resourceId);
  if (!resource) fail(404, "Static 资源不存在");
  resource.enabled = true;
  const state = validateInventory(probe);
  const node = findNode(state, resource.nodeId);
  const validation = await stageAndValidate(node, configForNode(state, node));
  if (!validation.ok) fail(422, validation.stderr || `${resource.name} 的 BIRD 语法检查失败`);
}

function protocolFor(runtime, protocolName) {
  return runtime.protocols.find((item) => item.name === protocolName) ?? {
    name: protocolName,
    configured: false,
    disabled: false,
    state: null,
    established: false,
    neighbor: null,
    neighborAs: null,
    imported: null,
    exported: null,
  };
}

function summarizeInventoryHealth(state, runtimes) {
  const runtimeByNodeId = new Map(runtimes.map((runtime) => [runtime.nodeId, runtime]));
  let onlineNodes = 0;
  let activeSessions = 0;
  let normalSessions = 0;

  for (const node of state.nodes) {
    const runtime = runtimeByNodeId.get(node.id);
    const online = runtime?.reachable === true && runtime.bird2 === true;
    if (online) onlineNodes += 1;
    for (const session of nodeSessions(state, node.id)) {
      if (session.enabled === false) continue;
      activeSessions += 1;
      const protocol = protocolFor(runtime ?? { protocols: [] }, session.protocolName);
      if (online && protocol.established && protocol.disabled !== true) normalSessions += 1;
    }
  }

  const offlineNodes = state.nodes.length - onlineNodes;
  const abnormalSessions = activeSessions - normalSessions;
  return {
    status: offlineNodes > 0 ? "error" : abnormalSessions > 0 ? "warning" : "ready",
    totalNodes: state.nodes.length,
    onlineNodes,
    activeSessions,
    normalSessions,
    abnormalSessions,
  };
}

function normalizeSshNode(input) {
  if (input.transport !== "ssh") fail(400, "Birdbox 仅支持 SSH 管理节点");
  return normalizeNode(input);
}

function normalizeOnboardingNode(input, id = "node_onboarding") {
  const node = normalizeSshNode({
    ...input,
    id,
    transport: input.transport ?? "ssh",
    deploymentMode: input.deploymentMode ?? "include",
    sshIdentity: input.sshIdentity ?? "managed",
  });
  if (node.deploymentMode !== "include" || node.sshIdentity !== "managed") {
    fail(400, "新节点必须使用 Include 模式和 Birdbox 托管 SSH 密钥");
  }
  if (node.sshUser === "root") fail(400, "新节点必须使用专用的非 root SSH 用户");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(node.sshUser)) {
    fail(400, "新节点的 SSH 用户名必须使用可移植的小写 Linux 用户名");
  }
  return node;
}

function nodeSetupScript(node) {
  const directory = path.posix.dirname(node.generatedConfigPath);
  const includeLine = `include "${node.generatedConfigPath}";`;
  return {
    includeLine,
    script: `#!/bin/sh
set -eu
umask 077

BIRDBOX_USER='${node.sshUser}'
MAIN_CONFIG='${node.mainConfigPath}'
GENERATED_CONFIG='${node.generatedConfigPath}'
CONFIG_DIR='${directory}'
SOCKET_PATH='${node.socketPath}'
CONTROLLER_KEY='${controllerPublicKey}'
KEY_LINE="restrict $CONTROLLER_KEY"
INCLUDE_LINE='${includeLine}'

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo sh 执行此脚本" >&2
  exit 1
fi
test -f "$MAIN_CONFIG" || { echo "主配置不存在：$MAIN_CONFIG" >&2; exit 1; }
test -S "$SOCKET_PATH" || { echo "BIRD Socket 不存在：$SOCKET_PATH" >&2; exit 1; }
for REQUIRED_COMMAND in birdc stat install mktemp awk grep; do
  command -v "$REQUIRED_COMMAND" >/dev/null 2>&1 || { echo "缺少 $REQUIRED_COMMAND 命令" >&2; exit 1; }
done
BIRD_GROUP=$(stat -c '%G' "$SOCKET_PATH")
BIRD_GROUP_ID=$(stat -c '%g' "$SOCKET_PATH")
case "$BIRD_GROUP" in
  ''|UNKNOWN) echo "无法识别 BIRD Socket 用户组" >&2; exit 1 ;;
esac
if [ "$BIRD_GROUP" = root ] || [ "$BIRD_GROUP_ID" = 0 ]; then
  echo "BIRD Socket 不能使用 root 用户组，请先为 BIRD 配置专用控制组" >&2
  exit 1
fi

if ! id "$BIRDBOX_USER" >/dev/null 2>&1; then
  USER_HOME="/var/lib/birdbox-users/$BIRDBOX_USER"
  install -d -o root -g root -m 0755 /var/lib/birdbox-users
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --create-home --user-group --home-dir "$USER_HOME" --shell /bin/sh "$BIRDBOX_USER"
  elif command -v adduser >/dev/null 2>&1; then
    if adduser --system --disabled-password --gecos '' --home "$USER_HOME" --shell /bin/sh --group "$BIRDBOX_USER"; then
      :
    else
      adduser -D -h "$USER_HOME" -s /bin/sh "$BIRDBOX_USER"
    fi
  else
    echo "无法创建用户：缺少 useradd/adduser" >&2
    exit 1
  fi
fi
id "$BIRDBOX_USER" >/dev/null 2>&1 || { echo "创建用户 $BIRDBOX_USER 失败" >&2; exit 1; }
[ "$(id -u "$BIRDBOX_USER")" -ne 0 ] || { echo "Birdbox SSH 用户不能是 root" >&2; exit 1; }
if ! id -nG "$BIRDBOX_USER" | tr ' ' '\n' | grep -Fx -- "$BIRD_GROUP" >/dev/null 2>&1; then
  if command -v usermod >/dev/null 2>&1; then
    usermod -a -G "$BIRD_GROUP" "$BIRDBOX_USER"
  elif command -v addgroup >/dev/null 2>&1; then
    addgroup "$BIRDBOX_USER" "$BIRD_GROUP"
  elif command -v gpasswd >/dev/null 2>&1; then
    gpasswd -a "$BIRDBOX_USER" "$BIRD_GROUP"
  else
    echo "无法把 $BIRDBOX_USER 加入 $BIRD_GROUP 用户组" >&2
    exit 1
  fi
fi
id -nG "$BIRDBOX_USER" | tr ' ' '\n' | grep -Fx -- "$BIRD_GROUP" >/dev/null 2>&1 || {
  echo "$BIRDBOX_USER 未成功加入 $BIRD_GROUP 用户组" >&2
  exit 1
}

if [ -L "$CONFIG_DIR" ]; then
  echo "$CONFIG_DIR 不能是符号链接" >&2
  exit 1
fi
if [ -e "$CONFIG_DIR" ]; then
  test -d "$CONFIG_DIR" || { echo "$CONFIG_DIR 不是目录" >&2; exit 1; }
  [ "$(stat -c '%U:%G' "$CONFIG_DIR")" = "$BIRDBOX_USER:$BIRD_GROUP" ] || {
    echo "$CONFIG_DIR 已存在但不属于 $BIRDBOX_USER:$BIRD_GROUP，拒绝接管" >&2
    exit 1
  }
else
  install -d -o "$BIRDBOX_USER" -g "$BIRD_GROUP" -m 0750 "$CONFIG_DIR"
fi
if [ -L "$CONFIG_DIR/versions" ]; then
  echo "$CONFIG_DIR/versions 不能是符号链接" >&2
  exit 1
fi
if [ -e "$CONFIG_DIR/versions" ]; then
  test -d "$CONFIG_DIR/versions" || { echo "$CONFIG_DIR/versions 不是目录" >&2; exit 1; }
  [ "$(stat -c '%U:%G' "$CONFIG_DIR/versions")" = "$BIRDBOX_USER:$BIRD_GROUP" ] || {
    echo "$CONFIG_DIR/versions 已存在但不属于 $BIRDBOX_USER:$BIRD_GROUP，拒绝接管" >&2
    exit 1
  }
else
  install -d -o "$BIRDBOX_USER" -g "$BIRD_GROUP" -m 0750 "$CONFIG_DIR/versions"
fi
chmod 0750 "$CONFIG_DIR" "$CONFIG_DIR/versions"
if [ -L "$GENERATED_CONFIG" ]; then
  CURRENT_TARGET=$(readlink "$GENERATED_CONFIG")
  TARGET_FILE=\${CURRENT_TARGET#versions/}
  case "$CURRENT_TARGET:$TARGET_FILE" in
    versions/*:|versions/*:.|versions/*:..|versions/*:*/*) echo "$GENERATED_CONFIG 的现有目标不安全" >&2; exit 1 ;;
    versions/*:*) ;;
    *) echo "$GENERATED_CONFIG 必须指向 versions 目录中的文件" >&2; exit 1 ;;
  esac
elif [ -e "$GENERATED_CONFIG" ]; then
  echo "$GENERATED_CONFIG 已存在且不是符号链接，拒绝覆盖" >&2
  exit 1
else
  printf '%s\n' '# Birdbox initial empty include' > "$CONFIG_DIR/versions/initial.conf"
  chown "$BIRDBOX_USER:$BIRD_GROUP" "$CONFIG_DIR/versions/initial.conf"
  chmod 0640 "$CONFIG_DIR/versions/initial.conf"
  ln -s 'versions/initial.conf' "$GENERATED_CONFIG"
  chown -h "$BIRDBOX_USER:$BIRD_GROUP" "$GENERATED_CONFIG" 2>/dev/null || true
fi

if command -v getent >/dev/null 2>&1; then
  PASSWD_ENTRY=$(getent passwd "$BIRDBOX_USER")
else
  PASSWD_ENTRY=$(awk -F: -v user="$BIRDBOX_USER" '$1 == user { print; exit }' /etc/passwd)
fi
HOME_DIR=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f6)
USER_SHELL=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f7)
PRIMARY_GROUP=$(id -gn "$BIRDBOX_USER")
case "$HOME_DIR" in
  /?*) ;;
  *) echo "$BIRDBOX_USER 的 Home 目录不合法" >&2; exit 1 ;;
esac
case "$USER_SHELL" in
  */nologin|*/false)
    if command -v usermod >/dev/null 2>&1; then
      usermod -s /bin/sh "$BIRDBOX_USER"
    elif command -v chsh >/dev/null 2>&1; then
      chsh -s /bin/sh "$BIRDBOX_USER"
    else
      echo "无法为 $BIRDBOX_USER 设置可执行 SSH 命令的 Shell" >&2
      exit 1
    fi
    ;;
esac
test ! -L "$HOME_DIR" || { echo "$BIRDBOX_USER 的 Home 目录不能是符号链接" >&2; exit 1; }
if [ -e "$HOME_DIR" ]; then
  test -d "$HOME_DIR" || { echo "$BIRDBOX_USER 的 Home 路径不是目录" >&2; exit 1; }
  [ "$(stat -c '%U' "$HOME_DIR")" = "$BIRDBOX_USER" ] || { echo "$BIRDBOX_USER 的 Home 目录属主不正确" >&2; exit 1; }
else
  install -d -o "$BIRDBOX_USER" -g "$PRIMARY_GROUP" -m 0750 "$HOME_DIR"
fi
if [ -L "$HOME_DIR/.ssh" ]; then
  echo "$HOME_DIR/.ssh 不能是符号链接" >&2
  exit 1
elif [ -e "$HOME_DIR/.ssh" ]; then
  test -d "$HOME_DIR/.ssh" || { echo "$HOME_DIR/.ssh 不是目录" >&2; exit 1; }
  [ "$(stat -c '%U:%G' "$HOME_DIR/.ssh")" = "$BIRDBOX_USER:$PRIMARY_GROUP" ] || { echo "$HOME_DIR/.ssh 属主不正确" >&2; exit 1; }
else
  install -d -o "$BIRDBOX_USER" -g "$PRIMARY_GROUP" -m 0700 "$HOME_DIR/.ssh"
fi
chmod 0700 "$HOME_DIR/.ssh"
if [ -L "$HOME_DIR/.ssh/authorized_keys" ]; then
  echo "$HOME_DIR/.ssh/authorized_keys 不能是符号链接" >&2
  exit 1
elif [ -e "$HOME_DIR/.ssh/authorized_keys" ]; then
  test -f "$HOME_DIR/.ssh/authorized_keys" || { echo "$HOME_DIR/.ssh/authorized_keys 不是普通文件" >&2; exit 1; }
  [ "$(stat -c '%U:%G' "$HOME_DIR/.ssh/authorized_keys")" = "$BIRDBOX_USER:$PRIMARY_GROUP" ] || { echo "$HOME_DIR/.ssh/authorized_keys 属主不正确" >&2; exit 1; }
else
  install -o "$BIRDBOX_USER" -g "$PRIMARY_GROUP" -m 0600 /dev/null "$HOME_DIR/.ssh/authorized_keys"
fi
chmod 0600 "$HOME_DIR/.ssh/authorized_keys"
if ! grep -Fx -- "$KEY_LINE" "$HOME_DIR/.ssh/authorized_keys" >/dev/null 2>&1; then
  CONTROLLER_KEY_ID=$(printf '%s\n' "$CONTROLLER_KEY" | awk '{ print $1 " " $2 }')
  KEY_TEMP=$(mktemp "$HOME_DIR/.ssh/authorized_keys.birdbox.XXXXXX")
  trap 'rm -f "$KEY_TEMP"' 0
  trap 'rm -f "$KEY_TEMP"; exit 1' 1 2 15
  grep -Fv -- "$CONTROLLER_KEY_ID" "$HOME_DIR/.ssh/authorized_keys" > "$KEY_TEMP" || true
  printf '%s\n' "$KEY_LINE" >> "$KEY_TEMP"
  chown "$BIRDBOX_USER:$PRIMARY_GROUP" "$KEY_TEMP"
  chmod 0600 "$KEY_TEMP"
  mv -f "$KEY_TEMP" "$HOME_DIR/.ssh/authorized_keys"
  trap - 0 1 2 15
fi

has_active_include() {
  awk -v target="$GENERATED_CONFIG" '${ACTIVE_BIRD_INCLUDE_AWK}' "$MAIN_CONFIG"
}

MAIN_BACKUP=''
restore_main_config() {
  if [ -n "$MAIN_BACKUP" ] && [ -f "$MAIN_BACKUP" ]; then
    cp -p "$MAIN_BACKUP" "$MAIN_CONFIG"
    rm -f "$MAIN_BACKUP"
    MAIN_BACKUP=''
  fi
}
trap 'restore_main_config' 0
trap 'restore_main_config; exit 1' 1 2 15

if ! has_active_include; then
  BACKUP_CANDIDATE=$(mktemp "$MAIN_CONFIG.birdbox.XXXXXX")
  if ! cp -p "$MAIN_CONFIG" "$BACKUP_CANDIDATE"; then
    rm -f "$BACKUP_CANDIDATE"
    echo "无法备份 BIRD 主配置" >&2
    exit 1
  fi
  MAIN_BACKUP="$BACKUP_CANDIDATE"
  printf '\n%s\n' "$INCLUDE_LINE" >> "$MAIN_CONFIG"
fi

if ! birdc -s "$SOCKET_PATH" 'configure check'; then
  restore_main_config
  echo "BIRD configure check 失败，主配置已恢复" >&2
  exit 1
fi
if ! birdc -s "$SOCKET_PATH" configure; then
  restore_main_config
  birdc -s "$SOCKET_PATH" configure >/dev/null 2>&1 || true
  echo "BIRD configure 失败，主配置已恢复" >&2
  exit 1
fi
if [ -n "$MAIN_BACKUP" ]; then
  rm -f "$MAIN_BACKUP" || true
  MAIN_BACKUP=''
fi
trap - 0 1 2 15

echo "Birdbox 节点准备完成：用户、SSH 公钥、Include 和 BIRD 配置均已就绪"
`,
  };
}

async function inspectOnboardingNode(node) {
  const access = await checkIncludeNodeAccess(node);
  if (!access.ok) fail(422, access.stderr || access.stdout || "节点接入条件检查失败");
  const runtime = await inspectNode(node);
  if (!runtime.reachable || !runtime.bird2) fail(422, runtime.error || "目标节点未运行受支持的 BIRD 2");
  return runtime;
}

async function verifyOnboardingNode(node, config) {
  const runtime = await inspectOnboardingNode(node);
  const validation = await stageAndValidate(node, config);
  if (!validation.ok) fail(422, validation.stderr || validation.stdout || "系统主配置预检失败");
  return { runtime, validation: { ok: true } };
}

async function decommissionNode(nodeId, force = false) {
  return withDeploymentLock(async () => {
    let applied = false;
    let committed = false;
    let node;
    let journal = null;
    try {
      const current = await store.read();
      node = findNode(current, nodeId);
      if (force) {
        const inventory = validateInventory({
          ...current,
          nodes: current.nodes.filter((item) => item.id !== node.id),
          peers: current.peers.filter((item) => item.nodeId !== node.id),
          sessions: current.sessions.filter((item) => item.nodeId !== node.id),
          defines: current.defines.filter((item) => item.nodeId !== node.id),
          functions: current.functions.filter((item) => item.nodeId !== node.id),
          filters: current.filters.filter((item) => item.nodeId !== node.id),
          rpki: current.rpki.filter((item) => item.nodeId !== node.id),
          staticProtocols: current.staticProtocols.filter((item) => item.nodeId !== node.id),
        });
        const state = await store.replace(current, inventory);
        committed = true;
        return { state, node, forced: true };
      }
      if (nodePeers(current, node.id).length || ownedNodePolicyResources(current, node.id).length || nodeSessions(current, node.id).length) {
        fail(409, "请先删除该节点的会话、Peer 和节点级资源");
      }
      const inventory = validateInventory({
        ...current,
        nodes: current.nodes.filter((item) => item.id !== node.id),
      });
      const validation = await stageAndValidate(node, renderBirdConfig(node, [], [], [], [], [], []));
      if (!validation.ok) fail(422, validation.stderr || validation.stdout || "节点退役配置检查失败");
      journal = await beginDeploymentJournal(current, inventory, [node.id], [node]);
      applied = true;
      const result = await applyStagedConfig(node);
      if (!result.ok) fail(500, result.stderr || result.stdout || "节点退役配置应用失败");
      const state = await store.replace(current, inventory);
      committed = true;
      await clearDeploymentJournal(journal);
      journal = null;
      return { state, node, forced: false };
    } catch (error) {
      if (applied && !committed && node) {
        let journalMarkedForRollback = false;
        if (journal) {
          try {
            await setDeploymentJournalDirection(journal, "rollback");
            journalMarkedForRollback = true;
          } catch (journalError) {
            console.error(journalError);
          }
        }
        const rollback = await rollbackNode(node);
        if (!rollback.ok) event("error", `${node.name} 退役回滚失败：${rollback.stderr || rollback.stdout}`, node.id);
        else if (journal && journalMarkedForRollback) {
          try {
            await clearDeploymentJournal(journal);
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

function prepareSession(state, payload) {
  const node = findNode(state, payload.nodeId);
  const peer = findPeer(state, payload.peerId);
  if (peer.nodeId !== node.id) fail(400, "所选 Peer 不属于该节点");
  const requestedChannels = payload.channels ?? {
    ipv4: {
      ...(payload.ipv4 ?? {}),
      enabled: true,
      exportDefineId: payload.exportDefineId ?? payload.prefixListId ?? null,
      importPolicy: payload.importPolicy,
      exportPolicy: payload.exportPolicy,
    },
    ipv6: { enabled: true },
  };
  const exportDefines = {};
  for (const family of ["ipv4", "ipv6"]) {
    const requestedDefineId = requestedChannels[family]?.exportDefineId;
    const exportDefine = requestedDefineId === null || requestedDefineId === undefined || requestedDefineId === ""
      ? null
      : findPolicyResource(state, "defines", requestedDefineId);
    const expectedType = family === "ipv4" ? "cidr4" : "cidr6";
    if (exportDefine && (exportDefine.type !== expectedType || !exportDefine.enabled)) fail(400, `所选 Define 不是可用的 ${family.toUpperCase()} CIDR 类型`);
    if (exportDefine && exportDefine.nodeId !== null && exportDefine.nodeId !== node.id) fail(400, "所选 CIDR Define 对该节点不可用");
    exportDefines[family] = exportDefine;
  }
  const existing = state.sessions.find((item) => item.nodeId === node.id && item.peerId === peer.id);
  const session = normalizeSession({
    id: existing?.id ?? makeId("session"),
    nodeId: node.id,
    peerId: peer.id,
    protocolName: payload.protocolName,
    localAddress: payload.localAddress,
    localAsn: payload.localAsn,
    localPort: payload.localPort,
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

async function stageSession(state, payload) {
  const prepared = prepareSession(state, payload);
  const validation = await stageAndValidate(prepared.node, prepared.config);
  return { ...prepared, validation, valid: validation.ok };
}

async function waitForProtocol(node, protocolName, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let runtime;
  let protocol;
  do {
    runtime = await inspectNode(node);
    protocol = protocolFor(runtime, protocolName);
    if (protocol.established) return { runtime, protocol };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  return { runtime, protocol };
}

function chooseSelection(state, requestedNodeId, requestedPeerId) {
  const node = state.nodes.find((item) => item.id === requestedNodeId) ?? state.nodes[0];
  if (!node) return { node: null, peer: null, peers: [] };
  const peers = nodePeers(state, node.id);
  const peer = peers.find((item) => item.id === requestedPeerId) ?? peers[0] ?? null;
  return { node, peer, peers };
}

async function dashboard(state, requestedNodeId, requestedPeerId) {
  const selection = chooseSelection(state, requestedNodeId, requestedPeerId);
  if (!selection.node) {
    return {
      inventory: state,
      selection: { nodeId: null, peerId: null },
      node: null,
      peers: [],
      cidrDefines: { ipv4: [], ipv6: [] },
      defines: [],
      functions: [],
      filters: [],
      rpki: [],
      staticProtocols: [],
      selectedPeer: null,
      runtime: { nodeId: null, reachable: false, bird2: false, version: null, protocols: [], error: "尚未添加受管节点" },
      health: summarizeInventoryHealth(state, []),
      established: false,
      config: "",
      events,
    };
  }
  const runtimes = await Promise.all(state.nodes.map((node) => inspectNode(node)));
  const runtime = runtimes.find((item) => item.nodeId === selection.node.id) ?? {
    nodeId: selection.node.id, reachable: false, bird2: false, version: null, protocols: [], error: "节点状态不可用",
  };
  const peers = selection.peers.map((peer) => {
    const session = state.sessions.find((item) => item.nodeId === selection.node.id && item.peerId === peer.id) ?? null;
    const protocolName = session?.protocolName;
    const protocol = session
      ? protocolFor(runtime, protocolName)
      : null;
    return {
      ...peer,
      session,
      protocol,
    };
  });
  const selected = peers.find((item) => item.id === selection.peer?.id) ?? null;
  return {
    inventory: state,
    selection: { nodeId: selection.node.id, peerId: selected?.id ?? null },
    node: selection.node,
    peers,
    cidrDefines: {
      ipv4: nodePolicyResources(state, "defines", selection.node.id, true).filter((item) => item.type === "cidr4"),
      ipv6: nodePolicyResources(state, "defines", selection.node.id, true).filter((item) => item.type === "cidr6"),
    },
    defines: nodePolicyResources(state, "defines", selection.node.id, true),
    functions: nodePolicyResources(state, "functions", selection.node.id, true),
    filters: nodePolicyResources(state, "filters", selection.node.id, true),
    rpki: nodeRPKIResources(state, selection.node.id, true),
    staticProtocols: nodeStaticProtocols(state, selection.node.id, true),
    selectedPeer: selected,
    runtime,
    health: summarizeInventoryHealth(state, runtimes),
    established: selected?.protocol?.established ?? false,
    config: configForNode(state, selection.node),
    events,
  };
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) fail(413, "请求体过大");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "JSON 请求体必须是对象");
    return value;
  } catch {
    fail(400, "JSON 请求体必须是合法对象");
  }
}

function requestSessionToken(request) {
  const cookie = String(request.headers.cookie ?? "");
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== AUTH_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(valueParts.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function secureCookieEnabled(request) {
  if (secureCookieSetting !== null) return secureCookieSetting;
  return Boolean(request.socket.encrypted) || String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function sessionCookie(request, token, maxAgeSeconds = Math.floor(AUTH_SESSION_TTL_MS / 1000)) {
  const secure = secureCookieEnabled(request) ? "; Secure" : "";
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function assertSameOrigin(request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host.toLowerCase() !== String(request.headers.host ?? "").toLowerCase()) fail(403, "请求来源不受信任");
  } catch {
    fail(403, "请求来源不受信任");
  }
}

function loginAttemptKey(request) {
  return request.socket.remoteAddress ?? "unknown";
}

function authSessionContext(request) {
  return {
    address: request.socket.remoteAddress ?? "",
    userAgent: request.headers["user-agent"] ?? "",
  };
}

function activeLoginFailures(request) {
  const key = loginAttemptKey(request);
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((attempt) => now - attempt.timestamp < LOGIN_ATTEMPT_WINDOW_MS);
  if (recent.length) loginFailures.set(key, recent);
  else loginFailures.delete(key);
  return recent;
}

function pruneLoginFailureKeys() {
  const now = Date.now();
  if (loginFailures.size < MAX_LOGIN_FAILURE_KEYS && now - lastLoginFailurePruneAt < 60000) return;
  for (const [key, attempts] of loginFailures) {
    const recent = attempts.filter((attempt) => now - attempt.timestamp < LOGIN_ATTEMPT_WINDOW_MS);
    if (recent.length) loginFailures.set(key, recent);
    else loginFailures.delete(key);
  }
  lastLoginFailurePruneAt = now;
}

function reserveLoginAttempt(request) {
  pruneLoginFailureKeys();
  const key = loginAttemptKey(request);
  const recent = activeLoginFailures(request);
  if (recent.length >= LOGIN_ATTEMPT_LIMIT) {
    const error = new Error("登录尝试过多，请稍后再试");
    error.status = 429;
    error.code = "AUTH_RATE_LIMITED";
    request.resume();
    throw error;
  }
  if (!loginFailures.has(key) && loginFailures.size >= MAX_LOGIN_FAILURE_KEYS) {
    request.resume();
    const error = new Error("登录尝试过多，请稍后再试");
    error.status = 429;
    error.code = "AUTH_RATE_LIMITED";
    throw error;
  }
  const reservation = { id: ++loginAttemptSequence, timestamp: Date.now() };
  loginFailures.set(key, [...recent, reservation]);
  return { key, id: reservation.id };
}

function cancelLoginAttempt(reservation) {
  const remaining = (loginFailures.get(reservation.key) ?? []).filter((attempt) => attempt.id !== reservation.id);
  if (remaining.length) loginFailures.set(reservation.key, remaining);
  else loginFailures.delete(reservation.key);
}

function clearLoginFailures(request) {
  loginFailures.delete(loginAttemptKey(request));
}

async function handleAuthApi(request, response, url) {
  const { pathname } = url;
  const token = requestSessionToken(request);
  if (request.method === "GET" && pathname === "/api/auth/status") {
    sendJson(response, 200, await authStore.status(token));
    return true;
  }
  if (request.method === "POST" && pathname === "/api/auth/setup") {
    const body = await readJson(request);
    const sessionToken = await authStore.setup(body.password, body.confirmation, authSessionContext(request));
    sendJson(response, 201, { ok: true, ...await authStore.status(sessionToken) }, {
      "set-cookie": sessionCookie(request, sessionToken),
    });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const reservation = reserveLoginAttempt(request);
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      cancelLoginAttempt(reservation);
      throw error;
    }
    let sessionToken;
    try {
      sessionToken = await authStore.login(body.password, authSessionContext(request));
    } catch (error) {
      cancelLoginAttempt(reservation);
      throw error;
    }
    if (!sessionToken) {
      const error = new Error("密码不正确");
      error.status = 401;
      error.code = "AUTH_INVALID";
      throw error;
    }
    clearLoginFailures(request);
    sendJson(response, 200, { ok: true, ...await authStore.status(sessionToken) }, {
      "set-cookie": sessionCookie(request, sessionToken),
    });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/auth/password") {
    const body = await readJson(request);
    const sessionToken = await authStore.changePassword(
      token,
      body.currentPassword,
      body.password,
      body.confirmation,
      authSessionContext(request),
    );
    sendJson(response, 200, { ok: true, ...await authStore.status(sessionToken) }, {
      "set-cookie": sessionCookie(request, sessionToken),
    });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/auth/sessions") {
    sendJson(response, 200, { sessions: await authStore.listSessions(token) });
    return true;
  }
  if (request.method === "DELETE" && pathname === "/api/auth/sessions") {
    const revoked = await authStore.revokeOtherSessions(token);
    sendJson(response, 200, { ok: true, revoked });
    return true;
  }
  const sessionMatch = pathname.match(/^\/api\/auth\/sessions\/([A-Za-z0-9_-]{16,64})$/);
  if (request.method === "DELETE" && sessionMatch) {
    const result = await authStore.revokeSession(token, sessionMatch[1]);
    const headers = result.current ? { "set-cookie": sessionCookie(request, "", 0) } : {};
    sendJson(response, 200, { ok: true, current: result.current }, headers);
    return true;
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    await authStore.logout(token);
    sendJson(response, 200, { ok: true }, { "set-cookie": sessionCookie(request, "", 0) });
    return true;
  }
  return false;
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  if (request.method === "GET" && pathname === "/api/health") {
    await database.ping();
    return sendJson(response, 200, { status: "ok", deploymentLocked });
  }

  if (request.method === "GET" && (pathname === "/api/dashboard" || pathname === "/api/session")) {
    const state = await store.read();
    return sendJson(response, 200, await dashboard(state, searchParams.get("nodeId"), searchParams.get("peerId")));
  }

  if (request.method === "POST" && pathname === "/api/nodes/setup-script") {
    const node = normalizeOnboardingNode(await readJson(request));
    return sendJson(response, 200, { ...nodeSetupScript(node), publicKey: controllerPublicKey });
  }

  if (request.method === "POST" && pathname === "/api/nodes/test") {
    const node = normalizeOnboardingNode(await readJson(request));
    const verification = await withDeploymentLock(async () => {
      const current = await store.read();
      const candidate = structuredClone(current);
      candidate.nodes.push(node);
      const inventory = validateInventory(candidate);
      return verifyOnboardingNode(node, configForNode(inventory, node));
    });
    return sendJson(response, 200, {
      ok: true,
      node: { name: node.name, sshHost: node.sshHost, sshPort: node.sshPort, sshUser: node.sshUser },
      runtime: { version: verification.runtime.version, bird2: verification.runtime.bird2 },
    });
  }

  if (request.method === "POST" && pathname === "/api/nodes") {
    const body = await readJson(request);
    const node = normalizeOnboardingNode(body, makeId("node"));
    const { state, deployment } = await mutateAndApply(async (draft) => {
      await inspectOnboardingNode(node);
      draft.nodes.push(node);
      return node;
    }, () => [node.id]);
    event("success", `已添加受管节点 ${node.name}`, node.id);
    return sendJson(response, 201, { node, inventory: state, deployment, events });
  }

  const nodeMatch = pathname.match(/^\/api\/nodes\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (nodeMatch && request.method === "PUT") {
    const body = await readJson(request);
    const nodeId = nodeMatch[1];
    const { state, result: node, deployment } = await mutateAndApply((draft) => {
      const index = draft.nodes.findIndex((item) => item.id === nodeId);
      if (index < 0) fail(404, "受管节点不存在");
      const previous = draft.nodes[index];
      const updated = normalizeNode({ ...previous, ...body, id: nodeId });
      const immutableDeploymentFields = [
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
    return sendJson(response, 200, { node, inventory: state, deployment, events });
  }
  if (nodeMatch && request.method === "DELETE") {
    const nodeId = nodeMatch[1];
    const force = searchParams.get("force") === "true";
    const { state, node, forced } = await decommissionNode(nodeId, force);
    event(forced ? "warning" : "success", forced
      ? `已强制遗忘受管节点 ${node.name}；远端配置和控制器公钥仍需手动清理`
      : `已清理远端配置并删除受管节点 ${node.name}`, nodeId);
    return sendJson(response, 200, {
      inventory: state,
      cleanupRequired: forced,
      deployment: { applied: !forced, nodeIds: [node.id], nodes: [{ id: node.id, name: node.name }], sessions: [] },
      events,
    });
  }

  const peerCollectionMatch = pathname.match(/^\/api\/nodes\/([A-Za-z_][A-Za-z0-9_]*)\/peers$/);
  if (peerCollectionMatch && request.method === "POST") {
    const body = await readJson(request);
    const nodeId = peerCollectionMatch[1];
    const peer = normalizePeer({ ...body, id: makeId("peer"), nodeId });
    const { state } = await withDeploymentLock(() => store.mutate((draft) => {
      findNode(draft, nodeId);
      draft.peers.push(peer);
    }));
    event("success", `已添加外部 Peer ${peer.name}`, nodeId);
    return sendJson(response, 201, { peer, inventory: state, events });
  }

  const peerMatch = pathname.match(/^\/api\/peers\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (peerMatch && request.method === "PUT") {
    const body = await readJson(request);
    const peerId = peerMatch[1];
    let nodeId;
    const { state, result: peer, deployment } = await mutateAndApply((draft) => {
      const index = draft.peers.findIndex((item) => item.id === peerId);
      if (index < 0) fail(404, "远端 Peer 不存在");
      nodeId = draft.peers[index].nodeId;
      const updated = normalizePeer({ ...draft.peers[index], ...body, id: peerId, nodeId });
      draft.peers[index] = updated;
      return updated;
    }, () => [nodeId]);
    event("success", `已更新外部 Peer ${peer.name}`, peer.nodeId);
    return sendJson(response, 200, { peer, inventory: state, deployment, events });
  }
  if (peerMatch && request.method === "DELETE") {
    const peerId = peerMatch[1];
    const { state, result: peer } = await withDeploymentLock(() => store.mutate((draft) => {
      const peer = findPeer(draft, peerId);
      if (draft.sessions.some((item) => item.peerId === peer.id)) fail(409, "请先移除该 Peer 的会话");
      draft.peers = draft.peers.filter((item) => item.id !== peer.id);
      return peer;
    }));
    event("success", `已删除外部 Peer ${peer.name}`, peer.nodeId);
    return sendJson(response, 200, { inventory: state, events });
  }

  const staticMatch = pathname.match(/^\/api\/statics\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (request.method === "POST" && pathname === "/api/statics") {
    const body = await readJson(request);
    const resource = normalizeStaticProtocol({ ...body, id: makeId("static") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      findNode(draft, resource.nodeId);
      draft.staticProtocols.push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightStaticProtocol(candidate, resource.id);
      return resource;
    }, () => [resource.nodeId]);
    event("success", `已添加 Static 资源 ${resource.name}`, resource.nodeId);
    return sendJson(response, 201, {
      resource: state.staticProtocols.find((item) => item.id === resource.id), inventory: state, deployment, events,
    });
  }
  if (staticMatch && request.method === "PUT") {
    const resourceId = staticMatch[1];
    const body = await readJson(request);
    let nodeId;
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft.staticProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Static 资源不存在");
      const previous = draft.staticProtocols[index];
      nodeId = previous.nodeId;
      if (Object.hasOwn(body, "nodeId") && body.nodeId !== previous.nodeId) {
        fail(409, "Static 资源不可直接移动到其他节点；请删除后重新添加");
      }
      const staticInput = { ...previous, ...body, id: resourceId, nodeId };
      if (Object.hasOwn(body, "action") && !Object.hasOwn(body, "routeActions") && body.action !== null && body.action !== "") {
        staticInput.routeActions = Object.fromEntries(
          Object.keys(previous.routeActions ?? {}).map((prefix) => [prefix, body.action]),
        );
      }
      const updated = normalizeStaticProtocol(staticInput);
      draft.staticProtocols[index] = updated;
      const candidate = validateInventory(draft);
      if (!updated.enabled) await preflightStaticProtocol(candidate, resourceId);
      return updated;
    }, () => [nodeId]);
    event("success", `已更新 Static 资源 ${resource.name}`, resource.nodeId);
    return sendJson(response, 200, {
      resource: state.staticProtocols.find((item) => item.id === resource.id), inventory: state, deployment, events,
    });
  }
  if (staticMatch && request.method === "DELETE") {
    const resourceId = staticMatch[1];
    let nodeId;
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.staticProtocols.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "Static 资源不存在");
      const resource = draft.staticProtocols[index];
      nodeId = resource.nodeId;
      draft.staticProtocols.splice(index, 1);
      return resource;
    }, () => [nodeId]);
    event("success", `已删除 Static 资源 ${resource.name}`, resource.nodeId);
    return sendJson(response, 200, { inventory: state, deployment, events });
  }

  const rpkiMatch = pathname.match(/^\/api\/rpki\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (request.method === "POST" && pathname === "/api/rpki") {
    const body = await readJson(request);
    const resource = normalizeRPKI({ ...body, id: makeId("rpki") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      draft.rpki.push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightRPKIResource(candidate, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 RPKI 资源 ${resource.name}`, resource.nodeId);
    return sendJson(response, 201, { resource, inventory: state, deployment, events });
  }
  if (rpkiMatch && request.method === "PUT") {
    const resourceId = rpkiMatch[1];
    const body = await readJson(request);
    let affectedNodeIds = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft.rpki.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      const previous = draft.rpki[index];
      const nodeId = Object.hasOwn(body, "nodeId")
        ? (body.nodeId === null || body.nodeId === "" ? null : body.nodeId)
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
    return sendJson(response, 200, { resource, inventory: state, deployment, events });
  }
  if (rpkiMatch && request.method === "DELETE") {
    const resourceId = rpkiMatch[1];
    let affectedNodeIds = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const index = draft.rpki.findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, "RPKI 资源不存在");
      const resource = draft.rpki[index];
      affectedNodeIds = resourceNodeIds(draft, resource);
      for (const symbol of [resource.name, resource.roa4Table, resource.roa6Table]) {
        if (symbol && resourceReferencesSymbol(draft, symbol)) fail(409, `请先更新引用 RPKI 符号 ${symbol} 的策略`);
      }
      draft.rpki.splice(index, 1);
      return resource;
    }, () => affectedNodeIds);
    event("success", `已删除 RPKI 资源 ${resource.name}`, resource.nodeId);
    return sendJson(response, 200, { inventory: state, deployment, events });
  }

  const policyCollection = pathname === "/api/functions"
    ? { collection: "functions", kind: "Function", normalize: normalizePolicyFunction, idPrefix: "function" }
    : pathname === "/api/filters"
      ? { collection: "filters", kind: "Filter", normalize: normalizePolicyFilter, idPrefix: "filter" }
      : pathname === "/api/defines"
        ? { collection: "defines", kind: "Define", normalize: normalizeDefine, idPrefix: "define" }
        : null;
  if (policyCollection && request.method === "POST") {
    const body = await readJson(request);
    const resource = policyCollection.normalize({ ...body, id: makeId(policyCollection.idPrefix) });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      draft[policyCollection.collection].push(resource);
      const candidate = validateInventory(draft);
      if (!resource.enabled) await preflightPolicyResource(candidate, policyCollection.collection, resource.id);
      return resource;
    }, (_result, inventory) => resourceNodeIds(inventory, resource));
    event("success", `已添加 ${policyCollection.kind} ${resource.name}`, resource.nodeId);
    return sendJson(response, 201, { resource, inventory: state, deployment, events });
  }

  const resourceMoveMatch = pathname.match(/^\/api\/(functions|defines)\/([A-Za-z_][A-Za-z0-9_]*)\/move$/);
  if (resourceMoveMatch && request.method === "POST") {
    const body = await readJson(request);
    const direction = String(body.direction ?? "");
    if (direction !== "up" && direction !== "down") fail(400, "资源移动方向不合法");
    const collection = resourceMoveMatch[1];
    const resourceId = resourceMoveMatch[2];
    const kind = collection === "functions" ? "Function" : "Define";
    let affectedNodeIds = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft[collection].findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, `${kind} 不存在`);
      affectedNodeIds = resourceNodeIds(draft, draft[collection][index]);
      const targetIndex = index + (direction === "up" ? -1 : 1);
      if (targetIndex < 0 || targetIndex >= draft[collection].length) return draft[collection][index];
      [draft[collection][index], draft[collection][targetIndex]] = [draft[collection][targetIndex], draft[collection][index]];
      const candidate = validateInventory(draft);
      if (!candidate[collection][targetIndex].enabled) await preflightPolicyResource(candidate, collection, resourceId);
      affectedNodeIds = uniqueNodeIds(affectedNodeIds, resourceNodeIds(draft, draft[collection][targetIndex]));
      return candidate[collection][targetIndex];
    }, () => affectedNodeIds);
    event("success", `已调整 ${kind} ${resource.name} 的声明顺序`, resource.nodeId);
    return sendJson(response, 200, { resource, inventory: state, deployment, events });
  }

  const policyMatch = pathname.match(/^\/api\/(functions|filters|defines)\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (policyMatch && request.method === "PUT") {
    const body = await readJson(request);
    const collection = policyMatch[1];
    const resourceId = policyMatch[2];
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    const normalize = collection === "functions" ? normalizePolicyFunction : collection === "filters" ? normalizePolicyFilter : normalizeDefine;
    let affectedNodeIds = [];
    const { state, result: resource, deployment } = await mutateAndApply(async (draft) => {
      const index = draft[collection].findIndex((item) => item.id === resourceId);
      if (index < 0) fail(404, `${kind} 不存在`);
      const nodeId = Object.hasOwn(body, "nodeId")
        ? (body.nodeId === null || body.nodeId === "" ? null : body.nodeId)
        : draft[collection][index].nodeId;
      if (nodeId !== null) findNode(draft, nodeId);
      const previous = draft[collection][index];
      const updated = normalize({ ...previous, ...body, id: resourceId, nodeId });
      if (collection === "defines" && updated.name !== previous.name && resourceReferencesSymbol(draft, previous.name, resourceId)) {
        fail(409, `请先更新引用 Define ${previous.name} 的资源`);
      }
      draft[collection][index] = updated;
      affectedNodeIds = resourceChangeNodeIds(draft, previous, updated);
      const candidate = validateInventory(draft);
      if (!updated.enabled) await preflightPolicyResource(candidate, collection, resourceId);
      return updated;
    }, () => affectedNodeIds);
    event("success", `已更新 ${kind} ${resource.name}`, resource.nodeId);
    return sendJson(response, 200, { resource, inventory: state, deployment, events });
  }
  if (policyMatch && request.method === "DELETE") {
    const collection = policyMatch[1];
    const resourceId = policyMatch[2];
    const kind = collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
    let affectedNodeIds = [];
    const { state, result: resource, deployment } = await mutateAndApply((draft) => {
      const resource = findPolicyResource(draft, collection, resourceId);
      affectedNodeIds = resourceNodeIds(draft, resource);
      const referencedBySession = draft.sessions.some((session) => {
        const channels = Object.values(session.channels);
        const policies = channels.flatMap((channel) => [channel.importPolicy, channel.exportPolicy]);
        return collection === "functions"
          ? policies.some((policy) => policy.steps.some((step) => step.type === "function" && step.functionId === resource.id))
          : collection === "filters"
            ? policies.some((policy) => policy.filterId === resource.id)
            : channels.some((channel) => channel.exportDefineId === resource.id);
      });
      if (referencedBySession) fail(409, `请先从会话中移除该 ${kind}`);
      if (collection === "defines" && draft.staticProtocols.some((item) => item.defineId === resource.id)) {
        fail(409, "请先从 Static 资源中移除该 Define");
      }
      if (collection === "defines" && resourceReferencesSymbol(draft, resource.name, resource.id)) {
        fail(409, `请先更新引用 Define ${resource.name} 的资源`);
      }
      draft[collection] = draft[collection].filter((item) => item.id !== resource.id);
      return resource;
    }, () => affectedNodeIds);
    event("success", `已删除 ${kind} ${resource.name}`, resource.nodeId);
    return sendJson(response, 200, { inventory: state, deployment, events });
  }

  if (request.method === "POST" && pathname === "/api/sessions/preview") {
    const body = await readJson(request);
    const staged = await withDeploymentLock(async () => {
      const state = await store.read();
      return stageSession(state, body);
    });
    return sendJson(response, staged.valid ? 200 : 422, {
      valid: staged.valid,
      session: staged.session,
      config: staged.config,
      validation: staged.validation,
      events,
    });
  }

  const sessionRoutesMatch = pathname.match(/^\/api\/sessions\/([A-Za-z_][A-Za-z0-9_]*)\/routes$/);
  if (sessionRoutesMatch && request.method === "GET") {
    const family = String(searchParams.get("family") ?? "").toLowerCase();
    const direction = String(searchParams.get("direction") ?? "").toLowerCase();
    if (family !== "ipv4" && family !== "ipv6") fail(400, "路由地址族必须是 ipv4 或 ipv6");
    if (direction !== "import" && direction !== "export") fail(400, "路由方向必须是 import 或 export");
    const state = await store.read();
    const session = state.sessions.find((item) => item.id === sessionRoutesMatch[1]);
    if (!session) fail(404, "会话不存在");
    if (!session.enabled) fail(409, "会话配置已停用，无法读取路由明细");
    const channel = session.channels[family];
    if (!channel?.enabled) fail(409, `会话未启用 ${family === "ipv4" ? "IPv4" : "IPv6"} Channel`);
    const node = findNode(state, session.nodeId);
    const result = await inspectProtocolRoutes(node, session.protocolName, family, direction, { table: channel.table });
    if (!result.ok) fail(502, result.error || "无法读取 BIRD 路由明细");
    return sendJson(response, 200, {
      session: { id: session.id, protocolName: session.protocolName },
      family,
      direction,
      table: result.table ?? channel.table ?? (family === "ipv4" ? "master4" : "master6"),
      routes: result.routes,
      truncated: result.truncated,
      limit: result.limit,
    });
  }

  const sessionControlMatch = pathname.match(/^\/api\/sessions\/([A-Za-z_][A-Za-z0-9_]*)\/control$/);
  if (sessionControlMatch && request.method === "POST") {
    const body = await readJson(request);
    const action = String(body.action ?? "").trim().toLowerCase();
    if (action !== "enable" && action !== "disable") fail(400, "BGP 协议动作只能是 enable 或 disable");
    const control = await withDeploymentLock(async () => {
      const state = await store.read();
      const session = state.sessions.find((item) => item.id === sessionControlMatch[1]);
      if (!session) fail(404, "会话不存在");
      if (!session.enabled) fail(409, "会话配置已停用，请先应用启用会话");
      const node = findNode(state, session.nodeId);
      const result = await setProtocolState(node, session.protocolName, action === "enable");
      if (!result.ok) fail(502, result.stderr || result.stdout || `无法${action === "enable" ? "启动" : "停止"} BGP 协议`);
      event("success", `${node.name} 的 BGP 协议 ${session.protocolName} 已${action === "enable" ? "启动" : "停止"}`, node.id);
      return {
        sessionId: session.id,
        nodeId: node.id,
        protocolName: session.protocolName,
        action,
        enabled: action === "enable",
        result,
        events,
      };
    });
    return sendJson(response, 200, control);
  }

  if (request.method === "POST" && pathname === "/api/sessions/apply") {
    const body = await readJson(request);
    let staged;
    let applied = false;
    let committed = false;
    let journal = null;
    return withDeploymentLock(async () => {
      try {
        const currentInventory = await store.read();
        staged = await stageSession(currentInventory, body);
        if (!staged.valid) return sendJson(response, 422, { error: "候选配置检查失败", ...staged, events });
        journal = await beginDeploymentJournal(currentInventory, staged.inventory, [staged.node.id], [staged.node]);
        applied = true;
        const result = await applyStagedConfig(staged.node);
        if (!result.ok) fail(500, result.stderr || result.stdout || "BIRD 配置应用失败");
        await store.replace(currentInventory, staged.inventory);
        committed = true;
        await clearDeploymentJournal(journal);
        journal = null;
        if (!staged.session.enabled) {
          event("success", `会话 ${staged.session.protocolName} 已停用`, staged.node.id);
          return sendJson(response, 200, {
            applied: true,
            enabled: false,
            established: false,
            session: staged.session,
            config: staged.config,
            status: null,
            events,
          });
        }
        const status = await waitForProtocol(staged.node, staged.session.protocolName);
        event(
          status.protocol.established ? "success" : "warning",
          status.protocol.established ? `与 ${staged.peer.name} 的 BGP 会话已 Established` : `配置已应用，正在等待 ${staged.peer.name}`,
          staged.node.id,
        );
        return sendJson(response, status.protocol.established ? 200 : 202, {
          applied: true,
          enabled: true,
          established: status.protocol.established,
          session: staged.session,
          config: staged.config,
          status,
          events,
        });
      } catch (error) {
        event("error", safeErrorMessage(error), staged?.node?.id ?? null);
        if (applied && !committed && staged?.node) {
          let journalMarkedForRollback = false;
          if (journal) {
            try {
              await setDeploymentJournalDirection(journal, "rollback");
              journalMarkedForRollback = true;
            } catch (journalError) {
              console.error(journalError);
            }
          }
          const rollback = await rollbackNode(staged.node);
          event(
            rollback.ok ? "warning" : "error",
            rollback.ok ? "已回滚受管节点" : `受管节点回滚失败：${rollback.stderr || rollback.stdout}`,
            staged.node.id,
          );
          if (rollback.ok && journal && journalMarkedForRollback) {
            try {
              await clearDeploymentJournal(journal);
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

  const sessionMatch = pathname.match(/^\/api\/sessions\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (sessionMatch && request.method === "DELETE") {
    let applied = false;
    let committed = false;
    let node;
    let journal = null;
    return withDeploymentLock(async () => {
      try {
        const state = await store.read();
        const session = state.sessions.find((item) => item.id === sessionMatch[1]);
        if (!session) fail(404, "会话不存在");
        node = findNode(state, session.nodeId);
        const candidate = validateInventory({ ...state, sessions: state.sessions.filter((item) => item.id !== session.id) });
        const config = configForNode(candidate, node);
        const validation = await stageAndValidate(node, config);
        if (!validation.ok) fail(422, validation.stderr || "候选配置检查失败");
        journal = await beginDeploymentJournal(state, candidate, [node.id], [node]);
        applied = true;
        const result = await applyStagedConfig(node);
        if (!result.ok) fail(500, result.stderr || result.stdout || "BIRD 配置应用失败");
        await store.replace(state, candidate);
        committed = true;
        await clearDeploymentJournal(journal);
        journal = null;
        event("success", `已移除会话 ${session.protocolName}`, node.id);
        return sendJson(response, 200, { inventory: candidate, events });
      } catch (error) {
        if (applied && !committed && node) {
          let journalMarkedForRollback = false;
          if (journal) {
            try {
              await setDeploymentJournalDirection(journal, "rollback");
              journalMarkedForRollback = true;
            } catch (journalError) {
              console.error(journalError);
            }
          }
          const rollback = await rollbackNode(node);
          if (!rollback.ok) event("error", `${node.name} 回滚失败：${rollback.stderr || rollback.stdout}`, node.id);
          else if (journal && journalMarkedForRollback) {
            try {
              await clearDeploymentJournal(journal);
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

  fail(404, "接口不存在");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = path.normalize(requested);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const content = await fs.readFile(path.join(publicDir, normalized));
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(normalized)] ?? "application/octet-stream",
      "content-length": content.length,
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
  }
}

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  let url;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      assertSameOrigin(request);
      if (await handleAuthApi(request, response, url)) return;
      if (url.pathname !== "/api/health" && !await authStore.isAuthenticated(requestSessionToken(request))) {
        return sendJson(response, 401, { error: "请先登录", code: "AUTH_REQUIRED" }, {
          "set-cookie": sessionCookie(request, "", 0),
        });
      }
      await handleApi(request, response, url);
    } else {
      await serveStatic(response, url.pathname);
    }
  } catch (error) {
    const pathname = url?.pathname ?? "";
    const authPath = pathname.startsWith("/api/auth/");
    const healthPath = pathname === "/api/health";
    const unexpected = !isPublicError(error);
    if (!authPath && !healthPath) event("error", safeErrorMessage(error));
    if (healthPath) {
      if (!response.headersSent) sendJson(response, 503, { status: "error" });
      return;
    }
    if (unexpected) console.error(error);
    const payload = { error: unexpected ? "服务器内部错误" : error.message };
    if (!unexpected && error.code) payload.code = error.code;
    if (!authPath && error.code !== "AUTH_REQUIRED") payload.events = events;
    if (!response.headersSent) sendJson(response, error.status ?? 500, payload);
    else response.destroy();
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;

await database.initialize();
await authStore.initialize();
await store.initialize();
await database.createState(DEPLOYMENT_JOURNAL_KEY, EMPTY_DEPLOYMENT_JOURNAL);
const pendingDeployment = (await readDeploymentJournal()).active;
const recoveryNodes = pendingDeployment
  ? [...pendingDeployment.forwardTargets, ...pendingDeployment.rollbackTargets].map((target) => target.node)
  : [];
await ensureControllerSshIdentity(recoveryNodes);
await recoverDeploymentJournal();

server.listen(port, host, () => {
  console.log(`Birdbox Demo listening on http://${host}:${port}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  const forcedExit = setTimeout(() => process.exit(1), shutdownTimeoutMs);
  forcedExit.unref();
  const serverClosed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
  try {
    const deployment = activeDeployment;
    if (deployment) await deployment.catch(() => undefined);
    server.closeIdleConnections?.();
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
