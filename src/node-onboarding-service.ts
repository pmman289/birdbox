import path from "node:path";

import type { ChangeEvent, NodeOnboardingRpkiRequirement, NodeRuntime } from "../packages/contracts/src/api.js";
import type { Inventory, ManagedNode } from "../packages/contracts/src/inventory.js";
import {
  ACTIVE_BIRD_INCLUDE_AWK,
  applyStagedConfig,
  checkIncludeNodeAccess,
  inspectNode,
  normalizeNode,
  renderBirdConfig,
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

type ManagedSshNode = ManagedNode & {
  transport: "ssh";
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshIdentity: "managed";
  deploymentMode: "include";
};

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
}

function normalizeSshNode(inputValue: unknown): ManagedNode {
  const input = record(inputValue, "节点参数不能为空");
  if (input.transport !== "ssh") fail(400, "Birdbox 仅支持 SSH 管理节点");
  return normalizeNode(input);
}

function normalizeOnboardingNode(inputValue: unknown, id = "node_onboarding"): ManagedSshNode {
  const input = record(inputValue, "节点参数不能为空");
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
  if (!node.sshUser || !node.sshHost || node.sshPort === null || !/^[a-z_][a-z0-9_-]{0,31}$/.test(node.sshUser)) {
    fail(400, "新节点的 SSH 用户名必须使用可移植的小写 Linux 用户名");
  }
  return node as ManagedSshNode;
}

export function globalRpkiFileRequirements(inventory: Inventory): NodeOnboardingRpkiRequirement[] {
  return inventory.rpki.flatMap((resource) => {
    if (!resource.enabled || resource.nodeId !== null || resource.sourceType !== "file") return [];
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
for REQUIRED_COMMAND in birdc stat mkdir mktemp awk grep chown chmod cp mv ln readlink id cut tr; do
  command -v "$REQUIRED_COMMAND" >/dev/null 2>&1 || { echo "缺少 $REQUIRED_COMMAND 命令" >&2; exit 1; }
done
BIRD_SOCKET_GROUP=$(stat -c '%G' "$SOCKET_PATH")
BIRD_SOCKET_GROUP_ID=$(stat -c '%g' "$SOCKET_PATH")
case "$BIRD_SOCKET_GROUP" in
  ''|UNKNOWN) echo "无法识别 BIRD Socket 用户组" >&2; exit 1 ;;
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

if command -v getent >/dev/null 2>&1; then
  PASSWD_ENTRY=$(getent passwd "$BIRDBOX_USER")
else
  PASSWD_ENTRY=$(awk -F: -v user="$BIRDBOX_USER" '$1 == user { print; exit }' /etc/passwd)
fi
HOME_DIR=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f6)
USER_SHELL=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f7)
PRIMARY_GROUP=$(id -gn "$BIRDBOX_USER")
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
else
  echo "无法验证 $BIRDBOX_USER 的登录 Shell：缺少 runuser/su" >&2
  exit 1
fi

if [ "$BIRD_SOCKET_GROUP_ID" = 0 ]; then
  BIRD_GROUP="$PRIMARY_GROUP"
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
      && [ "$(stat -c '%G' "$SOCKET_PATH")" = "$BIRD_GROUP" ] \
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
fi

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
  mkdir -p "$CONFIG_DIR"
  chown "$BIRDBOX_USER:$BIRD_GROUP" "$CONFIG_DIR"
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
  [ "$(stat -c '%U' "$HOME_DIR")" = "$BIRDBOX_USER" ] || { echo "$BIRDBOX_USER 的 Home 目录属主不正确" >&2; exit 1; }
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
  [ "$(stat -c '%U:%G' "$HOME_DIR/.ssh")" = "$BIRDBOX_USER:$PRIMARY_GROUP" ] || { echo "$HOME_DIR/.ssh 属主不正确" >&2; exit 1; }
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
  [ "$(stat -c '%U:%G' "$HOME_DIR/.ssh/authorized_keys")" = "$BIRDBOX_USER:$PRIMARY_GROUP" ] || { echo "$HOME_DIR/.ssh/authorized_keys 属主不正确" >&2; exit 1; }
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

  constructor(options: NodeOnboardingServiceOptions) {
    this.#options = options;
  }

  async createSetupScript(body: Record<string, unknown>) {
    const node = normalizeOnboardingNode(body);
    const inventory = await this.#options.store.read();
    const rpkiRequirements = globalRpkiFileRequirements(inventory);
    return {
      status: 200,
      payload: {
        ...nodeSetupScript(node, this.#options.controllerPublicKey(), rpkiRequirements),
        publicKey: this.#options.controllerPublicKey(),
        rpkiRequirements,
      },
    };
  }

  async test(body: Record<string, unknown>) {
    const node = normalizeOnboardingNode(body);
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
    const node = normalizeOnboardingNode(body, this.#options.makeId("node"));
    const { state, deployment } = await this.#options.deploymentService.mutateAndApply(async (draft) => {
      await inspectOnboardingNode(node);
      draft.nodes.push(node);
      return node;
    }, () => [node.id]);
    this.#options.addEvent("success", `已添加受管节点 ${node.name}`, node.id);
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
            filters: current.filters.filter((item) => item.nodeId !== targetNode.id),
            rpki: current.rpki.filter((item) => item.nodeId !== targetNode.id),
            staticProtocols: current.staticProtocols.filter((item) => item.nodeId !== targetNode.id),
          });
          const state = await this.#options.store.replace(current, inventory);
          committed = true;
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
          renderBirdConfig(targetNode, [], [], [], [], [], [], []),
        );
        if (!validation.ok) fail(422, validation.stderr || validation.stdout || "节点退役配置检查失败");
        journal = await this.#options.deploymentService.beginJournal(
          current,
          inventory,
          [targetNode.id],
          [targetNode],
        );
        applied = true;
        const result = await applyStagedConfig(targetNode);
        if (!result.ok) fail(500, result.stderr || result.stdout || "节点退役配置应用失败");
        const state = await this.#options.store.replace(current, inventory);
        committed = true;
        await this.#options.deploymentService.clearJournal(journal);
        journal = null;
        return { state, node: targetNode, forced: false };
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
            this.#options.addEvent(
              "error",
              `${node.name} 退役回滚失败：${rollback.stderr || rollback.stdout}`,
              node.id,
            );
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
}
