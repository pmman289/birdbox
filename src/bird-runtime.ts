import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AddressFamily, ManagedNode } from "../packages/contracts/src/inventory.js";
import type { NodeRuntime, RouteDetail } from "../packages/contracts/src/api.js";
import {
  RUNTIME,
  assertValidation,
  normalizeId,
  normalizeNode,
  normalizeOptionalName,
} from "./bird-normalize-common.js";
import { parseProtocolStatuses, parseRouteDetails } from "./bird-runtime-parser.js";

interface ManagedSshConfiguration {
  identityFile: string | null;
  knownHostsFile: string | null;
}

interface RunOnNodeOptions {
  timeout?: number;
  maxBuffer?: number;
  input?: string;
}

export interface NodeCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number;
}

interface RouteInspectionOptions {
  limit?: number;
  table?: string | null;
}

interface RouteInspectionResult {
  ok: boolean;
  family: AddressFamily;
  table: string | null;
  routes: RouteDetail[];
  truncated: boolean;
  limit: number;
  error: string | null;
}

interface ExecError extends ExecFileException {
  stdout?: string;
  stderr?: string;
}

let managedSshConfiguration: ManagedSshConfiguration = { identityFile: null, knownHostsFile: null };

export function configureManagedSsh({ identityFile, knownHostsFile }: { identityFile: string; knownHostsFile: string }): void {
  managedSshConfiguration = {
    identityFile: path.resolve(identityFile),
    knownHostsFile: path.resolve(knownHostsFile),
  };
}

export const ACTIVE_BIRD_INCLUDE_AWK = `
BEGIN {
  quote = sprintf("%c", 34)
  backslash = sprintf("%c", 92)
}
function strip_comments(source, output, cursor, character, pair, quoted, escaped, ending) {
  output = ""
  for (cursor = 1; cursor <= length(source);) {
    character = substr(source, cursor, 1)
    pair = substr(source, cursor, 2)
    if (in_block_comment) {
      ending = index(substr(source, cursor), "*/")
      if (!ending) return output
      cursor += ending + 1
      in_block_comment = 0
      continue
    }
    if (quoted) {
      output = output character
      if (escaped) escaped = 0
      else if (character == backslash) escaped = 1
      else if (character == quote) quoted = 0
      cursor += 1
      continue
    }
    if (character == quote) {
      quoted = 1
      output = output character
      cursor += 1
      continue
    }
    if (pair == "/*") {
      in_block_comment = 1
      cursor += 2
      continue
    }
    if (pair == "//" || character == "#") break
    output = output character
    cursor += 1
  }
  return output
}
{
  line = strip_comments($0)
  sub(/^[[:space:]]*/, "", line)
  sub(/[[:space:]]*$/, "", line)
  if (line ~ /^include[[:space:]]+"/) {
    rest = line
    sub(/^include[[:space:]]+"/, "", rest)
    ending = index(rest, quote)
    suffix = substr(rest, ending + 1)
    sub(/^[[:space:]]*/, "", suffix)
    sub(/[[:space:]]*$/, "", suffix)
    if (ending && substr(rest, 1, ending - 1) == target && suffix == ";") found = 1
  }
}
END { exit found ? 0 : 1 }
`.trim();

function sshArgs(node: ManagedNode, remoteCommand: string): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "HashKnownHosts=yes",
    "-o", "UpdateHostKeys=yes",
  ];
  if (node.sshPort !== 22) args.push("-p", String(node.sshPort));
  if (node.sshIdentity === "managed") {
    assertValidation(managedSshConfiguration.identityFile && managedSshConfiguration.knownHostsFile, "Birdbox 托管 SSH 密钥尚未初始化");
    args.push(
      "-i", managedSshConfiguration.identityFile,
      "-o", `UserKnownHostsFile=${managedSshConfiguration.knownHostsFile}`,
      "-o", "IdentitiesOnly=yes",
    );
  }
  const commandWithSystemPath = `PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH; export PATH; ${remoteCommand}`;
  args.push("--", node.sshUser ? `${node.sshUser}@${node.sshHost}` : node.sshHost as string, commandWithSystemPath);
  return args;
}

