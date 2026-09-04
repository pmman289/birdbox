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
import { configBundle, type NodeConfigBundle } from "./config-bundle.js";

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

export interface OspfRuntimeResult {
  reachable: boolean;
  error: string | null;
  v2: { state: string | null; neighbors: number; routes: number | null };
  v3: { state: string | null; neighbors: number; routes: number | null };
  interfaces: string[];
}

interface ExecError extends ExecFileException {
  stdout?: string;
  stderr?: string;
}

const OPENSSH_INFORMATION_LINES = new Set([
  "** WARNING: connection is not using a post-quantum key exchange algorithm.",
  "** This session may be vulnerable to \"store now, decrypt later\" attacks.",
  "** The server may need to be upgraded. See https://openssh.com/pq.html",
]);

// OpenWrt BusyBox images may omit the stat applet. Keep ownership discovery
// numeric so resource deployment can still use chgrp with the socket GID.
const REMOTE_FILE_GID_HELPER = `
file_gid() {
  if command -v stat >/dev/null 2>&1; then
    stat -c '%g' "$1"
  else
    LC_ALL=C ls -ldn "$1" | awk 'NR == 1 { print $4; exit }'
  fi
}
`.trim();

let managedSshConfiguration: ManagedSshConfiguration = { identityFile: null, knownHostsFile: null };

