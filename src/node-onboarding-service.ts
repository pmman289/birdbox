import { randomBytes } from "node:crypto";
import path from "node:path";

import type { ChangeEvent, NodeOnboardingRpkiRequirement, NodeRuntime } from "../packages/contracts/src/api.js";
import type { Inventory, ManagedNode } from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import {
  ACTIVE_BIRD_INCLUDE_AWK,
  applyStagedConfig,
  checkIncludeNodeAccess,
  inspectNode,
  normalizeNode,
  renderBirdConfig,
  sourcePolicyManagedRules,
  sourcePolicyManagedRulesForNode,
  executeNodeRpc,
  rollbackNode,
  stageAndValidate,
  validateInventory,
} from "./bird.js";
import type { DeploymentService, ActiveDeploymentJournal } from "./deployment-service.js";
import { fail, record } from "./errors.js";
import {
  configForNode,
  findNode,
  nodePeers,
  nodeSessions,
  ownedNodePolicyResources,
} from "./inventory-domain.js";
import type { InventoryStore } from "./store.js";
import type { AgentBroker } from "./agent-broker.js";
import { errorContext, logger } from "./logger.js";

type ManagedSshNode = ManagedNode & {
  transport: "ssh";
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshIdentity: "managed";
  deploymentMode: "include";
};
type ManagedAgentNode = ManagedNode & { transport: "agent" };

function removeNodeFromMultiScope<Resource extends { nodeIds: string[] | null }>(
  resources: readonly Resource[],
  nodeId: string,
): Resource[] {
  return resources.flatMap((resource) => {
    if (resource.nodeIds === null || !resource.nodeIds.includes(nodeId)) return [resource];
    const nodeIds = resource.nodeIds.filter((item) => item !== nodeId);
    return nodeIds.length ? [{ ...resource, nodeIds }] : [];
  });
}

interface NodeOnboardingServiceOptions {
  store: InventoryStore;
  deploymentService: DeploymentService;
  withDeploymentLock<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  controllerPublicKey(): string;
  makeId(prefix: string): string;
  addEvent(level: string, message: unknown, nodeId?: string | null): ChangeEvent;
  getEvents(): ChangeEvent[];
  agentBroker?: AgentBroker;
  agentControllerUrl?: string;
}

interface ScriptDelivery {
  script: string;
  expiresAt: number;
  downloads: number;
}

const SCRIPT_DELIVERY_TTL_MS = 15 * 60 * 1000;
const SCRIPT_DELIVERY_MAX_DOWNLOADS = 3;

function normalizeSshNode(inputValue: unknown): ManagedNode {
  const input = record(inputValue, "节点参数不能为空");
  if (input.transport !== "ssh") fail(400, "Birdbox 仅支持 SSH 管理节点");
  return normalizeNode(input);
}

function normalizeAgentNode(inputValue: unknown, id = "node_onboarding"): ManagedAgentNode {
  const input = record(inputValue, "节点参数不能为空");
  if (input.transport !== undefined && input.transport !== "agent") fail(400, "节点不是 Agent 管理方式");
  const node = normalizeNode({
    ...input,
    id,
    transport: "agent",
    deploymentMode: input.deploymentMode ?? "include",
    sshHost: null,
    sshPort: null,
    sshUser: null,
    sshIdentity: "default",
  });
  return node as ManagedAgentNode;
}

function normalizeOnboardingNode(inputValue: unknown, id = "node_onboarding"): ManagedSshNode | ManagedAgentNode {
  const input = record(inputValue, "节点参数不能为空");
  if (input.transport === "agent" || input.transport === undefined) return normalizeAgentNode(input, id);
  const node = normalizeSshNode({
    ...input,
    id,
    // New onboarding defaults to Agent. Explicit SSH remains accepted only so
    // existing automation can finish migrating legacy nodes.
    transport: input.transport ?? "agent",
    deploymentMode: input.deploymentMode ?? "include",
    sshIdentity: input.sshIdentity ?? "managed",
  });
  if (node.deploymentMode !== "include" || node.sshIdentity !== "managed") {
    fail(400, "新节点必须使用 Include 模式和 Birdbox 托管 SSH 密钥");
  }
  if (node.sshUser === "root") fail(400, "新节点必须使用专用的非 root SSH 用户");
  if (!node.sshUser || !node.sshHost || node.sshPort === null || !/^[a-z_][a-z0-9_-]{0,31}$/.test(node.sshUser)) {
    fail(400, "新节点的 SSH 用户名必须使用可移植的小写 Linux 用户名");
  }
  return node as ManagedSshNode;
}

export function globalRpkiFileRequirements(inventory: Inventory): NodeOnboardingRpkiRequirement[] {
  return inventory.rpki.flatMap((resource) => {
    if (!resource.enabled || resource.nodeIds !== null || resource.sourceType !== "file") return [];
    return [
      ...(resource.file4 === null ? [] : [{
        resourceId: resource.id,
        resourceLabel: resource.label,
        family: "ipv4" as const,
        path: resource.file4,
      }]),
      ...(resource.file6 === null ? [] : [{
        resourceId: resource.id,
        resourceLabel: resource.label,
        family: "ipv6" as const,
        path: resource.file6,
      }]),
    ];
  });
}