function execFileWithInput(
  executable: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        const execError = error as ExecError;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

export async function runOnNode(nodeInput: unknown, command: string, options: RunOnNodeOptions = {}): Promise<NodeCommandResult> {
  const input = nodeInput && typeof nodeInput === "object" ? nodeInput as Partial<ManagedNode> : null;
  assertValidation(input?.kind === "managed-node", "命令只能在受管节点执行");
  const node = normalizeNode(nodeInput);
  const timeout = options.timeout ?? 15_000;
  const maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024;
  try {
    const executable = node.transport === "local" ? "bash" : "ssh";
    const args = node.transport === "local" ? ["-lc", command] : sshArgs(node, command);
    const result = await execFileWithInput(executable, args, {
      timeout,
      maxBuffer,
      encoding: "utf8",
    }, options.input);
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const execError = error as ExecError;
    return {
      ok: false,
      stdout: String(execError.stdout ?? "").trim(),
      stderr: String(execError.stderr ?? execError.message ?? "命令执行失败").trim(),
      code: execError.code ?? 1,
    };
  }
}

export async function inspectNode(nodeInput: unknown): Promise<NodeRuntime> {
  const node = normalizeNode(nodeInput);
  const command = `
version=$(bird --version 2>&1 || true)
if [ -S '${node.socketPath}' ]; then
  protocols=$(birdc -s '${node.socketPath}' -v 'show protocols all' 2>&1 || true)
else
  protocols=''
fi
printf '%s\\n---BIRDBOX---\\n%s\\n' "$version" "$protocols"
`.trim();
  const result = await runOnNode(node, command, { timeout: 12_000 });
  const [version = "", raw = ""] = result.stdout.split("---BIRDBOX---");
  return {
    nodeId: node.id,
    reachable: result.ok,
    bird2: /BIRD version 2\./.test(version),
    version: version.trim() || null,
    protocols: parseProtocolStatuses(raw),
    error: result.ok ? null : (result.stderr || "节点不可达"),
    raw: raw.trim(),
  };
}

export async function checkIncludeNodeAccess(nodeInput: unknown): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  assertValidation(node.deploymentMode === "include", "只有 Include 节点需要执行接入检查");
  const directory = path.posix.dirname(node.generatedConfigPath);
  const command = [
    "set -eu",
    `test -S '${node.socketPath}' || { echo 'BIRD 控制 Socket 不存在：${node.socketPath}' >&2; exit 1; }`,
    `test -r '${node.mainConfigPath}' || { echo 'SSH 用户无法读取 BIRD 主配置：${node.mainConfigPath}' >&2; exit 1; }`,
    `test -d '${directory}' || { echo 'Birdbox 配置目录不存在：${directory}' >&2; exit 1; }`,
    `test -w '${directory}' || { echo 'SSH 用户无法写入 Birdbox 配置目录：${directory}' >&2; exit 1; }`,
    `test -L '${node.generatedConfigPath}' || { echo 'Birdbox 生成配置不是符号链接：${node.generatedConfigPath}' >&2; exit 1; }`,
    `awk -v target='${node.generatedConfigPath}' '${ACTIVE_BIRD_INCLUDE_AWK}' '${node.mainConfigPath}' || { echo 'BIRD 主配置缺少活动 Include：${node.generatedConfigPath}' >&2; exit 1; }`,
    `birdc -s '${node.socketPath}' 'show status' || { echo 'SSH 用户无法访问 BIRD 控制 Socket：${node.socketPath}' >&2; exit 1; }`,
    "printf '\n---BIRDBOX-ACCESS---\n'",
    "id -un",
    "id -Gn",
  ].join("\n");
  return runOnNode(node, command, { timeout: 12_000 });
}