function commandStderr(node: ManagedNode, value: unknown): string {
  const stderr = String(value ?? "").replace(/\r\n/g, "\n");
  if (node.transport !== "ssh") return stderr.trim();
  return stderr
    .split("\n")
    .filter((line) => !OPENSSH_INFORMATION_LINES.has(line))
    .filter((line) => !/^Warning: Permanently added .+ to the list of known hosts\.$/.test(line))
    .join("\n")
    .trim();
}

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
    return { ok: true, stdout: result.stdout.trim(), stderr: commandStderr(node, result.stderr) };
  } catch (error) {
    const execError = error as ExecError;
    return {
      ok: false,
      stdout: String(execError.stdout ?? "").trim(),
      stderr: commandStderr(node, execError.stderr ?? execError.message ?? "命令执行失败"),
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

export function parseOspfSectionByTable(raw: string, protocolName: string): { state: string | null; neighbors: number } {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${protocolName}:`);
  if (start < 0) return { state: null, neighbors: 0 };
  const rows: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\S.*:\s*$/.test(line)) break;
    rows.push(line);
  }
  const states = rows
    .map((line) => line.trim().match(/^\S+\s+\d+\s+(\S+)/)?.[1] ?? "")
    .filter(Boolean);
  const full = states.filter((value) => value.toLowerCase().startsWith("full")).length;
  return { state: states[0] ?? null, neighbors: full || states.length };
}

function parseOspfSection(raw: string, protocolName: string): { state: string | null; neighbors: number } {
  const escaped = protocolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = raw.match(new RegExp(`(?:^|\\n)${escaped}:\\s*\\n([\\s\\S]*?)(?=\\n[^\\s].*:\\s*$|$)`, "m"))?.[1] ?? "";
  const states = [...section.matchAll(/^\s*\S+\s+\d+\s+([^\s]+(?:\/[^\s]+)?)/gm)].map((match) => match[1] ?? "");
  const full = states.filter((value) => value.toLowerCase().startsWith("full")).length;
  return { state: states[0] ?? null, neighbors: full || states.length };
}

function parseOspfRouteCount(raw: string): number | null {
  const match = raw.match(/^(\d+)\s+of\s+\d+\s+routes\s+for\s+\d+\s+networks?/im);
  return match?.[1] ? Number(match[1]) : null;
}

export async function inspectOspfRuntime(nodeInput: unknown, protocolNames: { v2: string; v3: string }): Promise<OspfRuntimeResult> {
  const node = normalizeNode(nodeInput);
  const v2 = normalizeId(protocolNames.v2, "OSPFv2 协议名称");
  const v3 = normalizeId(protocolNames.v3, "OSPFv3 协议名称");
  const command = [
    `neighbors=$(birdc -s '${node.socketPath}' 'show ospf neighbors' 2>&1 || true)`,
    `v2routes=$(birdc -s '${node.socketPath}' 'show route protocol ${v2} count' 2>&1 || true)`,
    `v3routes=$(birdc -s '${node.socketPath}' 'show route protocol ${v3} count' 2>&1 || true)`,
    "interfaces=$(ip -o link show 2>/dev/null | sed -n 's/^[0-9]*: \\([^:@]*\\).*$/\\1/p' | paste -sd '\\n' -)",
    "printf '%s\\n---BIRDBOX-OSPF-V2-ROUTES---\\n%s\\n---BIRDBOX-OSPF-V3-ROUTES---\\n%s\\n---BIRDBOX-OSPF-INTERFACES---\\n%s\\n' \"$neighbors\" \"$v2routes\" \"$v3routes\" \"$interfaces\"",
  ].join("\n");
  const result = await runOnNode(node, command, { timeout: 15_000 });
  const [neighbors = "", v2routes = "", v3routes = "", interfaces = ""] = result.stdout.split(/---BIRDBOX-OSPF-(?:V2-ROUTES|V3-ROUTES|INTERFACES)---/);
  return {
    reachable: result.ok,
    error: result.ok ? null : (result.stderr || "节点不可达"),
    v2: { ...parseOspfSectionByTable(neighbors, v2), routes: parseOspfRouteCount(v2routes) },
    v3: { ...parseOspfSectionByTable(neighbors, v3), routes: parseOspfRouteCount(v3routes) },
    interfaces: interfaces.split(/\r?\n/).map((item) => item.trim()).filter((item) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item)),
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

function validateBundle(bundleInput: string | NodeConfigBundle): NodeConfigBundle {
  const bundle = configBundle(bundleInput);
  const seen = new Set<string>();
  for (const resource of bundle.resources) {
    assertValidation(/^define_[A-Za-z_][A-Za-z0-9_]*\.conf$/.test(resource.relativePath), "资源片段路径不合法");
    assertValidation(!seen.has(resource.relativePath), "资源片段路径重复");
    seen.add(resource.relativePath);
  }
  for (const relativePath of bundle.removedResources ?? []) {
    assertValidation(/^define_[A-Za-z_][A-Za-z0-9_]*\.conf$/.test(relativePath), "待删除资源片段路径不合法");
    assertValidation(!seen.has(relativePath), "资源片段不能同时更新和删除");
    seen.add(relativePath);
  }
  return bundle;
}

async function stageResourceFiles(node: ManagedNode, bundle: NodeConfigBundle, baseDirectory: string): Promise<NodeCommandResult> {
  for (const resource of bundle.resources) {
    const activePath = `${baseDirectory}/resources/${resource.relativePath}`;
    const resourceDirectory = `${baseDirectory}/resources`;
    const versionDirectory = `${resourceDirectory}/versions`;
    const hash = createHash("sha256").update(resource.content).digest("hex").slice(0, 16);
    const versionName = `${resource.relativePath.replace(/\.conf$/, "")}.${hash}.conf`;
    const versionPath = `${versionDirectory}/${versionName}`;
    const result = await runOnNode(node, [
      "set -eu", "umask 0077",
      REMOTE_FILE_GID_HELPER,
      `if [ -S '${node.socketPath}' ]; then bird_group=$(file_gid '${node.socketPath}'); else bird_group=$(id -g bird); fi`,
      `mkdir -p '${versionDirectory}'`,
      `chgrp "$bird_group" '${resourceDirectory}' '${versionDirectory}'`,
      `chmod 0750 '${resourceDirectory}' '${versionDirectory}'`,
      `current_file=$(readlink -f '${activePath}' 2>/dev/null || true)`,
      `candidate_file=$(readlink -f '${activePath}.candidate' 2>/dev/null || true)`,
      `for file in '${versionDirectory}/${resource.relativePath.replace(/\.conf$/, "")}.'*.conf '${versionDirectory}/${resource.relativePath.replace(/\.conf$/, "")}.'*.conf.tmp; do [ -e "$file" ] || continue; file_target=$(readlink -f "$file"); if [ "$file_target" != "$current_file" ] && [ "$file_target" != "$candidate_file" ]; then rm -f -- "$file"; fi; done`,
      `cat > '${versionPath}.tmp'`,
      `chgrp "$bird_group" '${versionPath}.tmp'`, `chmod 0640 '${versionPath}.tmp'`,
      `mv -f '${versionPath}.tmp' '${versionPath}'`,
      `ln -sfn 'versions/${versionName}' '${activePath}.candidate'`,
    ].join("\n"), { timeout: 15_000, input: resource.content });
    if (!result.ok) return result;
  }
  return { ok: true, stdout: "", stderr: "" };
}

function resourceSwitchCommands(bundle: NodeConfigBundle, baseDirectory: string, mode: "check" | "apply"): string[] {
  return bundle.resources.flatMap((resource) => {
    const active = `${baseDirectory}/resources/${resource.relativePath}`;
    const candidate = `${active}.candidate`;
    const rollback = `${active}.rollback`;
    const swap = `${active}.switch`;
    if (mode === "check") return [
      `if [ -L '${active}' ]; then old_target=$(readlink '${active}'); else old_target=''; fi`,
      `new_target=$(readlink '${candidate}')`,
      `ln -sfn "$new_target" '${swap}'`, `mv -f '${swap}' '${active}'`,
      `resource_restore_commands="$resource_restore_commands if [ -n '$old_target' ]; then ln -sfn '$old_target' '${swap}'; mv -f '${swap}' '${active}'; else rm -f '${active}'; fi;"`,
    ];
    return [
      `if [ -L '${active}' ]; then old_target=$(readlink '${active}'); ln -sfn "$old_target" '${rollback}'; else rm -f '${rollback}'; fi`,
      `new_target=$(readlink '${candidate}')`, `ln -sfn "$new_target" '${swap}'`, `mv -f '${swap}' '${active}'`,
    ];
  });
}

function resourceRollbackCommands(bundle: NodeConfigBundle, baseDirectory: string): string[] {
  return [...bundle.resources.map((resource) => resource.relativePath), ...(bundle.removedResources ?? [])].flatMap((relativePath) => {
    const active = `${baseDirectory}/resources/${relativePath}`;
    const rollback = `${active}.rollback`;
    const swap = `${active}.switch`;
    return [`if [ -L '${rollback}' ]; then target=$(readlink '${rollback}'); ln -sfn "$target" '${swap}'; mv -f '${swap}' '${active}'; else rm -f '${active}'; fi`];
  });
}

function resourceRemovalCommands(bundle: NodeConfigBundle, baseDirectory: string): string[] {
  return (bundle.removedResources ?? []).flatMap((relativePath) => {
    const active = `${baseDirectory}/resources/${relativePath}`;
    const rollback = `${active}.rollback`;
    return [`if [ -L '${active}' ]; then old_target=$(readlink '${active}'); ln -sfn "$old_target" '${rollback}'; rm -f '${active}'; else rm -f '${rollback}'; fi`];
  });
}

export async function stageAndValidate(nodeInput: unknown, bundleInput: string | NodeConfigBundle): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  const bundle = validateBundle(bundleInput);
  const config = bundle.main;
  if (node.deploymentMode === "include") {
    const activePath = node.generatedConfigPath;
    const directory = path.posix.dirname(activePath);
    const basename = path.posix.basename(activePath);
    const versionName = `${basename}.${createHash("sha256").update(config).digest("hex").slice(0, 16)}.conf`;
    const versionPath = `${directory}/versions/${versionName}`;
    const candidateTarget = `versions/${versionName}`;
    const candidateLink = `${activePath}.candidate`;
    const switchLink = `${activePath}.switch`;
    const stagedResources = await stageResourceFiles(node, bundle, directory);
    if (!stagedResources.ok) return stagedResources;
    const command = [
      "set -eu",
      "umask 0077",
      `test -S '${node.socketPath}'`,
      `test -L '${activePath}'`,
      `test -w '${directory}'`,
      REMOTE_FILE_GID_HELPER,
      `bird_group=$(file_gid '${node.socketPath}')`,
      `test -n "$bird_group" && test "$bird_group" != 0`,
      `mkdir -p '${directory}/versions'`,
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
      "resource_restore_commands=''",
      ...resourceSwitchCommands(bundle, directory, "check"),
      `restore_active() { eval "$resource_restore_commands"; ln -sfn "$current_target" '${switchLink}'; mv -f '${switchLink}' '${activePath}'; }`,
      "trap restore_active EXIT HUP INT TERM",
      `ln -sfn '${candidateTarget}' '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${node.socketPath}' 'configure check'`,
    ].join("\n");
    return runOnNode(node, command, { timeout: 15_000, input: config });
  }
  const stagedResources = await stageResourceFiles(node, bundle, RUNTIME.baseDir);
  if (!stagedResources.ok) return stagedResources;
  const command = [
    "set -eu",
    "umask 0077",
    `install -d -o bird -g bird -m 0750 '${RUNTIME.baseDir}'`,
    `cat > '${RUNTIME.configPath}.candidate'`,
    `chown bird:bird '${RUNTIME.configPath}.candidate'`,
    `chmod 0640 '${RUNTIME.configPath}.candidate'`,
    "resource_restore_commands=''",
    ...resourceSwitchCommands(bundle, RUNTIME.baseDir, "check"),
    `restore_resources() { eval "$resource_restore_commands"; }`,
    "trap restore_resources EXIT HUP INT TERM",
    `bird -p -c '${RUNTIME.configPath}.candidate'`,
  ].join("\n");
  return runOnNode(node, command, { timeout: 15_000, input: config });
}

export async function applyStagedConfig(nodeInput: unknown, bundleInput: string | NodeConfigBundle = ""): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  const bundle = validateBundle(bundleInput);
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
      ...resourceSwitchCommands(bundle, directory, "apply"),
      ...resourceRemovalCommands(bundle, directory),
      `ln -sfn "$current_target" '${rollbackLink}'`,
      `ln -sfn "$candidate_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `cleanup_versions() { for file in '${directory}/versions/'${basename}.*.conf '${directory}/versions/'${basename}.*.conf.tmp; do [ -e "$file" ] || continue; file_target=$(readlink -f "$file"); if [ "$file_target" != "$candidate_file" ] && [ "$file_target" != "$current_file" ]; then rm -f -- "$file"; fi; done; }`,
      `if birdc -s '${node.socketPath}' 'configure check' && birdc -s '${node.socketPath}' configure; then cleanup_versions || true; exit 0; fi`,
      ...resourceRollbackCommands(bundle, directory),
      `ln -sfn "$current_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${node.socketPath}' configure >/dev/null 2>&1 || true`,
      "exit 1",
    ].join("\n");
    return runOnNode(node, command, { timeout: 20_000 });
  }
  const command = [
    "set -eu",
    ...resourceSwitchCommands(bundle, RUNTIME.baseDir, "apply"),
    ...resourceRemovalCommands(bundle, RUNTIME.baseDir),
    `test -f '${RUNTIME.configPath}.candidate'`,
    `if [ -f '${RUNTIME.configPath}' ]; then cp -a '${RUNTIME.configPath}' '${RUNTIME.configPath}.rollback'; else rm -f '${RUNTIME.configPath}.rollback'; fi`,
    `mv -f '${RUNTIME.configPath}.candidate' '${RUNTIME.configPath}'`,
    `chown bird:bird '${RUNTIME.configPath}' && chmod 0640 '${RUNTIME.configPath}'`,
    `if [ -S '${RUNTIME.socketPath}' ] && birdc -s '${RUNTIME.socketPath}' 'show status' >/dev/null 2>&1; then status=0; birdc -s '${RUNTIME.socketPath}' configure || status=$?; else rm -f '${RUNTIME.socketPath}' '${RUNTIME.pidPath}'; status=0; bird -c '${RUNTIME.configPath}' -s '${RUNTIME.socketPath}' -P '${RUNTIME.pidPath}' -u bird -g bird || status=$?; fi`,
    "if [ \"$status\" -eq 0 ]; then exit 0; fi",
    ...resourceRollbackCommands(bundle, RUNTIME.baseDir),
    `if [ -f '${RUNTIME.configPath}.rollback' ]; then cp -a '${RUNTIME.configPath}.rollback' '${RUNTIME.configPath}'; if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' configure >/dev/null 2>&1 || true; fi; else rm -f '${RUNTIME.configPath}'; fi`,
    "exit 1",
  ].join("\n");
  return runOnNode(node, command, { timeout: 20_000 });
}

export async function rollbackNode(nodeInput: unknown, bundleInput: string | NodeConfigBundle = ""): Promise<NodeCommandResult> {
  const node = normalizeNode(nodeInput);
  const bundle = validateBundle(bundleInput);
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
      ...resourceRollbackCommands(bundle, path.posix.dirname(activePath)),
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
  const command = [...resourceRollbackCommands(bundle, RUNTIME.baseDir), `if [ -f '${RUNTIME.configPath}.rollback' ]; then cp -a '${RUNTIME.configPath}.rollback' '${RUNTIME.configPath}'; bird -p -c '${RUNTIME.configPath}'; if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' configure; else bird -c '${RUNTIME.configPath}' -s '${RUNTIME.socketPath}' -P '${RUNTIME.pidPath}' -u bird -g bird; fi; else if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' down || true; fi; rm -f '${RUNTIME.configPath}'; fi`].join("\n");
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
  return input.map(normalizeNode);
}

export async function saveJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}