export function onboardingValidationError(
  requirements: readonly NodeOnboardingRpkiRequirement[],
  detail: string,
): string {
  const requirement = requirements.find((item) => detail.includes(item.path));
  if (!requirement) return detail;
  return `全节点 RPKI 资源“${requirement.resourceLabel}”要求新节点提供 ${requirement.family.toUpperCase()} ROA 文件：${requirement.path}。请先在目标节点部署并持续更新该文件；若此资源不适用于新节点，请将其作用域改为指定节点。BIRD 原始错误：${detail}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ensureAgentControllerUrl(value: string): void {
  try {
    const url = new URL(value);
    if (process.env.NODE_ENV === "production" && /^(127\.|localhost$|\[::1\]$)/.test(url.hostname) && process.env.BIRDBOX_ALLOW_LOOPBACK_PUBLIC_URL !== "true") {
      fail(409, "BIRDBOX_PUBLIC_URL 仍是回环地址，远端 Agent 无法回连；请设置节点可达的地址后重建容器", "PUBLIC_URL_LOOPBACK");
    }
  } catch { fail(500, "Agent 控制器地址配置无效", "PUBLIC_URL_INVALID"); }
}

function nodeSetupScript(
  node: ManagedSshNode,
  controllerPublicKey: string,
  rpkiRequirements: readonly NodeOnboardingRpkiRequirement[],
): { includeLine: string; script: string } {
  const directory = path.posix.dirname(node.generatedConfigPath);
  const includeLine = `include "${node.generatedConfigPath}";`;
  const rpkiPreflight = rpkiRequirements.length === 0 ? "" : `
RPKI_MISSING=0
${rpkiRequirements.map((requirement) => `if [ ! -r ${shellSingleQuote(requirement.path)} ]; then
  printf '%s\\n' ${shellSingleQuote(`全节点 RPKI 资源“${requirement.resourceLabel}”缺少 ${requirement.family.toUpperCase()} ROA 文件：${requirement.path}`)} >&2
  RPKI_MISSING=1
fi`).join("\n")}
if [ "$RPKI_MISSING" -ne 0 ]; then
  echo "请先部署并持续更新上述文件；若资源不适用于此节点，请在 Birdbox 中把 RPKI 作用域改为指定节点" >&2
  exit 1
fi
`;
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
  echo "请使用 root 身份执行此脚本" >&2
  exit 1
fi
IS_OPENWRT=0
MANAGED_SHELL=/bin/sh
if [ -r /etc/openwrt_release ]; then
  IS_OPENWRT=1
  MANAGED_SHELL=/bin/ash
fi
if [ "$IS_OPENWRT" -eq 1 ]; then
  case "$GENERATED_CONFIG" in
    /var/*|/tmp/*)
      echo "OpenWrt 的 /var 和 /tmp 位于内存盘，生成配置必须使用持久路径（建议 /etc/birdbox/generated.conf）" >&2
      exit 1
      ;;
  esac
fi
${rpkiPreflight}
test -f "$MAIN_CONFIG" || { echo "主配置不存在：$MAIN_CONFIG" >&2; exit 1; }
test -S "$SOCKET_PATH" || { echo "BIRD Socket 不存在：$SOCKET_PATH" >&2; exit 1; }
for REQUIRED_COMMAND in birdc mkdir mktemp awk grep chown chgrp chmod cp mv ln readlink id cut tr ls; do
  command -v "$REQUIRED_COMMAND" >/dev/null 2>&1 || { echo "缺少 $REQUIRED_COMMAND 命令" >&2; exit 1; }
done

file_uid() {
  if command -v stat >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    LC_ALL=C ls -ldn "$1" | awk 'NR == 1 { print $3; exit }'
  fi
}

file_gid() {
  if command -v stat >/dev/null 2>&1; then
    stat -c '%g' "$1"
  else
    LC_ALL=C ls -ldn "$1" | awk 'NR == 1 { print $4; exit }'
  fi
}

group_name_for_id() {
  awk -F: -v group_id="$1" '$3 == group_id { print $1; exit }' /etc/group
}

file_group_name() {
  if command -v stat >/dev/null 2>&1; then
    stat -c '%G' "$1"
  else
    group_name_for_id "$(file_gid "$1")"
  fi
}

file_owned_by() {
  [ "$(file_uid "$1")" = "$2" ] && [ "$(file_gid "$1")" = "$3" ]
}

BIRD_SOCKET_GROUP_ID=$(file_gid "$SOCKET_PATH")
BIRD_SOCKET_GROUP=$(file_group_name "$SOCKET_PATH")
case "$BIRD_SOCKET_GROUP" in
  ''|UNKNOWN) echo "无法根据 GID $BIRD_SOCKET_GROUP_ID 识别 BIRD Socket 用户组" >&2; exit 1 ;;
esac
if { [ "$BIRD_SOCKET_GROUP" = root ] || [ "$BIRD_SOCKET_GROUP_ID" = 0 ]; } && [ "$IS_OPENWRT" -ne 1 ]; then
  echo "BIRD Socket 不能使用 root 用户组，请先为 BIRD 配置专用控制组" >&2
  exit 1
fi

if ! id "$BIRDBOX_USER" >/dev/null 2>&1; then
  if [ "$IS_OPENWRT" -eq 1 ]; then
    USER_HOME_ROOT=/etc/birdbox-users
  else
    USER_HOME_ROOT=/var/lib/birdbox-users
  fi
  USER_HOME="$USER_HOME_ROOT/$BIRDBOX_USER"
  test ! -L "$USER_HOME_ROOT" || { echo "$USER_HOME_ROOT 不能是符号链接" >&2; exit 1; }
  mkdir -p "$USER_HOME_ROOT"
  chown root:root "$USER_HOME_ROOT"
  chmod 0755 "$USER_HOME_ROOT"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --create-home --user-group --home-dir "$USER_HOME" --shell "$MANAGED_SHELL" "$BIRDBOX_USER"
  elif command -v adduser >/dev/null 2>&1; then
    if adduser --system --disabled-password --gecos '' --home "$USER_HOME" --shell "$MANAGED_SHELL" --group "$BIRDBOX_USER"; then
      :
    else
      adduser -D -h "$USER_HOME" -s "$MANAGED_SHELL" "$BIRDBOX_USER"
    fi
  else
    echo "无法创建用户：缺少 useradd/adduser" >&2
    exit 1
  fi
fi
id "$BIRDBOX_USER" >/dev/null 2>&1 || { echo "创建用户 $BIRDBOX_USER 失败" >&2; exit 1; }
[ "$(id -u "$BIRDBOX_USER")" -ne 0 ] || { echo "Birdbox SSH 用户不能是 root" >&2; exit 1; }
BIRDBOX_USER_ID=$(id -u "$BIRDBOX_USER")

if command -v getent >/dev/null 2>&1; then
  PASSWD_ENTRY=$(getent passwd "$BIRDBOX_USER")
else
  PASSWD_ENTRY=$(awk -F: -v user="$BIRDBOX_USER" '$1 == user { print; exit }' /etc/passwd)
fi
HOME_DIR=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f6)
USER_SHELL=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f7)
PRIMARY_GROUP=$(id -gn "$BIRDBOX_USER")
PRIMARY_GROUP_ID=$(id -g "$BIRDBOX_USER")
if [ "$IS_OPENWRT" -eq 1 ]; then
  case "$HOME_DIR" in
    /var/*|/tmp/*)
      PERSISTENT_HOME_ROOT=/etc/birdbox-users
      PERSISTENT_HOME="$PERSISTENT_HOME_ROOT/$BIRDBOX_USER"
      test ! -L "$HOME_DIR" || { echo "$BIRDBOX_USER 的 Home 目录不能是符号链接" >&2; exit 1; }
      command -v usermod >/dev/null 2>&1 || { echo "无法把 $BIRDBOX_USER 的 Home 迁移到持久存储：缺少 usermod" >&2; exit 1; }
      mkdir -p "$PERSISTENT_HOME_ROOT"
      chown root:root "$PERSISTENT_HOME_ROOT"
      chmod 0755 "$PERSISTENT_HOME_ROOT"
      usermod -d "$PERSISTENT_HOME" -m "$BIRDBOX_USER"
      HOME_DIR="$PERSISTENT_HOME"
      ;;
  esac
fi
case "$HOME_DIR" in
  /?*) ;;
  *) echo "$BIRDBOX_USER 的 Home 目录不合法" >&2; exit 1 ;;
esac
case "$USER_SHELL" in
  */nologin|*/false)
    if command -v usermod >/dev/null 2>&1; then
      usermod -s "$MANAGED_SHELL" "$BIRDBOX_USER"
    elif command -v chsh >/dev/null 2>&1; then
      chsh -s "$MANAGED_SHELL" "$BIRDBOX_USER"
    else
      echo "无法为 $BIRDBOX_USER 设置可执行 SSH 命令的 Shell" >&2
      exit 1
    fi
    USER_SHELL="$MANAGED_SHELL"
    ;;
esac
if [ "$IS_OPENWRT" -eq 1 ] && { [ ! -r /etc/shells ] || ! grep -Fx -- "$USER_SHELL" /etc/shells >/dev/null 2>&1; }; then
  if command -v usermod >/dev/null 2>&1; then
    usermod -s "$MANAGED_SHELL" "$BIRDBOX_USER"
  elif command -v chsh >/dev/null 2>&1; then
    chsh -s "$MANAGED_SHELL" "$BIRDBOX_USER"
  else
    echo "无法为 Dropbear 设置有效登录 Shell：缺少 usermod/chsh" >&2
    exit 1
  fi
  USER_SHELL="$MANAGED_SHELL"
fi
case "$USER_SHELL" in
  /?*) ;;
  *) echo "$BIRDBOX_USER 的登录 Shell 路径不合法：$USER_SHELL" >&2; exit 1 ;;
esac
test -x "$USER_SHELL" || { echo "$BIRDBOX_USER 的登录 Shell 不可执行：$USER_SHELL" >&2; exit 1; }
if [ "$IS_OPENWRT" -eq 1 ]; then
  test -r /etc/shells && grep -Fx -- "$USER_SHELL" /etc/shells >/dev/null 2>&1 || {
    echo "Dropbear 不接受登录 Shell $USER_SHELL：该路径未登记在 /etc/shells" >&2
    exit 1
  }
fi
if command -v runuser >/dev/null 2>&1; then
  runuser -u "$BIRDBOX_USER" -- "$USER_SHELL" -c ':' >/dev/null 2>&1 || {
    echo "$BIRDBOX_USER 无法执行登录 Shell $USER_SHELL；请检查 Shell 文件及其父目录权限（例如 /usr/bin 通常应为 0755）" >&2
    exit 1
  }
elif command -v su >/dev/null 2>&1; then
  su -s "$USER_SHELL" "$BIRDBOX_USER" -c ':' >/dev/null 2>&1 || {
    echo "$BIRDBOX_USER 无法执行登录 Shell $USER_SHELL；请检查 Shell 文件及其父目录权限（例如 /usr/bin 通常应为 0755）" >&2
    exit 1
  }
elif command -v setpriv >/dev/null 2>&1; then
  setpriv --reuid="$BIRDBOX_USER_ID" --regid="$PRIMARY_GROUP_ID" --init-groups "$USER_SHELL" -c ':' >/dev/null 2>&1 || {
    echo "$BIRDBOX_USER 无法执行登录 Shell $USER_SHELL；请检查 Shell 文件及其父目录权限（例如 /usr/bin 通常应为 0755）" >&2
    exit 1
  }
elif [ "$IS_OPENWRT" -eq 1 ]; then
  # 精简版 OpenWrt 常不包含 su/runuser；Dropbear 会直接按 passwd 中的
  # Shell 启动会话，因此前面的路径、权限和 /etc/shells 校验已足够。
  echo "OpenWrt 未提供 runuser/su，已跳过切换用户 Shell 验证；Dropbear 将使用 $USER_SHELL 启动 $BIRDBOX_USER 会话" >&2
else
  echo "无法验证 $BIRDBOX_USER 的登录 Shell：缺少 runuser/su" >&2
  exit 1
fi

if [ "$BIRD_SOCKET_GROUP_ID" = 0 ]; then
  BIRD_GROUP="$PRIMARY_GROUP"
  BIRD_GROUP_ID="$PRIMARY_GROUP_ID"
  BIRD_INIT=/etc/init.d/bird
  test -f "$BIRD_INIT" || { echo "无法适配 OpenWrt BIRD 控制组：缺少 $BIRD_INIT" >&2; exit 1; }
  if grep -Eq '^[[:space:]]*procd_set_param[[:space:]]+command.*[[:space:]]-g[[:space:]]' "$BIRD_INIT"; then
    echo "$BIRD_INIT 已配置 BIRD 运行组，但当前 Socket 仍属于 root；请先修复现有 procd 配置" >&2
    exit 1
  fi
  INIT_BACKUP=$(mktemp "$BIRD_INIT.birdbox-backup.XXXXXX")
  INIT_PATCH=$(mktemp "$BIRD_INIT.birdbox-patch.XXXXXX")
  cp -p "$BIRD_INIT" "$INIT_BACKUP"
  if ! awk -v group="$BIRD_GROUP" '
    BEGIN { changed = 0 }
    /^[[:space:]]*procd_set_param[[:space:]]+command[[:space:]]/ && index($0, "$BIRD_BIN") {
      print $0 " -g " group
      changed += 1
      next
    }
    { print }
    END { if (changed != 1) exit 42 }
  ' "$BIRD_INIT" > "$INIT_PATCH"; then
    rm -f "$INIT_BACKUP" "$INIT_PATCH"
    echo "无法识别 $BIRD_INIT 的 procd 启动命令，未修改 BIRD 服务" >&2
    exit 1
  fi
  chown root:root "$INIT_PATCH"
  chmod 0755 "$INIT_PATCH"
  mv -f "$INIT_PATCH" "$BIRD_INIT"
  if ! "$BIRD_INIT" restart; then
    cp -p "$INIT_BACKUP" "$BIRD_INIT"
    "$BIRD_INIT" restart >/dev/null 2>&1 || true
    rm -f "$INIT_BACKUP"
    echo "OpenWrt BIRD 服务重启失败，init 脚本已恢复" >&2
    exit 1
  fi
  SOCKET_READY=0
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 10 ]; do
    if [ -S "$SOCKET_PATH" ] \
      && [ "$(file_gid "$SOCKET_PATH")" = "$BIRD_GROUP_ID" ] \
      && birdc -s "$SOCKET_PATH" 'show status' >/dev/null 2>&1; then
      SOCKET_READY=1
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  if [ "$SOCKET_READY" -ne 1 ]; then
    cp -p "$INIT_BACKUP" "$BIRD_INIT"
    "$BIRD_INIT" restart >/dev/null 2>&1 || true
    rm -f "$INIT_BACKUP"
    echo "OpenWrt BIRD 控制 Socket 未切换到 $BIRD_GROUP 用户组，init 脚本已恢复" >&2
    exit 1
  fi
  rm -f "$INIT_BACKUP"
else
  BIRD_GROUP="$BIRD_SOCKET_GROUP"
  BIRD_GROUP_ID="$BIRD_SOCKET_GROUP_ID"
fi

if ! id -G "$BIRDBOX_USER" | tr ' ' '\n' | grep -Fx -- "$BIRD_GROUP_ID" >/dev/null 2>&1; then
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
id -G "$BIRDBOX_USER" | tr ' ' '\n' | grep -Fx -- "$BIRD_GROUP_ID" >/dev/null 2>&1 || {
  echo "$BIRDBOX_USER 未成功加入 $BIRD_GROUP 用户组" >&2
  exit 1
}

if [ -L "$CONFIG_DIR" ]; then
  echo "$CONFIG_DIR 不能是符号链接" >&2
  exit 1
fi
if [ -e "$CONFIG_DIR" ]; then
  test -d "$CONFIG_DIR" || { echo "$CONFIG_DIR 不是目录" >&2; exit 1; }
  file_owned_by "$CONFIG_DIR" "$BIRDBOX_USER_ID" "$BIRD_GROUP_ID" || {
    echo "$CONFIG_DIR 已存在但不属于 $BIRDBOX_USER:$BIRD_GROUP，拒绝接管" >&2
    exit 1
  }
else
  mkdir -p "$CONFIG_DIR"
  chown "$BIRDBOX_USER:$BIRD_GROUP" "$CONFIG_DIR"
fi
if [ -L "$CONFIG_DIR/versions" ]; then
  echo "$CONFIG_DIR/versions 不能是符号链接" >&2
  exit 1
fi
if [ -e "$CONFIG_DIR/versions" ]; then
  test -d "$CONFIG_DIR/versions" || { echo "$CONFIG_DIR/versions 不是目录" >&2; exit 1; }
  file_owned_by "$CONFIG_DIR/versions" "$BIRDBOX_USER_ID" "$BIRD_GROUP_ID" || {
    echo "$CONFIG_DIR/versions 已存在但不属于 $BIRDBOX_USER:$BIRD_GROUP，拒绝接管" >&2
    exit 1
  }
else
  mkdir -p "$CONFIG_DIR/versions"
  chown "$BIRDBOX_USER:$BIRD_GROUP" "$CONFIG_DIR/versions"
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
test ! -L "$HOME_DIR" || { echo "$BIRDBOX_USER 的 Home 目录不能是符号链接" >&2; exit 1; }
if [ -e "$HOME_DIR" ]; then
  test -d "$HOME_DIR" || { echo "$BIRDBOX_USER 的 Home 路径不是目录" >&2; exit 1; }
  [ "$(file_uid "$HOME_DIR")" = "$BIRDBOX_USER_ID" ] || { echo "$BIRDBOX_USER 的 Home 目录属主不正确" >&2; exit 1; }
else
  mkdir -p "$HOME_DIR"
  chown "$BIRDBOX_USER:$PRIMARY_GROUP" "$HOME_DIR"
fi
chmod 0750 "$HOME_DIR"
if [ -L "$HOME_DIR/.ssh" ]; then
  echo "$HOME_DIR/.ssh 不能是符号链接" >&2
  exit 1
elif [ -e "$HOME_DIR/.ssh" ]; then
  test -d "$HOME_DIR/.ssh" || { echo "$HOME_DIR/.ssh 不是目录" >&2; exit 1; }
  file_owned_by "$HOME_DIR/.ssh" "$BIRDBOX_USER_ID" "$PRIMARY_GROUP_ID" || { echo "$HOME_DIR/.ssh 属主不正确" >&2; exit 1; }
else
  mkdir -p "$HOME_DIR/.ssh"
  chown "$BIRDBOX_USER:$PRIMARY_GROUP" "$HOME_DIR/.ssh"
fi
chmod 0700 "$HOME_DIR/.ssh"
if [ -L "$HOME_DIR/.ssh/authorized_keys" ]; then
  echo "$HOME_DIR/.ssh/authorized_keys 不能是符号链接" >&2
  exit 1
elif [ -e "$HOME_DIR/.ssh/authorized_keys" ]; then
  test -f "$HOME_DIR/.ssh/authorized_keys" || { echo "$HOME_DIR/.ssh/authorized_keys 不是普通文件" >&2; exit 1; }
  file_owned_by "$HOME_DIR/.ssh/authorized_keys" "$BIRDBOX_USER_ID" "$PRIMARY_GROUP_ID" || { echo "$HOME_DIR/.ssh/authorized_keys 属主不正确" >&2; exit 1; }
else
  : > "$HOME_DIR/.ssh/authorized_keys"
  chown "$BIRDBOX_USER:$PRIMARY_GROUP" "$HOME_DIR/.ssh/authorized_keys"
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

function agentSetupScript(node: ManagedAgentNode, controllerUrl: string, token: string, rpkiRequirements: readonly NodeOnboardingRpkiRequirement[] = []): { includeLine: string; script: string } {
  const baseUrl = controllerUrl.replace(/\/$/, "");
  const requireHttps = controllerUrl.toLowerCase().startsWith("https://") ? "true" : "false";
  const env = `BIRDBOX_CONTROLLER_URL=${shellSingleQuote(controllerUrl)}\nBIRDBOX_NODE_ID=${shellSingleQuote(node.id)}\nBIRDBOX_AGENT_TOKEN=${shellSingleQuote(token)}\nBIRDBOX_AGENT_REQUIRE_HTTPS=${requireHttps}`;
  const includeLine = `include "${node.generatedConfigPath}";`;
  const lines = [
    "#!/bin/sh", "set -eu", "umask 077", `[ "$(id -u)" -eq 0 ] || { echo '请使用 root 身份执行此脚本' >&2; exit 1; }`, "mkdir -p /etc/birdbox /usr/local/bin",
    "detect_agent_arch() {", "  machine=$(uname -m)", "  if [ -r /etc/openwrt_release ]; then . /etc/openwrt_release 2>/dev/null || true; case \"${DISTRIB_ARCH:-}\" in mipsel_*) echo mipsle; return;; mips_*) echo mips; return;; mips64el_*) echo mips64le; return;; mips64_*) echo mips64; return;; aarch64_*) echo arm64; return;; riscv64_*) echo riscv64; return;; esac; fi", "  elf_data() { if command -v od >/dev/null 2>&1; then od -An -tx1 -j5 -N1 /bin/sh | tr -d ' \\n'; elif command -v hexdump >/dev/null 2>&1; then hexdump -s 5 -n 1 -e '1/1 \"%02x\"' /bin/sh; fi; }", "  case \"$machine\" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; armv7*|armv8l) echo arm;; armv6*) echo armv6;; armv5*) echo armv5;; riscv64) echo riscv64;; mips|mipsel) [ \"$(elf_data)\" = 01 ] && echo mipsle || echo mips;; mips64|mips64el) [ \"$(elf_data)\" = 01 ] && echo mips64le || echo mips64;; *) echo ''; esac", "}", "AGENT_ARCH=$(detect_agent_arch)", "[ -n \"$AGENT_ARCH\" ] || { echo \"不支持的 Agent 架构：$(uname -m)\" >&2; exit 1; }", "TMP=/usr/local/bin/birdbox-agent.tmp.$$.${AGENT_ARCH}", `AGENT_URL=${shellSingleQuote(`${baseUrl}/api/agent/releases/latest/download`)}?arch=$AGENT_ARCH`, `if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 "$AGENT_URL" -o "$TMP"; elif command -v wget >/dev/null 2>&1; then wget -q -O "$TMP" "$AGENT_URL"; else echo '缺少 curl 或 wget' >&2; exit 1; fi`,
    "chmod 0755 \"$TMP\"; mv -f \"$TMP\" /usr/local/bin/birdbox-agent", `MAIN_CONFIG=${shellSingleQuote(node.mainConfigPath)}`, `GENERATED_CONFIG=${shellSingleQuote(node.generatedConfigPath)}`, `test -f "$MAIN_CONFIG" || { echo "主配置不存在：$MAIN_CONFIG" >&2; exit 1; }`, `mkdir -p "$(dirname "$GENERATED_CONFIG")"`, `test -e "$GENERATED_CONFIG" || : > "$GENERATED_CONFIG"`, `has_active_include() { awk -v target="$GENERATED_CONFIG" '${ACTIVE_BIRD_INCLUDE_AWK}' "$MAIN_CONFIG"; }`, `MAIN_BACKUP=''`, `if ! has_active_include; then MAIN_BACKUP=$(mktemp "$MAIN_CONFIG.birdbox.XXXXXX"); cp -p "$MAIN_CONFIG" "$MAIN_BACKUP"; printf '\\n%s\\n' ${shellSingleQuote(includeLine)} >> "$MAIN_CONFIG"; fi`, "if ! birdc -s "+shellSingleQuote(node.socketPath)+" 'configure check' || ! birdc -s "+shellSingleQuote(node.socketPath)+" configure; then [ -z \"$MAIN_BACKUP\" ] || cp -p \"$MAIN_BACKUP\" \"$MAIN_CONFIG\"; echo 'BIRD 配置检查/加载失败，主配置已恢复' >&2; exit 1; fi", "[ -z \"$MAIN_BACKUP\" ] || rm -f \"$MAIN_BACKUP\"", "cat > /etc/birdbox/agent.env <<'BIRDBOX_AGENT_ENV'", env, `BIRDBOX_ALLOWED_MAIN_CONFIG=${shellSingleQuote(node.mainConfigPath)}`, `BIRDBOX_ALLOWED_GENERATED_CONFIG=${shellSingleQuote(node.generatedConfigPath)}`, `BIRDBOX_ALLOWED_SOCKET=${shellSingleQuote(node.socketPath)}`, "BIRDBOX_AGENT_LEGACY_EXEC=disabled", "BIRDBOX_AGENT_ENV", "chmod 0600 /etc/birdbox/agent.env",
    "if command -v systemctl >/dev/null 2>&1 && [ ! -r /etc/openwrt_release ]; then", "  cat > /etc/systemd/system/birdbox-agent.service <<'BIRDBOX_AGENT_UNIT'", "[Unit]", "Description=Birdbox Agent", "After=network-online.target", "[Service]", "EnvironmentFile=/etc/birdbox/agent.env", "ExecStart=/usr/local/bin/birdbox-agent", "Restart=always", "RestartSec=5", "User=root", "[Install]", "WantedBy=multi-user.target", "BIRDBOX_AGENT_UNIT", "  systemctl daemon-reload; systemctl enable --now birdbox-agent", "else",
    "  cat > /etc/init.d/birdbox-agent <<'BIRDBOX_PROCD'", "#!/bin/sh /etc/rc.common", "START=95", "USE_PROCD=1", `start_service() { . /etc/birdbox/agent.env; procd_open_instance; procd_set_param command /usr/local/bin/birdbox-agent; procd_set_param env BIRDBOX_CONTROLLER_URL="$BIRDBOX_CONTROLLER_URL" BIRDBOX_NODE_ID="$BIRDBOX_NODE_ID" BIRDBOX_AGENT_TOKEN="$BIRDBOX_AGENT_TOKEN" BIRDBOX_AGENT_REQUIRE_HTTPS="$BIRDBOX_AGENT_REQUIRE_HTTPS" BIRDBOX_ALLOWED_MAIN_CONFIG="$BIRDBOX_ALLOWED_MAIN_CONFIG" BIRDBOX_ALLOWED_GENERATED_CONFIG="$BIRDBOX_ALLOWED_GENERATED_CONFIG" BIRDBOX_ALLOWED_SOCKET="$BIRDBOX_ALLOWED_SOCKET" BIRDBOX_AGENT_LEGACY_EXEC="$BIRDBOX_AGENT_LEGACY_EXEC"; procd_set_param respawn; procd_close_instance; }`, "BIRDBOX_PROCD", "  chmod 0755 /etc/init.d/birdbox-agent", "  /etc/init.d/birdbox-agent enable", "  if /etc/init.d/birdbox-agent running >/dev/null 2>&1; then /etc/init.d/birdbox-agent restart; else /etc/init.d/birdbox-agent start; fi", "  AGENT_RUNNING=0", "  ATTEMPT=0", "  while [ \"$ATTEMPT\" -lt 10 ]; do", "    if /etc/init.d/birdbox-agent running >/dev/null 2>&1; then AGENT_RUNNING=1; break; fi", "    ATTEMPT=$((ATTEMPT + 1)); sleep 1", "  done", "  [ \"$AGENT_RUNNING\" -eq 1 ] || { echo 'Birdbox Agent 启动失败，请执行 /etc/init.d/birdbox-agent status 和 logread 查看原因' >&2; exit 1; }", "fi", "echo 'Birdbox Agent 已启动，等待主控注册'",
  ];
  const installIndex = lines.findIndex((line) => line.startsWith("chmod 0755"));
  lines.splice(installIndex < 0 ? lines.length : installIndex, 0,
    "CHECKSUM_TMP=$TMP.sha256",
    `CHECKSUM_URL=${shellSingleQuote(`${baseUrl}/api/agent/releases/latest/checksum`)}?arch=$AGENT_ARCH`,
    `if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 "$CHECKSUM_URL" -o "$CHECKSUM_TMP"; elif command -v wget >/dev/null 2>&1; then wget -q -O "$CHECKSUM_TMP" "$CHECKSUM_URL"; else echo '缺少 curl 或 wget，无法验证 Agent 下载' >&2; exit 1; fi`,
    // BusyBox tr on OpenWrt does not reliably implement POSIX character
    // classes; sed keeps checksum parsing portable across ash environments.
    `EXPECTED=$(sed 's/[[:space:]]//g' < "$CHECKSUM_TMP")`,
    `case "$EXPECTED" in ''|*[!0-9a-fA-F]*) echo 'Agent 校验摘要格式错误' >&2; exit 1;; esac`, `[ "\${#EXPECTED}" -eq 64 ] || { echo 'Agent 校验摘要长度错误' >&2; exit 1; }`,
    `if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP" | awk '{print $1}'); elif command -v openssl >/dev/null 2>&1; then ACTUAL=$(openssl dgst -sha256 "$TMP" | awk '{print $NF}'); else echo '缺少 sha256sum 或 openssl，无法验证 Agent 下载' >&2; exit 1; fi`,
    `test "$(printf '%s' "$EXPECTED" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$ACTUAL" | tr '[:upper:]' '[:lower:]')" || { echo 'Agent 下载校验失败' >&2; exit 1; }`,
  );
  const rpkiIndex = lines.findIndex((line) => line.startsWith("mkdir -p \"$(dirname"));
  if (rpkiRequirements.length && rpkiIndex >= 0) lines.splice(rpkiIndex, 0, ...rpkiRequirements.map((requirement) => `test -r ${shellSingleQuote(requirement.path)} || { echo ${shellSingleQuote(`全节点 RPKI 资源“${requirement.resourceLabel}”缺少 ${requirement.family.toUpperCase()} ROA 文件：${requirement.path}`)} >&2; exit 1; }`));
  const ownershipIndex = lines.findIndex((line) => line.startsWith("test -e \"$GENERATED_CONFIG\""));
  if (ownershipIndex >= 0) lines.splice(ownershipIndex + 1, 0,
    `SOCKET_PATH=${shellSingleQuote(node.socketPath)}`,
    `test -S "$SOCKET_PATH" || { echo "BIRD Socket 不存在：$SOCKET_PATH" >&2; exit 1; }`,
    `BIRD_SOCKET_GID=$(if command -v stat >/dev/null 2>&1; then stat -c '%g' "$SOCKET_PATH"; else ls -ldn "$SOCKET_PATH" | awk '{print $4}'; fi)`,
    `CONFIG_DIR=$(dirname "$GENERATED_CONFIG")`,
    `VERSION_DIR="$CONFIG_DIR/versions"`,
    `mkdir -p "$VERSION_DIR"`,
    `if [ ! -L "$GENERATED_CONFIG" ]; then INITIAL_FILE="$VERSION_DIR/$(basename "$GENERATED_CONFIG").initial.conf"; if [ -e "$GENERATED_CONFIG" ]; then cp -p "$GENERATED_CONFIG" "$INITIAL_FILE"; else : > "$INITIAL_FILE"; fi; ln -sfn "versions/$(basename "$INITIAL_FILE")" "$GENERATED_CONFIG"; fi`,
    `if command -v chgrp >/dev/null 2>&1; then chgrp "$BIRD_SOCKET_GID" "$CONFIG_DIR" "$VERSION_DIR" "$GENERATED_CONFIG" || { echo '无法设置 Birdbox 配置目录属组' >&2; exit 1; }; else echo '缺少 chgrp，无法设置 Birdbox 配置目录属组' >&2; exit 1; fi`,
    `chmod 0750 "$CONFIG_DIR" "$VERSION_DIR"`,
    `chmod 0640 "$GENERATED_CONFIG"`,
  );
  return { includeLine, script: `${lines.join("\n")}\n` };
}

