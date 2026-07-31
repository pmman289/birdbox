import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  applyStagedConfig,
  birdSourceReferencesSymbol,
  checkIncludeNodeAccess,
  configureManagedSsh,
  inspectNode,
  normalizeDefine,
  normalizeNode,
  normalizePeer,
  normalizePolicyFilter,
  normalizePolicyFunction,
  normalizeRPKI,
  normalizeSession,
  renderBirdConfig,
  rollbackNode,
  stageAndValidate,
  setProtocolState,
  validateInventory,
} from "./bird.js";
import { resourceChangeNodeIds, resourceNodeIds, uniqueNodeIds } from "./resource-impact.js";
import { InventoryStore } from "./store.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataDir = process.env.BIRDBOX_DATA_DIR ?? path.join(rootDir, "data");
const nodesPath = process.env.BIRDBOX_NODES_FILE ?? path.join(rootDir, "config", "nodes.json");
const host = process.env.BIRDBOX_HOST ?? "0.0.0.0";
const port = Number(process.env.BIRDBOX_PORT ?? 3000);
const execFileAsync = promisify(execFile);
const controllerSshDir = path.join(dataDir, "ssh");
const controllerSshKeyPath = process.env.BIRDBOX_SSH_KEY_PATH ?? path.join(controllerSshDir, "id_ed25519");
const controllerKnownHostsPath = process.env.BIRDBOX_KNOWN_HOSTS_PATH ?? path.join(controllerSshDir, "known_hosts");
const store = new InventoryStore({
  dataDir,
  nodesPath,
  legacySessionPath: path.join(dataDir, "session.json"),
});

let deploymentLocked = false;
let events = [];
const protocolOverrides = new Map();
let controllerPublicKey = "";

async function ensureControllerSshIdentity() {
  await fs.mkdir(path.dirname(controllerSshKeyPath), { recursive: true, mode: 0o700 });
  try {
    await fs.access(controllerSshKeyPath);
  } catch {
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "birdbox-controller", "-f", controllerSshKeyPath]);
  }
  await fs.chmod(controllerSshKeyPath, 0o600);
  await fs.chmod(`${controllerSshKeyPath}.pub`, 0o644);
  await fs.appendFile(controllerKnownHostsPath, "", { mode: 0o600 });
  await fs.chmod(controllerKnownHostsPath, 0o600);
  controllerPublicKey = (await fs.readFile(`${controllerSshKeyPath}.pub`, "utf8")).trim();
  configureManagedSsh({ identityFile: controllerSshKeyPath, knownHostsFile: controllerKnownHostsPath });
}