export async function inspectProtocolRoutes(
  nodeInput: unknown,
  protocolNameInput: unknown,
  family: AddressFamily,
  direction: "import" | "export",
  options: RouteInspectionOptions = {},
): Promise<RouteInspectionResult> {
  const node = normalizeNode(nodeInput);
  const protocolName = normalizeId(protocolNameInput, "BGP 协议名称");
  assertValidation(family === "ipv4" || family === "ipv6", "路由地址族不合法");
  assertValidation(direction === "import" || direction === "export", "路由方向不合法");
  const limit = options.limit ?? 200;
  assertValidation(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, "路由明细数量限制不合法");
  const table = normalizeOptionalName(options.table, "Channel 路由表名称") ?? (family === "ipv4" ? "master4" : "master6");
  const routeSelector = direction === "import" ? `protocol ${protocolName}` : `export ${protocolName}`;
  const query = `show route table ${table} ${routeSelector} all`;
  const command = `
status_file=$(mktemp)
filter_status_file=$(mktemp)
cleanup_route_query() { rm -f "$status_file" "$filter_status_file"; }
trap cleanup_route_query EXIT HUP INT TERM
output=$(
  (birdc -s '${node.socketPath}' '${query}' 2>&1; printf '%s' "$?" > "$status_file") |
  (
    awk -v limit='${limit}' '
      /^[[:space:]]*[[:xdigit:].:]+\\/[0-9]+[[:space:]]/ {
        route_count += 1
        if (route_count > limit) {
          print "---BIRDBOX-ROUTE-TRUNCATED---"
          exit
        }
      }
      { print }
    '
    printf '%s' "$?" > "$filter_status_file"
  )
)
status=$(cat "$status_file" 2>/dev/null || printf '1')
filter_status=$(cat "$filter_status_file" 2>/dev/null || printf '1')
cleanup_route_query
trap - EXIT HUP INT TERM
printf '%s\n' "$output"
if [ "$filter_status" -ne 0 ]; then
  exit "$filter_status"
fi
if [ "$status" -ne 0 ] && ! printf '%s\n' "$output" | grep -q '^---BIRDBOX-ROUTE-TRUNCATED---$'; then
  exit "$status"
fi
`.trim();
  const result = await runOnNode(node, command, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  return {
    ok: result.ok,
    ...parseRouteDetails(result.stdout, family, limit),
    error: result.ok ? null : (result.stderr || result.stdout || "无法读取 BIRD 路由明细"),
  };
}

export async function stageAndValidate(nodeInput: unknown, config: string): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  if (node.deploymentMode === "include") {
    const activePath = node.generatedConfigPath;
    const directory = path.posix.dirname(activePath);
    const basename = path.posix.basename(activePath);
    const versionName = `${basename}.${createHash("sha256").update(config).digest("hex").slice(0, 16)}.conf`;
    const versionPath = `${directory}/versions/${versionName}`;
    const candidateTarget = `versions/${versionName}`;
    const candidateLink = `${activePath}.candidate`;
    const switchLink = `${activePath}.switch`;
    const command = [
      "set -eu",
      "umask 0077",
      `test -S '${node.socketPath}'`,
      `test -L '${activePath}'`,
      `test -w '${directory}'`,
      `bird_group=$(stat -c '%G' '${node.socketPath}')`,
      `test -n "$bird_group" && test "$bird_group" != UNKNOWN`,
      `install -d -m 0750 '${directory}/versions'`,
      `chgrp "$bird_group" '${directory}/versions'`,
      `chmod 0750 '${directory}/versions'`,
      `current_target=$(readlink '${activePath}')`,
      `current_file=$(readlink -f '${activePath}')`,
      "test -n \"$current_target\"",
      "test -n \"$current_file\"",
      `cleanup_staged_versions() { for file in '${directory}/versions/'${basename}.*.conf '${directory}/versions/'${basename}.*.conf.tmp; do [ -e "$file" ] || continue; file_target=$(readlink -f "$file"); if [ "$file_target" != "$current_file" ]; then rm -f -- "$file"; fi; done; }`,
      "cleanup_staged_versions",
      `cat > '${versionPath}.tmp'`,
      `chgrp "$bird_group" '${versionPath}.tmp'`,
      `chmod 0640 '${versionPath}.tmp'`,
      `mv -f '${versionPath}.tmp' '${versionPath}'`,
      `ln -sfn '${candidateTarget}' '${candidateLink}'`,
      `restore_active() { ln -sfn "$current_target" '${switchLink}'; mv -f '${switchLink}' '${activePath}'; }`,
      "trap restore_active EXIT HUP INT TERM",
      `ln -sfn '${candidateTarget}' '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${node.socketPath}' 'configure check'`,
    ].join("\n");
    return runOnNode(node, command, { timeout: 15_000, input: config });
  }
  const command = [
    "set -eu",
    "umask 0077",
    `install -d -o bird -g bird -m 0750 '${RUNTIME.baseDir}'`,
    `cat > '${RUNTIME.configPath}.candidate'`,
    `chown bird:bird '${RUNTIME.configPath}.candidate'`,
    `chmod 0640 '${RUNTIME.configPath}.candidate'`,
    `bird -p -c '${RUNTIME.configPath}.candidate'`,
  ].join("\n");
  return runOnNode(node, command, { timeout: 15_000, input: config });
}