async function inspectOnboardingNode(node: ManagedSshNode): Promise<NodeRuntime> {
  const access = await checkIncludeNodeAccess(node);
  if (!access.ok) {
    const detail = access.stderr || access.stdout || "节点接入条件检查失败";
    if (/\/bin\/sh:\s*Permission denied/i.test(detail)) {
      fail(
        422,
        `SSH 公钥认证成功，但用户 ${node.sshUser} 无法执行登录 Shell /bin/sh。请在目标节点检查 getent passwd ${node.sshUser} 和 namei -l /bin/sh；Shell 文件及 /bin、/usr、/usr/bin 等父目录必须允许该用户进入。原始错误：${detail}`,
      );
    }
    fail(422, detail);
  }
  const runtime = await inspectNode(node);
  if (!runtime.reachable || !runtime.bird2) fail(422, runtime.error || "目标节点未运行受支持的 BIRD 2");
  return runtime;
}

async function verifyOnboardingNode(
  node: ManagedSshNode,
  config: string,
  rpkiRequirements: readonly NodeOnboardingRpkiRequirement[],
): Promise<{ runtime: NodeRuntime; validation: { ok: true } }> {
  const runtime = await inspectOnboardingNode(node);
  const validation = await stageAndValidate(node, config);
  if (!validation.ok) {
    const detail = validation.stderr || validation.stdout || "系统主配置预检失败";
    fail(422, onboardingValidationError(rpkiRequirements, detail));
  }
  return { runtime, validation: { ok: true } };
}