function event(level, message, nodeId = null) {
  const entry = { timestamp: new Date().toISOString(), level, message, nodeId };
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

function ownedNodePolicyResources(state, nodeId) {
  return [...state.defines, ...state.functions, ...state.filters, ...(state.rpki ?? [])].filter((item) => item.nodeId === nodeId);
}

function resourceReferencesSymbol(state, symbol, excludedId = null) {
  return [...state.defines, ...state.functions, ...state.filters].some((resource) =>
    resource.id !== excludedId && birdSourceReferencesSymbol(resource.value ?? resource.source ?? "", symbol),
  ) || state.sessions.some((session) => Object.values(session.channels).some((channel) =>
    birdSourceReferencesSymbol(channel.static?.raw ?? "", symbol),
  ));
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
  );
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
  if (deploymentLocked) fail(409, "另一个部署正在进行");
  deploymentLocked = true;
  const attemptedNodes = [];
  let deployment;
  try {
    const result = await store.mutate(async (draft) => {
      const mutation = await mutator(draft);
      const inventory = validateInventory(draft);
      const nodeIds = uniqueNodeIds(typeof nodeIdsForDraft === "function" ? nodeIdsForDraft(mutation, inventory) : nodeIdsForDraft);
      const nodes = nodeIds.map((nodeId) => findNode(inventory, nodeId));

      for (const node of nodes) {
        const validation = await stageAndValidate(node, configForNode(inventory, node));
        if (!validation.ok) fail(422, validation.stderr || `${node.name} 的 BIRD 语法检查失败`);
      }
      for (const node of nodes) {
        attemptedNodes.push(node);
        const applied = await applyStagedConfig(node);
        if (!applied.ok) fail(500, applied.stderr || applied.stdout || `${node.name} 的 BIRD 配置应用失败`);
      }
      deployment = deploymentReport(inventory, nodeIds);
      return mutation;
    });
    return { ...result, deployment };
  } catch (error) {
    for (const node of attemptedNodes.reverse()) {
      const rollback = await rollbackNode(node);
      if (!rollback.ok) event("error", `${node.name} 回滚失败：${rollback.stderr || rollback.stdout}`, node.id);
    }
    throw error;
  } finally {
    deploymentLocked = false;
  }
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

function protocolFor(runtime, protocolName) {
  return runtime.protocols.find((item) => item.name === protocolName) ?? {
    name: protocolName,
    configured: false,
    state: null,
    established: false,
    neighbor: null,
    neighborAs: null,
    imported: null,
    exported: null,
  };
}

function protocolOverrideKey(nodeId, protocolName) {
  return `${nodeId}:${protocolName}`;
}

function protocolWithOverride(runtime, nodeId, protocolName) {
  const protocol = protocolFor(runtime, protocolName);
  const overrideKey = protocolOverrideKey(nodeId, protocolName);
  return protocolOverrides.has(overrideKey)
    ? { ...protocol, disabled: protocolOverrides.get(overrideKey) }
    : protocol;
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
      const protocol = protocolWithOverride(runtime ?? { protocols: [] }, node.id, session.protocolName);
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
  return node;
}

function nodeSetupScript(node) {
  const directory = path.posix.dirname(node.generatedConfigPath);
  const includeLine = `include "${node.generatedConfigPath}";`;
  return {
    includeLine,
    script: `#!/bin/sh
set -eu

BIRDBOX_USER='${node.sshUser}'
BIRD_GROUP='bird'
MAIN_CONFIG='${node.mainConfigPath}'
GENERATED_CONFIG='${node.generatedConfigPath}'
CONFIG_DIR='${directory}'
SOCKET_PATH='${node.socketPath}'
CONTROLLER_KEY='${controllerPublicKey}'
KEY_LINE="restrict $CONTROLLER_KEY"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo sh 执行此脚本" >&2
  exit 1
fi
if ! id "$BIRDBOX_USER" >/dev/null 2>&1; then
  echo "用户 $BIRDBOX_USER 不存在，请先创建非特权用户" >&2
  exit 1
fi
if ! getent group "$BIRD_GROUP" >/dev/null 2>&1; then
  echo "BIRD 用户组 $BIRD_GROUP 不存在" >&2
  exit 1
fi
if command -v usermod >/dev/null 2>&1; then
  usermod -a -G "$BIRD_GROUP" "$BIRDBOX_USER"
elif command -v addgroup >/dev/null 2>&1; then
  addgroup "$BIRDBOX_USER" "$BIRD_GROUP"
else
  echo "无法添加附加用户组：缺少 usermod/addgroup" >&2
  exit 1
fi

install -d -o "$BIRDBOX_USER" -g "$BIRD_GROUP" -m 0750 "$CONFIG_DIR" "$CONFIG_DIR/versions"
if [ -e "$GENERATED_CONFIG" ] && [ ! -L "$GENERATED_CONFIG" ]; then
  echo "$GENERATED_CONFIG 已存在且不是符号链接，拒绝覆盖" >&2
  exit 1
fi
if [ ! -L "$GENERATED_CONFIG" ]; then
  printf '%s\n' '# Birdbox initial empty include' > "$CONFIG_DIR/versions/initial.conf"
  chown "$BIRDBOX_USER:$BIRD_GROUP" "$CONFIG_DIR/versions/initial.conf"
  chmod 0640 "$CONFIG_DIR/versions/initial.conf"
  ln -s 'versions/initial.conf' "$GENERATED_CONFIG"
  chown -h "$BIRDBOX_USER:$BIRD_GROUP" "$GENERATED_CONFIG" 2>/dev/null || true
fi

HOME_DIR=$(getent passwd "$BIRDBOX_USER" | cut -d: -f6)
PRIMARY_GROUP=$(id -gn "$BIRDBOX_USER")
install -d -o "$BIRDBOX_USER" -g "$PRIMARY_GROUP" -m 0700 "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
chown "$BIRDBOX_USER:$PRIMARY_GROUP" "$HOME_DIR/.ssh/authorized_keys"
chmod 0600 "$HOME_DIR/.ssh/authorized_keys"
if ! grep -F "$CONTROLLER_KEY" "$HOME_DIR/.ssh/authorized_keys" >/dev/null 2>&1; then
  printf '%s\n' "$KEY_LINE" >> "$HOME_DIR/.ssh/authorized_keys"
fi

test -S "$SOCKET_PATH" || { echo "BIRD Socket 不存在：$SOCKET_PATH" >&2; exit 1; }
SOCKET_GROUP=$(stat -c '%G' "$SOCKET_PATH")
[ "$SOCKET_GROUP" = "$BIRD_GROUP" ] || { echo "Socket 用户组是 $SOCKET_GROUP，不是 $BIRD_GROUP" >&2; exit 1; }
test -f "$MAIN_CONFIG" || { echo "主配置不存在：$MAIN_CONFIG" >&2; exit 1; }

echo "节点权限准备完成。请在 $MAIN_CONFIG 中添加："
echo '${includeLine}'
echo "添加后执行：birdc -s $SOCKET_PATH configure check && birdc -s $SOCKET_PATH configure"
`,
  };
}

async function verifyOnboardingNode(node) {
  const access = await checkIncludeNodeAccess(node);
  if (!access.ok) fail(422, access.stderr || access.stdout || "节点接入条件检查失败");
  const runtime = await inspectNode(node);
  if (!runtime.reachable || !runtime.bird2) fail(422, runtime.error || "目标节点未运行受支持的 BIRD 2");
  const validation = await stageAndValidate(node, renderBirdConfig(node, [], [], [], [], [], []));
  if (!validation.ok) fail(422, validation.stderr || validation.stdout || "系统主配置预检失败");
  return { runtime, validation: { ok: true } };
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
      routeAction: payload.routeAction,
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
  event("info", `正在检查 ${prepared.node.name} 的候选配置`, prepared.node.id);
  const validation = await stageAndValidate(prepared.node, prepared.config);
  event(
    validation.ok ? "success" : "error",
    validation.ok ? "候选配置检查通过" : (validation.stderr || "候选配置检查失败"),
    prepared.node.id,
  );
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
  const peers = nodePeers(state, node.id);
  const peer = peers.find((item) => item.id === requestedPeerId) ?? peers[0] ?? null;
  return { node, peer, peers };
}

async function dashboard(state, requestedNodeId, requestedPeerId) {
  const selection = chooseSelection(state, requestedNodeId, requestedPeerId);
  const runtimes = await Promise.all(state.nodes.map((node) => inspectNode(node)));
  const runtime = runtimes.find((item) => item.nodeId === selection.node.id) ?? {
    nodeId: selection.node.id, reachable: false, bird2: false, version: null, protocols: [], error: "节点状态不可用",
  };
  const peers = selection.peers.map((peer) => {
    const session = state.sessions.find((item) => item.nodeId === selection.node.id && item.peerId === peer.id) ?? null;
    const protocolName = session?.protocolName;
    const protocol = session
      ? protocolWithOverride(runtime, selection.node.id, protocolName)
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
    selectedPeer: selected,
    runtime,
    health: summarizeInventoryHealth(state, runtimes),
    established: selected?.protocol?.established ?? false,
    config: configForNode(state, selection.node),
    events,
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    fail(400, "JSON 请求体不合法");
  }
}

async function applyInventoryConfig(node, inventory) {
  const config = configForNode(inventory, node);
  const validation = await stageAndValidate(node, config);
  if (!validation.ok) fail(422, validation.stderr || "候选配置检查失败");
  const result = await applyStagedConfig(node);
  if (!result.ok) fail(500, result.stderr || result.stdout || "BIRD 配置应用失败");
  return config;
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  if (request.method === "GET" && pathname === "/api/health") {
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
    const verification = await verifyOnboardingNode(node);
    return sendJson(response, 200, {
      ok: true,
      node: { name: node.name, sshHost: node.sshHost, sshPort: node.sshPort, sshUser: node.sshUser },
      runtime: { version: verification.runtime.version, bird2: verification.runtime.bird2 },
    });
  }

  if (request.method === "POST" && pathname === "/api/nodes") {
    const body = await readJson(request);
    const node = normalizeOnboardingNode(body, makeId("node"));
    await verifyOnboardingNode(node);
    const { state } = await store.mutate((draft) => { draft.nodes.push(node); });
    event("success", `已添加受管节点 ${node.name}`, node.id);
    return sendJson(response, 201, { node, inventory: state, events });
  }

  const nodeMatch = pathname.match(/^\/api\/nodes\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (nodeMatch && request.method === "PUT") {
    const body = await readJson(request);
    const nodeId = nodeMatch[1];
    const { state, result: node, deployment } = await mutateAndApply((draft) => {
      const index = draft.nodes.findIndex((item) => item.id === nodeId);
      if (index < 0) fail(404, "受管节点不存在");
      const previous = draft.nodes[index];
      if (draft.sessions.some((session) => session.nodeId === nodeId) && (
        (body.transport ?? previous.transport) !== previous.transport ||
        (body.sshHost ?? previous.sshHost) !== previous.sshHost
      )) {
        fail(409, "节点存在现有会话时不能修改管理连接方式或 SSH 目标");
      }
      const updated = normalizeSshNode({ ...previous, ...body, id: nodeId });
      draft.nodes[index] = updated;
      return updated;
    }, () => [nodeId]);
    event("success", `已更新受管节点 ${node.name}`, node.id);
    return sendJson(response, 200, { node, inventory: state, deployment, events });
  }
  if (nodeMatch && request.method === "DELETE") {
    const nodeId = nodeMatch[1];
    const { state } = await store.mutate((draft) => {
      const node = findNode(draft, nodeId);
      if (nodePeers(draft, node.id).length || ownedNodePolicyResources(draft, node.id).length || nodeSessions(draft, node.id).length) {
        fail(409, "请先删除该节点的会话、Peer 和节点级资源");
      }
      draft.nodes = draft.nodes.filter((item) => item.id !== node.id);
    });
    event("success", "已删除受管节点", nodeId);
    return sendJson(response, 200, { inventory: state, events });
  }

  const peerCollectionMatch = pathname.match(/^\/api\/nodes\/([A-Za-z_][A-Za-z0-9_]*)\/peers$/);
  if (peerCollectionMatch && request.method === "POST") {
    const body = await readJson(request);
    const nodeId = peerCollectionMatch[1];
    const current = await store.read();
    findNode(current, nodeId);
    const peer = normalizePeer({ ...body, id: makeId("peer"), nodeId });
    const { state } = await store.mutate((draft) => { draft.peers.push(peer); });
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
    const { state, result: peer } = await store.mutate((draft) => {
      const peer = findPeer(draft, peerId);
      if (draft.sessions.some((item) => item.peerId === peer.id)) fail(409, "请先移除该 Peer 的会话");
      draft.peers = draft.peers.filter((item) => item.id !== peer.id);
      return peer;
    });
    event("success", `已删除外部 Peer ${peer.name}`, peer.nodeId);
    return sendJson(response, 200, { inventory: state, events });
  }

  const rpkiMatch = pathname.match(/^\/api\/rpki\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (request.method === "POST" && pathname === "/api/rpki") {
    const body = await readJson(request);
    const resource = normalizeRPKI({ ...body, id: makeId("rpki") });
    const { state, deployment } = await mutateAndApply(async (draft) => {
      draft.rpki.push(resource);
      const candidate = validateInventory(draft);
      await preflightRPKIResource(candidate, resource.id);
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
      await preflightRPKIResource(candidate, resourceId);
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
      await preflightPolicyResource(candidate, policyCollection.collection, resource.id);
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
      await preflightPolicyResource(candidate, collection, resourceId);
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
      await preflightPolicyResource(candidate, collection, resourceId);
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
            : channels.some((channel) => channel.exportDefineId === resource.id || channel.static?.defineId === resource.id);
      });
      if (referencedBySession) fail(409, `请先从会话中移除该 ${kind}`);
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
    const state = await store.read();
    const staged = await stageSession(state, await readJson(request));
    return sendJson(response, staged.valid ? 200 : 422, {
      valid: staged.valid,
      session: staged.session,
      config: staged.config,
      validation: staged.validation,
      events,
    });
  }

  const sessionControlMatch = pathname.match(/^\/api\/sessions\/([A-Za-z_][A-Za-z0-9_]*)\/control$/);
  if (sessionControlMatch && request.method === "POST") {
    const body = await readJson(request);
    const action = String(body.action ?? "").trim().toLowerCase();
    if (action !== "enable" && action !== "disable") fail(400, "BGP 协议动作只能是 enable 或 disable");
    const state = await store.read();
    const session = state.sessions.find((item) => item.id === sessionControlMatch[1]);
    if (!session) fail(404, "会话不存在");
    if (!session.enabled) fail(409, "会话配置已停用，请先应用启用会话");
    const node = findNode(state, session.nodeId);
    const result = await setProtocolState(node, session.protocolName, action === "enable");
    if (!result.ok) fail(502, result.stderr || result.stdout || `无法${action === "enable" ? "启动" : "停止"} BGP 协议`);
    protocolOverrides.set(protocolOverrideKey(node.id, session.protocolName), action === "disable");
    event("success", `${node.name} 的 BGP 协议 ${session.protocolName} 已${action === "enable" ? "启动" : "停止"}`, node.id);
    return sendJson(response, 200, {
      sessionId: session.id,
      nodeId: node.id,
      protocolName: session.protocolName,
      action,
      enabled: action === "enable",
      result,
      events,
    });
  }

  if (request.method === "POST" && pathname === "/api/sessions/apply") {
    if (deploymentLocked) fail(409, "另一个部署正在进行");
    deploymentLocked = true;
    let staged;
    let applied = false;
    try {
      staged = await stageSession(await store.read(), await readJson(request));
      if (!staged.valid) return sendJson(response, 422, { error: "候选配置检查失败", ...staged, events });
      event("info", `正在向 ${staged.node.name} 应用配置`, staged.node.id);
      applied = true;
      const result = await applyStagedConfig(staged.node);
      if (!result.ok) fail(500, result.stderr || result.stdout || "BIRD 配置应用失败");
      await store.write(staged.inventory);
      event("success", `${staged.node.name} 的 BIRD 2 实例已接受配置`, staged.node.id);
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
      event("error", error.message, staged?.node?.id ?? null);
      if (applied && staged?.node) {
        await rollbackNode(staged.node);
        event("warning", "已回滚受管节点", staged.node.id);
      }
      throw error;
    } finally {
      deploymentLocked = false;
    }
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (sessionMatch && request.method === "DELETE") {
    if (deploymentLocked) fail(409, "另一个部署正在进行");
    deploymentLocked = true;
    let applied = false;
    let node;
    try {
      const state = await store.read();
      const session = state.sessions.find((item) => item.id === sessionMatch[1]);
      if (!session) fail(404, "会话不存在");
      node = findNode(state, session.nodeId);
      const candidate = validateInventory({ ...state, sessions: state.sessions.filter((item) => item.id !== session.id) });
      await applyInventoryConfig(node, candidate);
      applied = true;
      await store.write(candidate);
      protocolOverrides.delete(protocolOverrideKey(node.id, session.protocolName));
      event("success", `已移除会话 ${session.protocolName}`, node.id);
      return sendJson(response, 200, { inventory: candidate, events });
    } catch (error) {
      if (applied && node) await rollbackNode(node);
      throw error;
    } finally {
      deploymentLocked = false;
    }
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
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    event("error", error.message);
    sendJson(response, error.status ?? 500, { error: error.message, events });
  }
});

await ensureControllerSshIdentity();

server.listen(port, host, () => {
  console.log(`Birdbox Demo listening on http://${host}:${port}`);
});