export async function applyStagedConfig(nodeInput: unknown): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  if (node.deploymentMode === "include") {
    const activePath = node.generatedConfigPath;
    const directory = path.posix.dirname(activePath);
    const basename = path.posix.basename(activePath);
    const candidateLink = `${activePath}.candidate`;
    const rollbackLink = `${activePath}.rollback`;
    const switchLink = `${activePath}.switch`;
    const command = [
      "set -eu",
      `test -L '${activePath}'`,
      `test -L '${candidateLink}'`,
      `current_target=$(readlink '${activePath}')`,
      `candidate_target=$(readlink '${candidateLink}')`,
      `current_file=$(readlink -f '${activePath}')`,
      `candidate_file=$(readlink -f '${candidateLink}')`,
      "test -n \"$current_target\"",
      "test -n \"$candidate_target\"",
      "test -n \"$current_file\"",
      "test -n \"$candidate_file\"",
      `ln -sfn "$current_target" '${rollbackLink}'`,
      `ln -sfn "$candidate_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `cleanup_versions() { for file in '${directory}/versions/'${basename}.*.conf '${directory}/versions/'${basename}.*.conf.tmp; do [ -e "$file" ] || continue; file_target=$(readlink -f "$file"); if [ "$file_target" != "$candidate_file" ] && [ "$file_target" != "$current_file" ]; then rm -f -- "$file"; fi; done; }`,
      `if birdc -s '${node.socketPath}' 'configure check' && birdc -s '${node.socketPath}' configure; then cleanup_versions || true; exit 0; fi`,
      `ln -sfn "$current_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${node.socketPath}' configure >/dev/null 2>&1 || true`,
      "exit 1",
    ].join("\n");
    return runOnNode(node, command, { timeout: 20_000 });
  }
  const command = [
    `test -f '${RUNTIME.configPath}.candidate'`,
    `if [ -f '${RUNTIME.configPath}' ]; then cp -a '${RUNTIME.configPath}' '${RUNTIME.configPath}.rollback'; else rm -f '${RUNTIME.configPath}.rollback'; fi`,
    `mv -f '${RUNTIME.configPath}.candidate' '${RUNTIME.configPath}'`,
    `chown bird:bird '${RUNTIME.configPath}' && chmod 0640 '${RUNTIME.configPath}'`,
    `if [ -S '${RUNTIME.socketPath}' ] && birdc -s '${RUNTIME.socketPath}' 'show status' >/dev/null 2>&1; then birdc -s '${RUNTIME.socketPath}' configure; else rm -f '${RUNTIME.socketPath}' '${RUNTIME.pidPath}'; bird -c '${RUNTIME.configPath}' -s '${RUNTIME.socketPath}' -P '${RUNTIME.pidPath}' -u bird -g bird; fi`,
  ].join(" && ");
  return runOnNode(node, command, { timeout: 20_000 });
}

export async function rollbackNode(nodeInput: unknown): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  if (node.deploymentMode === "include") {
    const activePath = node.generatedConfigPath;
    const rollbackLink = `${activePath}.rollback`;
    const switchLink = `${activePath}.switch`;
    const command = [
      "set -eu",
      `test -L '${activePath}'`,
      `test -L '${rollbackLink}'`,
      `current_target=$(readlink '${activePath}')`,
      `rollback_target=$(readlink '${rollbackLink}')`,
      `ln -sfn "$rollback_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `if birdc -s '${node.socketPath}' 'configure check' && birdc -s '${node.socketPath}' configure; then ln -sfn "$current_target" '${rollbackLink}'; exit 0; fi`,
      `ln -sfn "$current_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${node.socketPath}' configure >/dev/null 2>&1 || true`,
      "exit 1",
    ].join("\n");
    return runOnNode(node, command, { timeout: 20_000 });
  }
  const command = `if [ -f '${RUNTIME.configPath}.rollback' ]; then cp -a '${RUNTIME.configPath}.rollback' '${RUNTIME.configPath}'; bird -p -c '${RUNTIME.configPath}'; if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' configure; else bird -c '${RUNTIME.configPath}' -s '${RUNTIME.socketPath}' -P '${RUNTIME.pidPath}' -u bird -g bird; fi; else if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' down || true; fi; rm -f '${RUNTIME.configPath}'; fi`;
  return runOnNode(node, command, { timeout: 20_000 });
}

export async function setProtocolState(nodeInput: unknown, protocolNameInput: unknown, enabled: boolean): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  const protocolName = normalizeId(protocolNameInput, "BGP 协议名称");
  assertValidation(typeof enabled === "boolean", "BGP 协议状态不合法");
  const command = `${enabled ? "enable" : "disable"} ${protocolName}`;
  return runOnNode(node, `birdc -s '${node.socketPath}' '${command}'`, { timeout: 10_000 });
}

export async function stopProtocol(nodeInput: unknown, protocolName: unknown): Promise<NodeCommandResult> {
  return setProtocolState(nodeInput, protocolName, false);
}

export async function startProtocol(nodeInput: unknown, protocolName: unknown): Promise<NodeCommandResult> {
  return setProtocolState(nodeInput, protocolName, true);
}

export async function loadSeedNodes(nodesPath: string): Promise<ManagedNode[]> {
  const content = await fs.readFile(nodesPath, "utf8");
  const input = JSON.parse(content) as unknown;
  assertValidation(Array.isArray(input), "受管节点配置必须是数组");
  const nodes = input.map(normalizeNode);
  assertValidation(nodes.length >= 1, "至少需要配置一个受管节点");
  return nodes;
}

export async function saveJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}