export class NodeOnboardingService {
  readonly #options: NodeOnboardingServiceOptions;
  readonly #scriptDeliveries = new Map<string, ScriptDelivery>();
  readonly #scriptDeliveryCleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: NodeOnboardingServiceOptions) {
    this.#options = options;
    this.#scriptDeliveryCleanupTimer = setInterval(() => this.#cleanupScriptDeliveries(), 60_000);
    this.#scriptDeliveryCleanupTimer.unref?.();
  }

  #cleanupScriptDeliveries(now = Date.now()): void {
    for (const [token, delivery] of this.#scriptDeliveries) {
      if (delivery.expiresAt <= now || delivery.downloads >= SCRIPT_DELIVERY_MAX_DOWNLOADS) this.#scriptDeliveries.delete(token);
    }
  }

  #publishScript(script: string): string {
    const now = Date.now();
    this.#cleanupScriptDeliveries(now);
    while (this.#scriptDeliveries.size >= 256) {
      const oldest = this.#scriptDeliveries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#scriptDeliveries.delete(oldest);
    }
    const token = randomBytes(24).toString("base64url");
    this.#scriptDeliveries.set(token, { script, expiresAt: now + SCRIPT_DELIVERY_TTL_MS, downloads: 0 });
    const baseUrl = (this.#options.agentControllerUrl ?? "http://127.0.0.1:3000").replace(/\/$/, "");
    return `${baseUrl}/api/nodes/setup-script/${token}`;
  }

  async getSetupScript(deliveryToken: string): Promise<string> {
    const delivery = this.#scriptDeliveries.get(deliveryToken);
    if (!delivery || delivery.expiresAt <= Date.now() || delivery.downloads >= SCRIPT_DELIVERY_MAX_DOWNLOADS) {
      this.#scriptDeliveries.delete(deliveryToken);
      fail(404, "准备脚本不存在或已过期");
    }
    delivery.downloads += 1;
    if (delivery.downloads >= SCRIPT_DELIVERY_MAX_DOWNLOADS) this.#scriptDeliveries.delete(deliveryToken);
    return delivery.script;
  }

  async createSetupScript(body: Record<string, unknown>) {
    const setupId = (body.transport === "agent" || body.transport === undefined)
      ? (typeof body.id === "string" && body.id ? body.id : this.#options.makeId("node"))
      : undefined;
    const node = normalizeOnboardingNode(body, setupId ?? "node_onboarding");
    logger.info("开始生成节点准备脚本", { nodeId: node.id, transport: node.transport });
    const inventory = await this.#options.store.read();
    const rpkiRequirements = globalRpkiFileRequirements(inventory);
    if (node.transport === "agent") {
      if (!this.#options.agentBroker) fail(503, "Agent 通信服务尚未初始化");
      ensureAgentControllerUrl(this.#options.agentControllerUrl ?? "http://127.0.0.1:3000");
      const existing = inventory.nodes.find((item) => item.id === node.id);
      if (existing?.transport === "agent" && body.rotateCredential !== true) {
        fail(409, `节点 ${existing.name} 已存在；重新生成准备脚本会使当前 Agent 凭据失效。如确需重装，请明确选择重置 Agent 凭据`, "AGENT_CREDENTIAL_EXISTS");
      }
      const token = await this.#options.agentBroker.issueToken(node.id);
      const script = agentSetupScript(node, this.#options.agentControllerUrl ?? "http://127.0.0.1:3000", token, rpkiRequirements);
      const setupScriptUrl = this.#publishScript(script.script);
      logger.info("节点 Agent 准备脚本已生成", { nodeId: node.id });
      return { status: 200, payload: { ...script, setupScriptUrl, publicKey: "", agentToken: token, nodeId: node.id, rpkiRequirements } };
    }
    const script = nodeSetupScript(node, this.#options.controllerPublicKey(), rpkiRequirements);
    const payload = {
      status: 200,
      payload: {
        ...script,
        setupScriptUrl: this.#publishScript(script.script),
        publicKey: this.#options.controllerPublicKey(),
        rpkiRequirements,
      },
    };
    logger.info("节点 SSH 准备脚本已生成", { nodeId: node.id });
    return payload;
  }

  async createAgentUpgradeScript(nodeId: string) {
    if (!this.#options.agentBroker) fail(503, "Agent 通信服务尚未初始化");
    const inventory = await this.#options.store.read();
    const node = findNode(inventory, nodeId);
    if (node.transport !== "ssh") fail(409, "只有旧 SSH 节点可以生成 Agent 升级脚本");
    const agentNode = normalizeAgentNode({ ...node, transport: "agent", id: node.id }, node.id);
    ensureAgentControllerUrl(this.#options.agentControllerUrl ?? "http://127.0.0.1:3000");
    const token = await this.#options.agentBroker.issueToken(node.id);
    const rpkiRequirements = globalRpkiFileRequirements(inventory);
    const script = agentSetupScript(agentNode, this.#options.agentControllerUrl ?? "http://127.0.0.1:3000", token, rpkiRequirements);
    const setupScriptUrl = this.#publishScript(script.script);
    logger.info("节点 Agent 升级脚本已生成", { nodeId });
    return { status: 200, payload: { ...script, setupScriptUrl, publicKey: "", agentToken: token, nodeId: node.id, rpkiRequirements } };
  }

  async promoteToAgent(nodeId: string) {
    if (!this.#options.agentBroker) fail(503, "Agent 通信服务尚未初始化");
    const current = await this.#options.store.read();
    const previous = findNode(current, nodeId);
    logger.info("开始切换节点管理方式", { nodeId, from: previous.transport, to: "agent" });
    if (previous.transport === "agent") return { status: 200, payload: { node: previous, inventory: current, deployment: { applied: false, nodeIds: [], nodes: [], sessions: [] }, events: this.#options.getEvents() } };
    if (previous.transport !== "ssh") fail(409, "只有 SSH 节点可以切换到 Agent");
    if (!this.#options.agentBroker.status(nodeId)?.connected) fail(409, "Agent 尚未注册，不能切换管理方式");
    const candidate = normalizeAgentNode({ ...previous, transport: "agent", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "include" }, nodeId);
    const activeSourcePolicies = current.sourcePolicies.filter((resource) => resource.enabled && resourceAppliesToNode(resource, nodeId));
    // Remove rules that the legacy SSH node could have received, including
    // local-gateway rules from older versions, then re-add only valid Agent rules.
    const managedSourceRules = sourcePolicyManagedRules(activeSourcePolicies)
      .map(({ priority, source, destination, table, kind }) => ({ priority, source, destination, table, kind }));
    const sourceRules = sourcePolicyManagedRulesForNode(activeSourcePolicies, candidate)
      .map(({ priority, source, destination, table, kind }) => ({ priority, source, destination, table, kind }));
    const { state, deployment } = await this.#options.deploymentService.mutateAndApply((draft) => {
      const index = draft.nodes.findIndex((item) => item.id === nodeId);
      if (index < 0) fail(404, "受管节点不存在");
      draft.nodes[index] = candidate;
      return candidate;
    }, () => [nodeId], {
      apply: async (node) => {
        if (!managedSourceRules.length && !sourceRules.length) return;
        const result = await executeNodeRpc(node, "network.ip_rules", { removeRules: managedSourceRules, rules: sourceRules }, 60_000);
        if (!result.ok) fail(502, result.stderr || result.stdout || `${node.name} 的旧系统规则接管失败`);
      },
      rollback: async (node) => {
        if (!managedSourceRules.length && !sourceRules.length) return;
        const result = await executeNodeRpc(node, "network.ip_rules", { removeRules: sourceRules, rules: managedSourceRules }, 60_000);
        if (!result.ok) fail(502, result.stderr || result.stdout || `${node.name} 的系统规则接管回滚失败`);
      },
    });
    this.#options.addEvent("success", `受管节点 ${candidate.name} 已切换为 Agent`, nodeId);
    logger.info("节点已切换为 Agent", { nodeId });
    return { status: 200, payload: { node: candidate, inventory: state, deployment, events: this.#options.getEvents() } };
  }

  async test(body: Record<string, unknown>) {
    const node = normalizeOnboardingNode(body, typeof body.id === "string" ? body.id : "node_onboarding");
    logger.info("开始检查节点接入条件", { nodeId: node.id, transport: node.transport });
    if (node.transport === "agent") {
      const status = this.#options.agentBroker?.status(node.id);
      if (!status?.connected) fail(422, "Agent 尚未连接主控，请先执行 Agent 安装脚本并等待注册");
      logger.info("节点接入条件检查通过", { nodeId: node.id, transport: node.transport });
      return { status: 200, payload: { ok: true, node: { name: node.name, sshHost: null, sshPort: null, sshUser: null }, runtime: { version: status.agentVersion, bird2: true } } };
    }
    const verification = await this.#options.withDeploymentLock(async () => {
      const current = await this.#options.store.read();
      const candidate = structuredClone(current);
      candidate.nodes.push(node);
      const inventory = validateInventory(candidate);
      return verifyOnboardingNode(
        node,
        configForNode(inventory, node),
        globalRpkiFileRequirements(current),
      );
    });
    logger.info("节点接入条件检查通过", { nodeId: node.id, transport: node.transport });
    return {
      status: 200,
      payload: {
        ok: true,
        node: { name: node.name, sshHost: node.sshHost, sshPort: node.sshPort, sshUser: node.sshUser },
        runtime: { version: verification.runtime.version, bird2: verification.runtime.bird2 },
      },
    };
  }

  async create(body: Record<string, unknown>) {
    const requestedId = body.transport === "agent" && typeof body.id === "string" ? body.id : this.#options.makeId("node");
    const node = normalizeOnboardingNode(body, requestedId);
    logger.info("开始添加受管节点", { nodeId: node.id, transport: node.transport });
    if (node.transport === "agent") {
      const broker = this.#options.agentBroker;
      if (!broker) fail(503, "Agent 通信服务尚未初始化");
      const current = await this.#options.store.read();
      if (current.nodes.some((item) => item.id === node.id)) fail(409, "受管节点 ID 已存在");
      const agentToken = broker.hasCredential(node.id) ? undefined : await broker.issueToken(node.id);
      const { state } = await this.#options.withDeploymentLock(() => this.#options.store.mutate((draft) => { draft.nodes.push(node); return node; }));
      this.#options.addEvent("success", `已添加 Agent 受管节点 ${node.name}，等待 Agent 注册`, node.id);
      logger.info("Agent 受管节点已添加", { nodeId: node.id });
      return { status: 201, payload: { node, agentToken, inventory: state, deployment: { applied: false, nodeIds: [], nodes: [], sessions: [] }, events: this.#options.getEvents() } };
    }
    const { state, deployment } = await this.#options.deploymentService.mutateAndApply(async (draft) => {
      await inspectOnboardingNode(node);
      draft.nodes.push(node);
      return node;
    }, () => [node.id]);
    this.#options.addEvent("success", `已添加受管节点 ${node.name}`, node.id);
    logger.info("受管节点已添加", { nodeId: node.id, transport: node.transport });
    return {
      status: 201,
      payload: { node, inventory: state, deployment, events: this.#options.getEvents() },
    };
  }

  async decommission(
    nodeId: string,
    force = false,
  ): Promise<{ state: Inventory; node: ManagedNode; forced: boolean }> {
    return this.#options.withDeploymentLock(async () => {
      let applied = false;
      let committed = false;
      let node: ManagedNode | null = null;
      let journal: ActiveDeploymentJournal | null = null;
      try {
        const current = await this.#options.store.read();
        node = findNode(current, nodeId);
        const targetNode = node;
        logger.info(force ? "开始强制删除受管节点" : "开始删除受管节点", { nodeId: targetNode.id, transport: targetNode.transport });
        if (current.ibgpDomains.some((domain) => domain.members.some((member) => member.nodeId === targetNode.id))) {
          fail(409, "请先从 iBGP 域中移除该节点或删除对应域");
        }
        if (force) {
          const inventory = validateInventory({
            ...current,
            nodes: current.nodes.filter((item) => item.id !== targetNode.id),
            peers: current.peers.filter((item) => item.nodeId !== targetNode.id),
            sessions: current.sessions.filter((item) => item.nodeId !== targetNode.id),
            defines: removeNodeFromMultiScope(current.defines, targetNode.id),
            functions: removeNodeFromMultiScope(current.functions, targetNode.id),
            filters: removeNodeFromMultiScope(current.filters, targetNode.id),
            rpki: removeNodeFromMultiScope(current.rpki, targetNode.id),
            sourcePolicies: removeNodeFromMultiScope(current.sourcePolicies, targetNode.id),
            staticProtocols: current.staticProtocols.filter((item) => item.nodeId !== targetNode.id),
            directProtocols: current.directProtocols.filter((item) => item.nodeId !== targetNode.id),
            kernelProtocols: removeNodeFromMultiScope(current.kernelProtocols, targetNode.id),
          });
          const state = await this.#options.store.replace(current, inventory);
          committed = true;
          await this.#options.agentBroker?.revoke(targetNode.id);
          logger.warn("受管节点已强制删除", { nodeId: targetNode.id });
          return { state, node: targetNode, forced: true };
        }
        if (
          nodePeers(current, targetNode.id).length
          || ownedNodePolicyResources(current, targetNode.id).length
          || nodeSessions(current, targetNode.id).length
        ) {
          fail(409, "请先删除该节点的会话、Peer 和节点级资源");
        }
        const inventory = validateInventory({
          ...current,
          nodes: current.nodes.filter((item) => item.id !== targetNode.id),
        });
        const validation = await stageAndValidate(
          targetNode,
          renderBirdConfig(targetNode, [], [], [], [], [], [], [], []),
        );
        if (!validation.ok) fail(422, validation.stderr || validation.stdout || "节点删除配置检查失败");
        journal = await this.#options.deploymentService.beginJournal(
          current,
          inventory,
          [targetNode.id],
          [targetNode],
        );
        applied = true;
        const result = await applyStagedConfig(targetNode);
        if (!result.ok) fail(500, result.stderr || result.stdout || "节点删除配置应用失败");
        const state = await this.#options.store.replace(current, inventory);
        committed = true;
        await this.#options.agentBroker?.revoke(targetNode.id);
        await this.#options.deploymentService.clearJournal(journal);
        journal = null;
        logger.info("受管节点已删除", { nodeId: targetNode.id });
        return { state, node: targetNode, forced: false };
      } catch (error) {
        logger.error("删除受管节点失败", { nodeId: node?.id ?? nodeId, ...errorContext(error) });
        if (applied && !committed && node) {
          let journalMarkedForRollback = false;
          if (journal) {
            try {
              await this.#options.deploymentService.setJournalDirection(journal, "rollback");
              journalMarkedForRollback = true;
            } catch (journalError) {
              logger.error("节点删除回滚标记失败", { ...errorContext(journalError) });
            }
          }
          const rollback = await rollbackNode(node);
          if (!rollback.ok) {
            this.#options.addEvent(
              "error",
              `${node.name} 删除回滚失败：${rollback.stderr || rollback.stdout}`,
              node.id,
            );
          } else if (journal && journalMarkedForRollback) {
            try {
              await this.#options.deploymentService.clearJournal(journal);
              journal = null;
            } catch (journalError) {
              logger.error("节点删除恢复记录清理失败", { ...errorContext(journalError) });
            }
          }
        }
        throw error;
      }
    });
  }
}
