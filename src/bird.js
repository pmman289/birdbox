import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUNTIME = Object.freeze({
  baseDir: process.env.BIRDBOX_RUNTIME_DIR ?? "/var/lib/birdbox-demo",
  configPath: `${process.env.BIRDBOX_RUNTIME_DIR ?? "/var/lib/birdbox-demo"}/bird.conf`,
  socketPath: process.env.BIRDBOX_SOCKET_PATH ?? "/run/bird/birdbox-demo.ctl",
  pidPath: process.env.BIRDBOX_PID_PATH ?? "/run/bird/birdbox-demo.pid",
  defaultBgpPort: 179,
});

let managedSshConfiguration = { identityFile: null, knownHostsFile: null };

export function configureManagedSsh({ identityFile, knownHostsFile }) {
  managedSshConfiguration = {
    identityFile: path.resolve(identityFile),
    knownHostsFile: path.resolve(knownHostsFile),
  };
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9_.:@-]{1,253}$/;
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const ABSOLUTE_PATH_RE = /^\/[A-Za-z0-9_./-]{1,254}$/;
const DEPLOYMENT_MODES = new Set(["legacy", "include"]);
const SSH_IDENTITY_MODES = new Set(["default", "managed"]);
const PREFIX_PATTERN_RE = /^(.+)\/(\d{1,3})(?:(\+|-)|\{(\d{1,3}),(\d{1,3})\})?$/;
const RESERVED_PROTOCOL_NAMES = new Set(["birdbox_device", "birdbox_static", "birdbox_static4", "birdbox_static6", "birdbox_bfd"]);
const STATIC_ROUTE_ACTIONS = new Set(["blackhole", "reject", "unreachable", "prohibit"]);
const STATIC_CHANNEL_POLICIES = new Set(["all", "none"]);
const POLICY_MODES = new Set(["form", "combined", "custom"]);
const FUNCTION_STEP_ACTIONS = new Set(["accept", "reject", "execute"]);
const SWITCH_SETTINGS = new Set(["default", "on", "off"]);
const GRACEFUL_RESTART_MODES = new Set(["default", "off", "aware", "on"]);
const BFD_MODES = new Set(["off", "on", "graceful", "custom"]);
const NEXT_HOP_MODES = new Set(["default", "off", "on", "ibgp", "ebgp"]);
const NEXT_HOP_PREFER_MODES = new Set(["default", "global", "local"]);
const LINK_LOCAL_NEXT_HOP_FORMATS = new Set(["default", "native", "single", "double"]);
const BGP_AUTHENTICATION_MODES = new Set(["none", "md5", "ao"]);
const LIMIT_ACTIONS = new Set(["warn", "block", "restart", "disable"]);
const LOCAL_ROLES = new Set(["", "provider", "rs_server", "rs_client", "customer", "peer"]);
const RPKI_SOURCE_TYPES = new Set(["file", "server"]);
const RPKI_TRANSPORTS = new Set(["tcp", "ssh"]);
const RPKI_TCP_AUTHENTICATION = new Set(["none", "md5"]);
const RPKI_SWITCH_SETTINGS = new Set(["default", "on", "off"]);
const MAX_POLICY_SOURCE_LENGTH = 32 * 1024;
const MAX_GRACEFUL_RESTART_TIME = 4095;
const MAX_LONG_LIVED_STALE_TIME = 16777215;

export function makeStaticProtocolName(family, protocolName) {
  const fullName = `birdbox_static${family === "ipv4" ? "4" : "6"}_${protocolName}`;
  if (fullName.length <= 64) return fullName;
  const digest = createHash("sha256").update(fullName).digest("hex").slice(0, 10);
  return `${fullName.slice(0, 64 - digest.length - 1)}_${digest}`;
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

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
}

function normalizeId(value, label) {
  const id = String(value ?? "").trim();
  assert(NAME_RE.test(id), `${label}不合法`);
  return id;
}

function normalizeLabel(value, label) {
  const text = String(value ?? "").trim();
  assert(text.length >= 1 && text.length <= 80, `${label}长度应为 1 到 80 个字符`);
  assert(!/[\u0000-\u001f\u007f]/.test(text), `${label}不能包含控制字符`);
  return text;
}

function normalizeAsn(value, label) {
  const asn = Number(value);
  assert(Number.isInteger(asn) && asn >= 1 && asn <= 4294967295, `${label}超出范围`);
  return asn;
}

function normalizePort(value, label, fallback) {
  const port = Number(value ?? fallback);
  assert(Number.isInteger(port) && port >= 1 && port <= 65535, `${label}超出范围`);
  return port;
}

function normalizeOptionalInteger(value, label, minimum = 0, maximum = 4294967295) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  assert(Number.isInteger(number) && number >= minimum && number <= maximum, `${label}超出范围`);
  return number;
}

function normalizeOptionalString(value, label, maximum = 255) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).replaceAll("\r\n", "\n").trim();
  assert(text.length >= 1 && text.length <= maximum, `${label}长度应为 1 到 ${maximum} 个字符`);
  assert(!/[\u0000-\u001f\u007f]/.test(text), `${label}不能包含控制字符`);
  return text;
}

function normalizeAbsolutePath(value, label, fallback) {
  const normalized = path.posix.normalize(String(value ?? fallback).trim());
  assert(ABSOLUTE_PATH_RE.test(normalized) && !normalized.includes("/../"), `${label}必须是安全的绝对路径`);
  return normalized;
}

function normalizeEnum(value, allowed, fallback, label) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  assert(allowed.has(normalized), `${label}不合法`);
  return normalized;
}

function normalizeOptionalName(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeId(value, label);
}

function normalizeRPKIPath(value, label) {
  const path = normalizeOptionalString(value, label, 512);
  if (path === null) return null;
  assert(path.startsWith("/"), `${label}必须使用绝对路径`);
  return path;
}

function normalizeRPKIRemote(value) {
  const remote = normalizeOptionalString(value, "RPKI 服务器", 253);
  assert(remote !== null, "RPKI 服务器不能为空");
  assert(!remote.includes("/") && !remote.includes("\\") && !remote.includes("\""), "RPKI 服务器地址不合法");
  assert(net.isIP(remote) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(remote), "RPKI 服务器地址不合法");
  return remote;
}

function normalizeRPKISource(input) {
  assert(input && typeof input === "object", "RPKI 资源参数不能为空");
  const sourceType = normalizeEnum(input.sourceType ?? input.kind, RPKI_SOURCE_TYPES, "file", "RPKI 来源类型");
  const roa4Table = normalizeOptionalName(input.roa4Table ?? input.table4, "IPv4 ROA Table");
  const roa6Table = normalizeOptionalName(input.roa6Table ?? input.table6, "IPv6 ROA Table");
  assert(roa4Table !== null || roa6Table !== null, "RPKI 至少需要启用一个 ROA Table");
  assert(roa4Table === null || roa4Table !== roa6Table, "IPv4 与 IPv6 ROA Table 名称必须不同");
  const base = {
    id: normalizeId(input.id, "RPKI 资源 ID"),
    nodeId: normalizeResourceScope(input.nodeId),
    label: normalizeLabel(input.label ?? input.name, "RPKI 资源名称"),
    name: normalizeId(input.name, "RPKI 协议名称"),
    sourceType,
    roa4Table,
    roa6Table,
    enabled: input.enabled !== false,
  };
  assert(sourceType !== "file" || base.name.length <= 60, "本地 ROA 资源名称最多 60 个字符");
  if (sourceType === "file") {
    const file4 = normalizeRPKIPath(input.file4 ?? input.roa4File, "IPv4 ROA 文件");
    const file6 = normalizeRPKIPath(input.file6 ?? input.roa6File, "IPv6 ROA 文件");
    assert(roa4Table === null || file4 !== null, "启用 IPv4 ROA Table 时必须填写 IPv4 ROA 文件");
    assert(roa6Table === null || file6 !== null, "启用 IPv6 ROA Table 时必须填写 IPv6 ROA 文件");
    assert(file4 === null || roa4Table !== null, "填写 IPv4 ROA 文件时必须启用 IPv4 ROA Table");
    assert(file6 === null || roa6Table !== null, "填写 IPv6 ROA 文件时必须启用 IPv6 ROA Table");
    return { ...base, file4, file6 };
  }
  const transport = normalizeEnum(input.transport, RPKI_TRANSPORTS, "tcp", "RPKI 传输方式");
  const port = normalizePort(input.port, "RPKI 服务器端口", transport === "ssh" ? 22 : 323);
  const localAddress = input.localAddress === null || input.localAddress === undefined || input.localAddress === ""
    ? null
    : normalizeIPAddress(input.localAddress, "RPKI 本地地址");
  const refresh = normalizeOptionalInteger(input.refresh, "RPKI Refresh", 1, 86400);
  const retry = normalizeOptionalInteger(input.retry, "RPKI Retry", 1, 7200);
  const expire = normalizeOptionalInteger(input.expire, "RPKI Expire", 600, 172800);
  const minVersion = normalizeOptionalInteger(input.minVersion, "RPKI 最低版本", 0, 2);
  const maxVersion = normalizeOptionalInteger(input.maxVersion, "RPKI 最高版本", 0, 2);
  assert(minVersion === null || maxVersion === null || minVersion <= maxVersion, "RPKI 版本范围必须从小到大");
  const ignoreMaxLength = normalizeEnum(input.ignoreMaxLength, RPKI_SWITCH_SETTINGS, "default", "RPKI Max Length 设置");
  const authentication = normalizeEnum(input.authentication, RPKI_TCP_AUTHENTICATION, "none", "RPKI TCP 认证方式");
  const password = normalizeOptionalString(input.password, "RPKI TCP-MD5 密码", 80);
  assert(transport === "tcp" || authentication === "none", "SSH 传输不能配置 TCP-MD5");
  assert(authentication !== "md5" || password !== null, "RPKI TCP-MD5 必须填写密码");
  assert(authentication === "md5" || password === null, "只有 RPKI TCP-MD5 可以填写密码");
  const birdPrivateKey = normalizeRPKIPath(input.birdPrivateKey, "RPKI SSH 私钥");
  const remotePublicKey = normalizeRPKIPath(input.remotePublicKey, "RPKI SSH 公钥");
  const user = normalizeOptionalString(input.user, "RPKI SSH 用户名", 80);
  assert(transport !== "ssh" || (birdPrivateKey !== null && remotePublicKey !== null && user !== null), "RPKI SSH 必须填写私钥、公钥和用户名");
  assert(transport !== "tcp" || (birdPrivateKey === null && remotePublicKey === null && user === null), "TCP 传输不能填写 SSH 参数");
  return {
    ...base,
    remote: normalizeRPKIRemote(input.remote),
    port,
    localAddress,
    refresh,
    keepRefresh: input.keepRefresh === true,
    retry,
    keepRetry: input.keepRetry === true,
    expire,
    keepExpire: input.keepExpire === true,
    ignoreMaxLength,
    minVersion,
    maxVersion,
    transport,
    authentication,
    password: authentication === "md5" ? password : null,
    birdPrivateKey,
    remotePublicKey,
    user,
  };
}

export function normalizeRPKI(input) {
  return normalizeRPKISource(input);
}

function normalizeLimit(input, label) {
  const value = normalizeOptionalInteger(input?.value, `${label}数量`, 1);
  return {
    value,
    action: normalizeEnum(input?.action, LIMIT_ACTIONS, "disable", `${label}动作`),
  };
}

function normalizeBirdBlockSource(value, label) {
  const source = String(value ?? "").replaceAll("\r\n", "\n").trim();
  assert(source.length <= MAX_POLICY_SOURCE_LENGTH, `${label}不能超过 32 KiB`);
  assert(!source.includes("\0"), `${label}不能包含空字符`);
  let depth = 0;
  let quote = null;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline < 0 ? source.length : newline;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      assert(end >= 0, `${label}包含未结束的块注释`);
      cursor = end + 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      assert(depth > 0, `${label}不能结束外层配置块`);
      depth -= 1;
    }
  }
  assert(quote === null && depth === 0, `${label}的引号或花括号没有完整结束`);
  return source;
}

function normalizeIPv4(value, label) {
  const address = String(value ?? "").trim();
  assert(net.isIPv4(address), `${label}必须是有效的 IPv4 地址`);
  return address;
}

function splitScopedIPAddress(value) {
  const address = String(value ?? "").trim();
  const zoneIndex = address.lastIndexOf("%");
  if (zoneIndex < 0) return { address, base: address, zone: null };
  const base = address.slice(0, zoneIndex);
  const zone = address.slice(zoneIndex + 1);
  assert(zone.length >= 1 && zone.length <= 80 && /^[A-Za-z0-9_.:@-]+$/.test(zone), "IPv6 Scope 接口不合法");
  return { address, base, zone };
}

function ipFamily(value) {
  return net.isIP(splitScopedIPAddress(value).base);
}

function isLinkLocalIPv6(value) {
  const { base } = splitScopedIPAddress(value);
  if (!net.isIPv6(base)) return false;
  const first = Number.parseInt(base.split(":")[0] || "0", 16);
  return (first & 0xffc0) === 0xfe80;
}

function normalizeIPAddress(value, label, expectedFamily = null) {
  const { address, base, zone } = splitScopedIPAddress(value);
  const family = net.isIP(base);
  assert(family !== 0, `${label}必须是有效的 IP 地址`);
  assert(zone === null || (family === 6 && isLinkLocalIPv6(address)), `${label}只有 IPv6 Link-local 地址可以指定 Scope 接口`);
  assert(expectedFamily === null || family === expectedFamily, `${label}必须是 IPv${expectedFamily} 地址`);
  return address;
}

function prefixFamily(type) {
  return type === "cidr4" ? 4 : type === "cidr6" ? 6 : null;
}

export function normalizeBirdPrefixPattern(value, expectedFamily = null) {
  const pattern = String(value ?? "").replace(/\s+/g, "");
  const match = PREFIX_PATTERN_RE.exec(pattern);
  const family = match ? net.isIP(match[1]) : 0;
  assert(match && family !== 0, `无效的 BIRD IP 前缀模式: ${value}`);
  assert(expectedFamily === null || family === expectedFamily, `CIDR 条目必须是 IPv${expectedFamily}: ${value}`);
  const maximum = family === 4 ? 32 : 128;
  const prefixLength = Number(match[2]);
  assert(prefixLength <= maximum, `前缀长度超出 IPv${family} 范围: ${value}`);
  if (match[4] !== undefined) {
    const low = Number(match[4]);
    const high = Number(match[5]);
    assert(low <= maximum && high <= maximum, `无效的前缀长度范围，超出 IPv${family} 范围: ${value}`);
    assert(low <= high, `前缀长度范围必须从小到大: ${value}`);
  }
  return pattern;
}

export function parseBirdPrefixEntries(value, expectedFamily = null) {
  let entries;
  if (Array.isArray(value)) {
    entries = value.map((item) => normalizeBirdPrefixPattern(item, expectedFamily));
  } else {
    let source = String(value ?? "").trim();
    if (source.startsWith("[") && source.endsWith("]")) source = source.slice(1, -1);
    entries = [];
    let current = "";
    let braceDepth = 0;
    for (const character of source) {
      if (character === "{") braceDepth += 1;
      if (character === "}") braceDepth -= 1;
      if ((character === "," || character === "\n" || character === ";") && braceDepth === 0) {
        if (current.trim()) entries.push(normalizeBirdPrefixPattern(current, expectedFamily));
        current = "";
      } else {
        current += character;
      }
    }
    if (current.trim()) entries.push(normalizeBirdPrefixPattern(current, expectedFamily));
  }
  assert(entries.length >= 1, "CIDR 列表至少需要一个条目");
  assert(entries.length <= 256, "单个 CIDR 列表最多支持 256 个条目");
  assert(new Set(entries).size === entries.length, "CIDR 列表包含重复条目");
  return entries;
}

export function normalizeNode(input) {
  assert(input && typeof input === "object", "节点参数不能为空");
  const transport = input.transport ?? "ssh";
  assert(transport === "local" || transport === "ssh", "节点管理方式不合法");
  const sshHost = transport === "ssh" ? String(input.sshHost ?? "").trim() : null;
  if (transport === "ssh") assert(HOST_RE.test(sshHost) && !sshHost.startsWith("-"), "SSH 目标不合法");
  const deploymentMode = normalizeEnum(input.deploymentMode, DEPLOYMENT_MODES, "legacy", "节点部署模式");
  const sshIdentity = normalizeEnum(input.sshIdentity, SSH_IDENTITY_MODES, deploymentMode === "include" ? "managed" : "default", "SSH 凭据模式");
  const sshUser = transport === "ssh" && input.sshUser !== null && input.sshUser !== undefined && input.sshUser !== ""
    ? String(input.sshUser).trim()
    : null;
  if (sshUser !== null) assert(SSH_USER_RE.test(sshUser), "SSH 用户名不合法");
  if (deploymentMode === "include") {
    assert(transport === "ssh", "Include 节点必须使用 SSH");
    assert(sshUser !== null, "Include 节点必须指定 SSH 用户");
    assert(!sshHost.includes("@"), "Include 节点的主机与 SSH 用户必须分开填写");
    assert(sshIdentity === "managed", "Include 节点必须使用 Birdbox 托管密钥");
  }
  return {
    id: normalizeId(input.id, "节点 ID"),
    kind: "managed-node",
    name: normalizeLabel(input.name, "节点名称"),
    transport,
    sshHost,
    sshPort: transport === "ssh" ? normalizePort(input.sshPort, "SSH 端口", 22) : null,
    sshUser,
    sshIdentity,
    deploymentMode,
    mainConfigPath: normalizeAbsolutePath(input.mainConfigPath, "BIRD 主配置路径", "/etc/bird/bird.conf"),
    generatedConfigPath: normalizeAbsolutePath(
      input.generatedConfigPath,
      "Birdbox 生成配置路径",
      deploymentMode === "include" ? "/var/lib/birdbox/generated.conf" : RUNTIME.configPath,
    ),
    socketPath: normalizeAbsolutePath(
      input.socketPath,
      "BIRD 控制 Socket 路径",
      deploymentMode === "include" ? "/run/bird/bird.ctl" : RUNTIME.socketPath,
    ),
    routerId: normalizeIPv4(input.routerId, "Router ID"),
    listenPort: normalizePort(input.listenPort, "本地监听端口", RUNTIME.defaultBgpPort),
  };
}

export function normalizePeer(input) {
  assert(input && typeof input === "object", "Peer 参数不能为空");
  return {
    id: normalizeId(input.id, "Peer ID"),
    nodeId: normalizeId(input.nodeId, "所属节点 ID"),
    name: normalizeLabel(input.name, "Peer 名称"),
    address: normalizeIPAddress(input.address, "Peer 地址"),
    asn: normalizeAsn(input.asn, "远端 ASN "),
    port: normalizePort(input.port, "远端 BGP 端口", 179),
  };
}

function normalizeDefineValue(input) {
  const value = String(input ?? "").replaceAll("\r\n", "\n").trim();
  assert(value.length >= 1, "Define 表达式不能为空");
  assert(value.length <= MAX_POLICY_SOURCE_LENGTH, "Define 表达式不能超过 32 KiB");
  assert(!value.includes("\0"), "Define 表达式不能包含空字符");
  const pairs = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
  const openings = new Set(pairs.keys());
  const closings = new Set(pairs.values());
  const stack = [];
  let quote = null;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    const next = value[cursor + 1];
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" || (character === "/" && next === "/")) {
      const newline = value.indexOf("\n", cursor + 1);
      cursor = newline < 0 ? value.length : newline - 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = value.indexOf("*/", cursor + 2);
      assert(end >= 0, "Define 表达式包含未结束的块注释");
      cursor = end + 1;
      continue;
    }
    assert(character !== ";", "Define 表达式不能包含额外的顶层语句");
    if (openings.has(character)) stack.push(character);
    if (closings.has(character)) {
      const opening = stack.pop();
      assert(opening && pairs.get(opening) === character, "Define 表达式的括号不匹配");
    }
  }
  assert(quote === null && stack.length === 0, "Define 表达式没有完整结束");
  return value;
}

export function normalizeDefine(input) {
  assert(input && typeof input === "object", "Define 参数不能为空");
  const name = normalizeId(input.name, "BIRD Define 名称");
  assert(!RESERVED_PROTOCOL_NAMES.has(name), "Define 名称与 Birdbox 内部协议冲突");
  const requestedType = String(input.type ?? "expression").trim().toLowerCase();
  const type = requestedType === "cidr" ? "cidr4" : requestedType;
  assert(type === "cidr4" || type === "cidr6" || type === "expression", "Define 类型不合法");
  return {
    id: normalizeId(input.id, "Define ID"),
    nodeId: normalizeResourceScope(input.nodeId),
    label: normalizeLabel(input.label ?? input.name, "Define 显示名称"),
    name,
    type,
    ...(type.startsWith("cidr")
      ? { entries: parseBirdPrefixEntries(input.entries, prefixFamily(type)) }
      : { value: normalizeDefineValue(input.value) }),
    enabled: input.enabled !== false,
  };
}

export function normalizeStaticProtocol(input) {
  assert(input && typeof input === "object", "Static 资源参数不能为空");
  const family = normalizeEnum(input.family, new Set(["ipv4", "ipv6"]), "ipv4", "Static 地址族");
  const defineId = input.defineId === null || input.defineId === undefined || input.defineId === ""
    ? null
    : normalizeId(input.defineId, "Static CIDR Define ID");
  const actionValue = input.action === null || input.action === undefined || input.action === ""
    ? null
    : String(input.action).trim().toLowerCase();
  assert(actionValue === null || STATIC_ROUTE_ACTIONS.has(actionValue), "静态路由动作不合法");
  assert((defineId === null) === (actionValue === null), "Static CIDR Define 与标准动作必须同时设置");
  const raw = normalizeBirdBlockSource(input.raw, "额外 Static 指令");
  assert(actionValue !== null || raw, "Static 资源至少需要标准路由或自定义指令");
  const name = normalizeId(input.name, "Static 协议名称");
  assert(!RESERVED_PROTOCOL_NAMES.has(name), "Static 协议名称与 Birdbox 内部协议冲突");
  return {
    id: normalizeId(input.id, "Static 资源 ID"),
    nodeId: normalizeId(input.nodeId, "Static 所属节点 ID"),
    label: normalizeLabel(input.label ?? input.name, "Static 显示名称"),
    name,
    family,
    defineId,
    action: actionValue,
    import: normalizeEnum(input.import, STATIC_CHANNEL_POLICIES, "all", "Static Import 设置"),
    export: normalizeEnum(input.export, STATIC_CHANNEL_POLICIES, "none", "Static Export 设置"),
    raw,
    enabled: input.enabled !== false,
  };
}

function normalizeResourceScope(value) {
  return value === null || value === undefined || value === ""
    ? null
    : normalizeId(value, "所属节点 ID");
}

function skipBirdTrivia(source, start = 0) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "#") {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      assert(end >= 0, "策略源码包含未结束的块注释");
      cursor = end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function findDeclarationEnd(source, openingBrace) {
  let depth = 0;
  let quote = null;
  for (let cursor = openingBrace; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline < 0 ? source.length : newline;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      assert(end >= 0, "策略源码包含未结束的块注释");
      cursor = end + 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
      assert(depth >= 0, "策略源码的花括号不匹配");
    }
  }
  throw new Error("策略源码缺少结束花括号");
}

function birdIdentifiers(source) {
  let code = "";
  let quote = null;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
      code += " ";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      code += " ";
      continue;
    }
    if (character === "#" || (character === "/" && next === "/")) {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline < 0 ? source.length : newline - 1;
      code += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end < 0 ? source.length : end + 1;
      code += " ";
      continue;
    }
    code += character;
  }
  return new Set(code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

export function birdSourceReferencesSymbol(source, symbol) {
  return birdIdentifiers(String(source ?? "")).has(String(symbol ?? ""));
}

function inspectPolicyDeclaration(sourceInput, kind, name) {
  const source = String(sourceInput ?? "").replaceAll("\r\n", "\n").trim();
  assert(source.length >= 1, "策略源码不能为空");
  assert(source.length <= MAX_POLICY_SOURCE_LENGTH, "单个策略源码不能超过 32 KiB");
  assert(!source.includes("\0"), "策略源码不能包含空字符");
  const start = skipBirdTrivia(source);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = kind === "function"
    ? new RegExp(`^function\\s+${escapedName}\\s*\\(([^)]*)\\)\\s*\\{`)
    : new RegExp(`^filter\\s+${escapedName}\\s*\\{`);
  const match = headerPattern.exec(source.slice(start));
  assert(match, `源码必须以完整的 ${kind === "function" ? "function" : "filter"} ${name} 声明开始`);
  const openingBrace = start + match[0].lastIndexOf("{");
  const end = findDeclarationEnd(source, openingBrace);
  assert(skipBirdTrivia(source, end) === source.length, "一个策略资源只能包含一条顶层声明");
  return {
    source,
    callable: kind === "function" && match[1].trim() === "",
  };
}

function normalizePolicyResource(input, kind) {
  assert(input && typeof input === "object", `${kind === "function" ? "Function" : "Filter"} 参数不能为空`);
  const name = normalizeId(input.name, `BIRD ${kind === "function" ? "Function" : "Filter"} 名称`);
  const label = normalizeLabel(input.label ?? input.name, `${kind === "function" ? "Function" : "Filter"} 显示名称`);
  assert(!RESERVED_PROTOCOL_NAMES.has(name), "策略名称与 Birdbox 内部协议冲突");
  const declaration = inspectPolicyDeclaration(input.source, kind, name);
  return {
    id: normalizeId(input.id, `${kind === "function" ? "Function" : "Filter"} ID`),
    nodeId: normalizeResourceScope(input.nodeId),
    label,
    name,
    source: declaration.source,
    enabled: input.enabled !== false,
    ...(kind === "function" ? { callable: declaration.callable } : {}),
  };
}

export function normalizePolicyFunction(input) {
  return normalizePolicyResource(input, "function");
}

export function normalizePolicyFilter(input) {
  return normalizePolicyResource(input, "filter");
}

function normalizePolicy(input, label, direction) {
  const value = input && typeof input === "object" ? input : {};
  const mode = String(value.mode ?? "form").trim().toLowerCase();
  assert(POLICY_MODES.has(mode), `${label}模式不合法`);
  let rawSteps = Array.isArray(value.steps)
    ? value.steps
    : (value.functionIds ?? []).map((functionId) => ({ functionId, action: "execute" }));
  if (mode === "combined" && !rawSteps.some((step) => step?.type === "form")) {
    rawSteps = [...rawSteps, { type: "form" }];
  }
  const steps = rawSteps.map((step) => {
    assert(step && typeof step === "object", `${label} Function 步骤不合法`);
    if (step.type === "form") return { type: "form" };
    const functionId = normalizeId(step.functionId, `${label} Function ID`);
    const action = String(step.action ?? "execute").trim().toLowerCase();
    assert(FUNCTION_STEP_ACTIONS.has(action), `${label} Function 动作不合法`);
    return { type: "function", functionId, action };
  });
  const filterId = value.filterId === null || value.filterId === undefined || value.filterId === ""
    ? null
    : normalizeId(value.filterId, `${label} Filter ID`);
  const functionSteps = steps.filter((step) => step.type === "function");
  const formStepCount = steps.filter((step) => step.type === "form").length;
  assert(functionSteps.length <= 16, `${label}最多可组合 16 个 Function`);
  assert(new Set(functionSteps.map((step) => step.functionId)).size === functionSteps.length, `${label}包含重复 Function`);
  if (mode === "combined") {
    assert(formStepCount === 1, `${label}组合模式必须包含一个表单策略步骤`);
  }
  if (mode === "custom") assert(filterId !== null, `${label}自定义模式必须选择 Filter`);
  const formAction = direction === "import"
    ? normalizeEnum(value.formAction, new Set(["all", "none"]), "all", "导入表单动作")
    : normalizeEnum(value.formAction, new Set(["all", "none", "cidr"]), "none", "导出表单动作");
  return {
    mode,
    steps: mode === "combined" ? steps : [],
    filterId: mode === "custom" ? filterId : null,
    formAction,
  };
}

function normalizeBgpOptions(input, legacyMultihop) {
  const value = input && typeof input === "object" ? input : {};
  const connectionMode = normalizeEnum(
    value.connectionMode,
    new Set(["direct", "multihop"]),
    legacyMultihop === false ? "direct" : "multihop",
    "连接方式",
  );
  const multihopTtl = normalizeOptionalInteger(value.multihopTtl ?? 10, "Multihop TTL", 1, 255);
  const errorWaitMin = normalizeOptionalInteger(value.errorWaitMin, "错误等待下限", 1, 86400);
  const errorWaitMax = normalizeOptionalInteger(value.errorWaitMax, "错误等待上限", 1, 86400);
  assert((errorWaitMin === null) === (errorWaitMax === null), "错误等待时间必须同时填写下限和上限");
  assert(errorWaitMin === null || errorWaitMax === null || errorWaitMin <= errorWaitMax, "错误等待范围必须从小到大");
  const checkLink = normalizeEnum(value.checkLink, SWITCH_SETTINGS, "default", "链路检查设置");
  assert(connectionMode !== "multihop" || checkLink !== "on", "Multihop 会话不能启用链路检查");
  const interfaceName = normalizeOptionalString(value.interface, "接口名称", 80);
  assert(connectionMode !== "multihop" || interfaceName === null, "Multihop 会话不能绑定接口");
  const passive = value.passive === true;
  const onlink = value.onlink === true;
  assert(connectionMode !== "multihop" || !onlink, "Multihop 会话不能启用 Onlink");
  assert(!onlink || passive || interfaceName !== null, "主动 Onlink 会话必须指定接口");
  const routeRefresh = normalizeEnum(value.routeRefresh, SWITCH_SETTINGS, "default", "Route Refresh 设置");
  const enhancedRouteRefresh = normalizeEnum(value.enhancedRouteRefresh, SWITCH_SETTINGS, "default", "Enhanced Route Refresh 设置");
  assert(routeRefresh !== "off" || enhancedRouteRefresh !== "on", "关闭 Route Refresh 时不能启用 Enhanced Route Refresh");
  const allowLocalAsInput = value.allowLocalAs;
  let allowLocalAs = null;
  if (allowLocalAsInput === "all") allowLocalAs = "all";
  else allowLocalAs = normalizeOptionalInteger(allowLocalAsInput, "允许本地 ASN 次数", 1, 255);
  const bfd = normalizeEnum(value.bfd, BFD_MODES, "off", "BFD 模式");
  const bfdOptions = normalizeBirdBlockSource(value.bfdOptions, "BFD 会话参数");
  assert(bfd !== "custom" || bfdOptions.length > 0, "Custom BFD 至少需要一条会话参数");
  const password = normalizeOptionalString(value.password, "TCP MD5 密码", 80);
  const aoKeys = normalizeBirdBlockSource(value.aoKeys, "TCP-AO Keys");
  const authentication = normalizeEnum(
    value.authentication,
    BGP_AUTHENTICATION_MODES,
    password ? "md5" : (aoKeys ? "ao" : "none"),
    "BGP 认证方式",
  );
  assert(authentication !== "md5" || password !== null, "TCP MD5 认证必须填写密码");
  assert(authentication !== "ao" || aoKeys.length > 0, "TCP-AO 认证必须填写 Keys 配置");
  assert(authentication === "md5" || password === null, "只有 TCP MD5 认证可以填写密码");
  assert(authentication === "ao" || aoKeys.length === 0, "只有 TCP-AO 认证可以填写 Keys 配置");

  const gracefulRestart = normalizeEnum(value.gracefulRestart, GRACEFUL_RESTART_MODES, "default", "Graceful Restart 设置");
  const gracefulRestartTime = normalizeOptionalInteger(value.gracefulRestartTime, "Graceful Restart 时间", 0, MAX_GRACEFUL_RESTART_TIME);
  const minGracefulRestartTime = normalizeOptionalInteger(value.minGracefulRestartTime, "最小 Graceful Restart 时间", 0, MAX_GRACEFUL_RESTART_TIME);
  const maxGracefulRestartTime = normalizeOptionalInteger(value.maxGracefulRestartTime, "最大 Graceful Restart 时间", 0, MAX_GRACEFUL_RESTART_TIME);
  assert(minGracefulRestartTime === null || maxGracefulRestartTime === null || minGracefulRestartTime <= maxGracefulRestartTime, "Graceful Restart 时间范围必须从小到大");
  const longLivedGracefulRestart = normalizeEnum(value.longLivedGracefulRestart, GRACEFUL_RESTART_MODES, "default", "Long-lived Graceful Restart 设置");
  const longLivedStaleTime = normalizeOptionalInteger(value.longLivedStaleTime, "Long-lived stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  const minLongLivedStaleTime = normalizeOptionalInteger(value.minLongLivedStaleTime, "最小 Long-lived stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  const maxLongLivedStaleTime = normalizeOptionalInteger(value.maxLongLivedStaleTime, "最大 Long-lived stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  assert(minLongLivedStaleTime === null || maxLongLivedStaleTime === null || minLongLivedStaleTime <= maxLongLivedStaleTime, "Long-lived stale 时间范围必须从小到大");
  assert(gracefulRestart !== "off" || !["on", "aware"].includes(longLivedGracefulRestart), "Long-lived Graceful Restart 依赖 Graceful Restart");

  const holdTime = normalizeOptionalInteger(value.holdTime, "Hold Time", 0, 65535);
  assert(holdTime === null || holdTime === 0 || holdTime >= 3, "Hold Time 必须为 0 或 3 到 65535");
  const keepaliveTime = normalizeOptionalInteger(value.keepaliveTime, "Keepalive Time", 1, 65535);
  const minHoldTime = normalizeOptionalInteger(value.minHoldTime, "最小 Hold Time", 0, 65535);
  const minKeepaliveTime = normalizeOptionalInteger(value.minKeepaliveTime, "最小 Keepalive Time", 0, 65535);
  const effectiveHoldTime = holdTime ?? 240;
  const effectiveKeepaliveTime = keepaliveTime ?? Math.floor(effectiveHoldTime / 3);
  assert(keepaliveTime === null || keepaliveTime <= effectiveHoldTime, "Keepalive Time 不能大于 Hold Time");
  assert(minHoldTime === null || minHoldTime <= effectiveHoldTime, "最小 Hold Time 不能大于 Hold Time");
  assert(minKeepaliveTime === null || minKeepaliveTime <= effectiveKeepaliveTime, "最小 Keepalive Time 不能大于 Keepalive Time");

  const capabilities = normalizeEnum(value.capabilities, SWITCH_SETTINGS, "default", "Capabilities 设置");
  const requireRouteRefresh = value.requireRouteRefresh === true;
  const requireEnhancedRouteRefresh = value.requireEnhancedRouteRefresh === true;
  const requireAs4 = value.requireAs4 === true;
  const requireExtendedMessages = value.requireExtendedMessages === true;
  const requireHostname = value.requireHostname === true;
  const requireGracefulRestart = value.requireGracefulRestart === true;
  const requireLongLivedGracefulRestart = value.requireLongLivedGracefulRestart === true;
  assert(!requireRouteRefresh || routeRefresh !== "off", "Require Route Refresh 需要启用 Route Refresh");
  assert(!requireEnhancedRouteRefresh || (routeRefresh !== "off" && enhancedRouteRefresh !== "off"), "Require Enhanced Route Refresh 需要启用 Route Refresh 与 Enhanced Route Refresh");
  assert(!requireAs4 || value.enableAs4 !== "off", "Require AS4 需要启用 AS4");
  assert(!requireExtendedMessages || value.extendedMessages === true, "Require Extended Messages 需要启用 Extended Messages");
  assert(!requireHostname || value.advertiseHostname === true, "Require Hostname 需要启用 Advertise Hostname");
  assert(!requireGracefulRestart || gracefulRestart !== "off", "Require Graceful Restart 需要启用 Graceful Restart");
  assert(!requireLongLivedGracefulRestart || (gracefulRestart !== "off" && longLivedGracefulRestart !== "off"), "Require LLGR 需要启用 GR 与 LLGR");
  assert(capabilities !== "off" || ![
    requireRouteRefresh, requireEnhancedRouteRefresh, requireAs4, requireExtendedMessages,
    requireHostname, requireGracefulRestart, requireLongLivedGracefulRestart,
  ].some(Boolean), "关闭 Capabilities 时不能要求远端能力");

  const confederation = normalizeOptionalInteger(value.confederation, "Confederation ASN", 1);
  const confederationMember = value.confederationMember === true;
  assert(!confederationMember || confederation !== null, "Confederation Member 必须设置 Confederation ASN");
  const localRole = normalizeEnum(value.localRole, LOCAL_ROLES, "", "本地 BGP Role");
  const requireRoles = value.requireRoles === true;
  assert(!requireRoles || localRole !== "", "Require Roles 必须设置 Local Role");
  return {
    connectionMode,
    multihopTtl,
    passive,
    bfd,
    bfdOptions,
    ttlSecurity: value.ttlSecurity === true,
    description: normalizeOptionalString(value.description, "会话描述", 200),
    routerId: value.routerId === null || value.routerId === undefined || value.routerId === ""
      ? null
      : normalizeIPv4(value.routerId, "会话 Router ID"),
    vrf: normalizeOptionalString(value.vrf, "VRF", 80),
    interface: interfaceName,
    onlink,
    authentication,
    password: authentication === "md5" ? password : null,
    aoKeys: authentication === "ao" ? aoKeys : "",
    setkey: normalizeEnum(value.setkey, SWITCH_SETTINGS, "default", "Setkey 设置"),
    strictBind: value.strictBind === true,
    freeBind: value.freeBind === true,
    checkLink,
    rsClient: value.rsClient === true,
    confederation,
    confederationMember,
    allowLocalPref: value.allowLocalPref === true,
    allowMed: value.allowMed === true,
    allowLocalAs,
    allowAsSets: normalizeEnum(value.allowAsSets, SWITCH_SETTINGS, "default", "AS_SET 设置"),
    enforceFirstAs: value.enforceFirstAs === true,
    routeRefresh,
    enhancedRouteRefresh,
    requireRouteRefresh,
    requireEnhancedRouteRefresh,
    gracefulRestart,
    gracefulRestartTime,
    minGracefulRestartTime,
    maxGracefulRestartTime,
    requireGracefulRestart,
    longLivedGracefulRestart,
    longLivedStaleTime,
    minLongLivedStaleTime,
    maxLongLivedStaleTime,
    requireLongLivedGracefulRestart,
    interpretCommunities: normalizeEnum(value.interpretCommunities, SWITCH_SETTINGS, "default", "Well-known Community 设置"),
    enableAs4: normalizeEnum(value.enableAs4, SWITCH_SETTINGS, "default", "AS4 设置"),
    requireAs4,
    extendedMessages: value.extendedMessages === true,
    requireExtendedMessages,
    capabilities,
    advertiseHostname: value.advertiseHostname === true,
    requireHostname,
    disableAfterError: value.disableAfterError === true,
    disableAfterCease: normalizeEnum(value.disableAfterCease, SWITCH_SETTINGS, "default", "Disable After Cease 设置"),
    holdTime,
    minHoldTime,
    startupHoldTime: normalizeOptionalInteger(value.startupHoldTime, "启动 Hold Time", 0, 65535),
    keepaliveTime,
    minKeepaliveTime,
    sendHoldTime: normalizeOptionalInteger(value.sendHoldTime, "Send Hold Time", 0, 65535),
    connectDelayTime: normalizeOptionalInteger(value.connectDelayTime, "连接延迟", 0, 86400),
    connectRetryTime: normalizeOptionalInteger(value.connectRetryTime, "连接重试时间", 1, 86400),
    errorWaitMin,
    errorWaitMax,
    errorForgetTime: normalizeOptionalInteger(value.errorForgetTime, "错误遗忘时间", 1, 86400),
    pathMetric: normalizeEnum(value.pathMetric, SWITCH_SETTINGS, "default", "AS Path 选路设置"),
    medMetric: value.medMetric === true,
    deterministicMed: value.deterministicMed === true,
    igpMetric: normalizeEnum(value.igpMetric, SWITCH_SETTINGS, "default", "IGP Metric 设置"),
    preferOlder: value.preferOlder === true,
    defaultMed: normalizeOptionalInteger(value.defaultMed, "默认 MED"),
    defaultLocalPref: normalizeOptionalInteger(value.defaultLocalPref, "默认 Local Preference"),
    localRole,
    requireRoles,
    raw: normalizeBirdBlockSource(value.raw, "额外 BGP 协议指令"),
  };
}

function normalizeChannelOptions(family, input) {
  const value = input && typeof input === "object" ? input : {};
  const label = family === "ipv4" ? "IPv4" : "IPv6";
  const nextHopKeep = normalizeEnum(value.nextHopKeep, NEXT_HOP_MODES, "default", "Next Hop Keep 设置");
  const nextHopSelf = normalizeEnum(value.nextHopSelf, NEXT_HOP_MODES, "default", "Next Hop Self 设置");
  assert(
    [nextHopKeep, nextHopSelf].filter((item) => item !== "default" && item !== "off").length <= 1,
    "Next Hop Keep 与 Next Hop Self 不能同时启用",
  );
  const extendedNextHop = value.extendedNextHop === true;
  const requireExtendedNextHop = value.requireExtendedNextHop === true;
  assert(!requireExtendedNextHop || family === "ipv4", "Require Extended Next Hop 只适用于 IPv4 Channel");
  assert(!requireExtendedNextHop || extendedNextHop, "Require Extended Next Hop 需要启用 Extended Next Hop");
  const addPaths = normalizeEnum(value.addPaths, new Set(["off", "on", "rx", "tx"]), "off", "Add Paths 设置");
  const requireAddPaths = value.requireAddPaths === true;
  assert(!requireAddPaths || addPaths !== "off", "Require Add Paths 需要启用 Add Paths");
  const minLongLivedStaleTime = normalizeOptionalInteger(value.minLongLivedStaleTime, "Channel 最小 LLGR Stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  const maxLongLivedStaleTime = normalizeOptionalInteger(value.maxLongLivedStaleTime, "Channel 最大 LLGR Stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  assert(minLongLivedStaleTime === null || maxLongLivedStaleTime === null || minLongLivedStaleTime <= maxLongLivedStaleTime, "Channel LLGR Stale 时间范围必须从小到大");
  return {
    table: normalizeOptionalName(value.table, `${label} 路由表名称`),
    preference: normalizeOptionalInteger(value.preference, "Channel Preference"),
    importKeepFiltered: value.importKeepFiltered === true,
    rpkiReload: normalizeEnum(value.rpkiReload, SWITCH_SETTINGS, "default", "RPKI Reload 设置"),
    importLimit: normalizeLimit(value.importLimit, "Import Limit"),
    receiveLimit: normalizeLimit(value.receiveLimit, "Receive Limit"),
    exportLimit: normalizeLimit(value.exportLimit, "Export Limit"),
    mandatory: value.mandatory === true,
    nextHopKeep,
    nextHopSelf,
    nextHopAddress: value.nextHopAddress === null || value.nextHopAddress === undefined || value.nextHopAddress === ""
      ? null
      : normalizeIPAddress(value.nextHopAddress, "Next Hop 地址"),
    nextHopPrefer: normalizeEnum(value.nextHopPrefer, NEXT_HOP_PREFER_MODES, "default", "Next Hop Prefer 设置"),
    linkLocalNextHopFormat: normalizeEnum(value.linkLocalNextHopFormat, LINK_LOCAL_NEXT_HOP_FORMATS, "default", "Link-local Next Hop 格式"),
    gateway: normalizeEnum(value.gateway, new Set(["default", "direct", "recursive"]), "default", "Gateway 模式"),
    igpTable: normalizeOptionalName(value.igpTable, "IGP 路由表名称"),
    importTable: value.importTable === true,
    exportTable: value.exportTable === true,
    secondary: value.secondary === true,
    extendedNextHop,
    requireExtendedNextHop,
    addPaths,
    requireAddPaths,
    aigp: normalizeEnum(value.aigp, new Set(["default", "off", "on", "originate"]), "default", "AIGP 设置"),
    cost: normalizeOptionalInteger(value.cost, "Channel Cost", 1),
    gracefulRestart: normalizeEnum(value.gracefulRestart, SWITCH_SETTINGS, "default", "Channel Graceful Restart 设置"),
    longLivedGracefulRestart: normalizeEnum(value.longLivedGracefulRestart, SWITCH_SETTINGS, "default", "Channel LLGR 设置"),
    longLivedStaleTime: normalizeOptionalInteger(value.longLivedStaleTime, "Channel LLGR Stale 时间", 0, MAX_LONG_LIVED_STALE_TIME),
    minLongLivedStaleTime,
    maxLongLivedStaleTime,
    raw: normalizeBirdBlockSource(value.raw, `额外 ${label} Channel 指令`),
  };
}

function normalizeChannel(family, input, defaultEnabled) {
  const value = input && typeof input === "object" ? input : {};
  const exportDefineId = value.exportDefineId === null || value.exportDefineId === undefined || value.exportDefineId === ""
    ? null
    : normalizeId(value.exportDefineId, `导出 IPv${family === "ipv4" ? 4 : 6} CIDR Define ID`);
  const importPolicy = normalizePolicy(value.importPolicy, `${family === "ipv4" ? "IPv4" : "IPv6"} 导入策略`, "import");
  const exportPolicy = normalizePolicy({
    ...(value.exportPolicy ?? {}),
    formAction: value.exportPolicy?.formAction ?? (exportDefineId === null ? "none" : "cidr"),
  }, `${family === "ipv4" ? "IPv4" : "IPv6"} 导出策略`, "export");
  assert(exportPolicy.formAction !== "cidr" || exportDefineId !== null, "导出指定 CIDR 模式必须选择 CIDR Define");
  return {
    enabled: value.enabled === undefined ? defaultEnabled : value.enabled === true,
    importPolicy,
    exportPolicy,
    exportDefineId,
    ...normalizeChannelOptions(family, value),
  };
}

export function normalizeSession(input) {
  assert(input && typeof input === "object", "会话参数不能为空");
  const protocolName = String(input.protocolName ?? "").trim();
  assert(NAME_RE.test(protocolName), "协议名称只能包含字母、数字和下划线，且必须以字母或下划线开头");
  assert(!RESERVED_PROTOCOL_NAMES.has(protocolName), "协议名称与 Birdbox 内部协议冲突");
  const legacyIpv4 = {
    ...(input.ipv4 ?? {}),
    enabled: true,
    exportDefineId: input.exportDefineId,
    importPolicy: input.importPolicy,
    exportPolicy: input.exportPolicy,
  };
  const channelInput = input.channels && typeof input.channels === "object"
    ? input.channels
    : { ipv4: legacyIpv4, ipv6: { enabled: true } };
  const channels = {
    ipv4: normalizeChannel("ipv4", channelInput.ipv4, true),
    ipv6: normalizeChannel("ipv6", channelInput.ipv6, true),
  };
  assert(channels.ipv4.enabled || channels.ipv6.enabled, "IPv4 与 IPv6 Channel 至少启用一个");
  const bgp = normalizeBgpOptions(input.bgp, input.multihop);
  for (const channel of Object.values(channels)) {
    assert(bgp.connectionMode !== "multihop" || channel.gateway !== "direct", "Multihop 会话不能使用 Direct Gateway");
    assert(bgp.capabilities !== "off" || !(channel.mandatory || channel.requireExtendedNextHop || channel.requireAddPaths), "关闭 Capabilities 时不能要求 Channel 能力");
  }
  return {
    id: normalizeId(input.id, "会话 ID"),
    nodeId: normalizeId(input.nodeId, "节点 ID"),
    peerId: normalizeId(input.peerId, "Peer ID"),
    protocolName,
    localAddress: input.localAddress === null || input.localAddress === undefined || input.localAddress === ""
      ? null
      : normalizeIPAddress(input.localAddress, "会话本地地址"),
    localAsn: normalizeAsn(input.localAsn, "会话本地 ASN "),
    localPort: normalizePort(input.localPort, "会话本地端口", RUNTIME.defaultBgpPort),
    bgp,
    channels,
    enabled: input.enabled !== false,
  };
}

export function validateInventory(input) {
  assert(input && typeof input === "object", "资产数据不能为空");
  const nodes = (input.nodes ?? []).map(normalizeNode);
  const peers = (input.peers ?? []).map(normalizePeer);
  const defines = (input.defines ?? []).map(normalizeDefine);
  const functions = (input.functions ?? []).map(normalizePolicyFunction);
  const filters = (input.filters ?? []).map(normalizePolicyFilter);
  const rpki = (input.rpki ?? []).map(normalizeRPKISource);
  const staticProtocols = (input.staticProtocols ?? []).map(normalizeStaticProtocol);
  const sessions = (input.sessions ?? []).map(normalizeSession);
  assert(new Set(nodes.map((item) => item.id)).size === nodes.length, "节点 ID 重复");
  assert(nodes.filter((item) => item.transport === "local").length <= 1, "只能配置一个本机节点");
  const deploymentTargets = nodes.filter((item) => item.transport === "ssh").map((item) =>
    `${item.sshHost.toLowerCase()}:${item.sshPort}:${item.generatedConfigPath}`,
  );
  assert(new Set(deploymentTargets).size === deploymentTargets.length, "多个节点不能使用同一个 SSH 配置部署目标");
  assert(new Set(peers.map((item) => item.id)).size === peers.length, "Peer ID 重复");
  assert(new Set(defines.map((item) => item.id)).size === defines.length, "Define ID 重复");
  assert(new Set(functions.map((item) => item.id)).size === functions.length, "Function ID 重复");
  assert(new Set(filters.map((item) => item.id)).size === filters.length, "Filter ID 重复");
  assert(new Set(rpki.map((item) => item.id)).size === rpki.length, "RPKI 资源 ID 重复");
  assert(new Set(staticProtocols.map((item) => item.id)).size === staticProtocols.length, "Static 资源 ID 重复");
  assert(new Set(sessions.map((item) => item.id)).size === sessions.length, "会话 ID 重复");

  const nodeMap = new Map(nodes.map((item) => [item.id, item]));
  const peerMap = new Map(peers.map((item) => [item.id, item]));
  const defineMap = new Map(defines.map((item) => [item.id, item]));
  const functionMap = new Map(functions.map((item) => [item.id, item]));
  const filterMap = new Map(filters.map((item) => [item.id, item]));
  for (const peer of peers) {
    assert(nodeMap.has(peer.nodeId), `Peer ${peer.name} 引用了不存在的节点`);
  }
  const managedDefines = defines;
  const validateReferences = (resource, source) => {
    const identifiers = birdIdentifiers(source);
    identifiers.delete(resource.name);
    for (const dependency of managedDefines.filter((item) => identifiers.has(item.name))) {
      assert(
        dependency.nodeId === null || resource.nodeId === dependency.nodeId,
        `资源 ${resource.name} 引用了作用域不兼容的 Define ${dependency.name}`,
      );
      assert(!resource.enabled || dependency.enabled, `资源 ${resource.name} 引用了已停用的 Define ${dependency.name}`);
    }
  };
  for (const resource of defines) {
    assert(resource.nodeId === null || nodeMap.has(resource.nodeId), `Define ${resource.name} 引用了不存在的节点`);
    if (resource.type === "expression") validateReferences(resource, resource.value);
  }
  for (const resource of [...functions, ...filters]) {
    assert(resource.nodeId === null || nodeMap.has(resource.nodeId), `策略 ${resource.name} 引用了不存在的节点`);
    validateReferences(resource, resource.source);
  }
  for (const resource of rpki) {
    assert(resource.nodeId === null || nodeMap.has(resource.nodeId), `RPKI 资源 ${resource.name} 引用了不存在的节点`);
  }
  for (const resource of staticProtocols) {
    const node = nodeMap.get(resource.nodeId);
    const staticDefine = resource.defineId === null ? null : defineMap.get(resource.defineId);
    const expectedDefineType = resource.family === "ipv4" ? "cidr4" : "cidr6";
    assert(node, `Static 资源 ${resource.name} 引用了不存在的节点`);
    assert(
      resource.defineId === null || (
        staticDefine?.type === expectedDefineType && staticDefine.enabled &&
        (staticDefine.nodeId === null || staticDefine.nodeId === node.id)
      ),
      `Static 资源 ${resource.name} 的 CIDR Define 对所选节点或地址族不可用`,
    );
    const identifiers = birdIdentifiers(resource.raw);
    for (const dependency of managedDefines.filter((item) => identifiers.has(item.name))) {
      assert(dependency.nodeId === null || dependency.nodeId === node.id, `Static 资源 ${resource.name} 引用了作用域不兼容的 Define ${dependency.name}`);
      assert(dependency.enabled, `Static 资源 ${resource.name} 引用了已停用的 Define ${dependency.name}`);
    }
  }
  for (const session of sessions) {
    const node = nodeMap.get(session.nodeId);
    const peer = peerMap.get(session.peerId);
    assert(node, `会话 ${session.protocolName} 引用了不存在的节点`);
    assert(peer && peer.nodeId === node.id, `会话 ${session.protocolName} 的 Peer 不属于所选节点`);
    assert(session.localAsn !== peer.asn, `会话 ${session.protocolName} 的两端 ASN 必须不同`);
    assert(session.localAddress === null || session.localAddress !== peer.address, `会话 ${session.protocolName} 的两端地址不能相同`);
    assert(session.localAddress === null || ipFamily(session.localAddress) === ipFamily(peer.address), `会话 ${session.protocolName} 的本地与 Peer 地址必须属于同一地址族`);
    const localScope = session.localAddress === null ? null : splitScopedIPAddress(session.localAddress).zone;
    const peerScope = splitScopedIPAddress(peer.address).zone;
    if ((session.localAddress !== null && isLinkLocalIPv6(session.localAddress)) || isLinkLocalIPv6(peer.address)) {
      assert(session.bgp.connectionMode === "direct", `会话 ${session.protocolName} 的 IPv6 Link-local 地址只能用于 Direct 会话`);
      assert(session.bgp.interface !== null || localScope !== null || peerScope !== null, `会话 ${session.protocolName} 的 IPv6 Link-local 地址必须指定接口`);
      assert(localScope === null || peerScope === null || localScope === peerScope, `会话 ${session.protocolName} 的 IPv6 Scope 接口必须一致`);
      assert(session.bgp.interface === null || localScope === null || session.bgp.interface === localScope, `会话 ${session.protocolName} 的 Local Scope 与 Interface 不一致`);
      assert(session.bgp.interface === null || peerScope === null || session.bgp.interface === peerScope, `会话 ${session.protocolName} 的 Peer Scope 与 Interface 不一致`);
    }
    for (const [family, channel] of Object.entries(session.channels)) {
      const expectedDefineType = family === "ipv4" ? "cidr4" : "cidr6";
      const exportDefine = channel.exportDefineId === null ? null : defineMap.get(channel.exportDefineId);
      assert(
        channel.exportDefineId === null || (
          exportDefine?.type === expectedDefineType && exportDefine.enabled &&
          (exportDefine.nodeId === null || exportDefine.nodeId === node.id)
        ),
        `会话 ${session.protocolName} 的 ${family.toUpperCase()} 导出 CIDR Define 对所选节点不可用`,
      );
      for (const [label, policy] of [["导入", channel.importPolicy], ["导出", channel.exportPolicy]]) {
        for (const step of policy.steps.filter((item) => item.type === "function")) {
          const resource = functionMap.get(step.functionId);
          assert(resource && resource.enabled && resource.callable && (resource.nodeId === null || resource.nodeId === node.id), `会话 ${session.protocolName} 的 ${family.toUpperCase()} ${label} Function 不可用`);
        }
        if (policy.filterId !== null) {
          const resource = filterMap.get(policy.filterId);
          assert(resource && resource.enabled && (resource.nodeId === null || resource.nodeId === node.id), `会话 ${session.protocolName} 的 ${family.toUpperCase()} ${label} Filter 不可用`);
        }
      }
    }
  }
  for (const node of nodes) {
    const nodeSessions = sessions.filter((item) => item.nodeId === node.id);
    const nodeDefines = defines.filter((item) => item.nodeId === null || item.nodeId === node.id);
    const nodeFunctions = functions.filter((item) => item.nodeId === null || item.nodeId === node.id);
    const nodeFilters = filters.filter((item) => item.nodeId === null || item.nodeId === node.id);
    const nodeRPKI = rpki.filter((item) => item.enabled && (item.nodeId === null || item.nodeId === node.id));
    const nodeStaticProtocols = staticProtocols.filter((item) => item.nodeId === node.id);
    assert(new Set(nodeSessions.map((item) => item.peerId)).size === nodeSessions.length, `节点 ${node.name} 对同一 Peer 存在多个会话`);
    assert(new Set(nodeSessions.map((item) => item.protocolName)).size === nodeSessions.length, `节点 ${node.name} 的协议名称重复`);
    const symbols = [
      ...nodeDefines.map((item) => item.name),
      ...nodeFunctions.map((item) => item.name),
      ...nodeFilters.map((item) => item.name),
      ...nodeSessions.map((item) => item.protocolName),
      ...nodeStaticProtocols.map((item) => item.name),
      ...nodeRPKI.flatMap((item) => [
        item.name,
        ...(item.sourceType === "file"
          ? [item.roa4Table ? `${item.name}_v4` : null, item.roa6Table ? `${item.name}_v6` : null]
          : []),
        item.roa4Table,
        item.roa6Table,
      ]).filter(Boolean),
    ];
    assert(new Set(symbols).size === symbols.length, `节点 ${node.name} 的 BIRD 全局标识符冲突`);
    for (const family of ["ipv4", "ipv6"]) {
      const routeActions = new Map();
      for (const resource of nodeStaticProtocols) {
        if (!resource.enabled || resource.family !== family || resource.action === null) continue;
        const staticDefine = defineMap.get(resource.defineId);
        for (const prefix of staticDefine.entries.filter(isExactPrefix)) {
          const existing = routeActions.get(prefix);
          assert(!existing || existing === resource.action, `节点 ${node.name} 对 ${prefix} 配置了冲突的静态路由动作`);
          routeActions.set(prefix, resource.action);
        }
      }
    }
  }

  return {
    version: 19,
    nodes,
    peers,
    defines,
    functions,
    filters,
    rpki,
    staticProtocols,
    sessions,
  };
}

function isExactPrefix(pattern) {
  return !/[+\-{]/.test(pattern);
}

function birdString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function indentBirdBlock(source, spaces) {
  if (!source) return "";
  const indentation = " ".repeat(spaces);
  return `${source.split("\n").map((line) => `${indentation}${line}`).join("\n")}\n`;
}

function renderSetting(name, value, spaces = 2) {
  return value === "default" ? "" : `${" ".repeat(spaces)}${name} ${value};\n`;
}

function renderLimit(name, limit) {
  return limit.value === null ? "" : `    ${name} ${limit.value} action ${limit.action};\n`;
}

function renderBgpOptions(session) {
  const options = session.bgp;
  let output = options.connectionMode === "multihop"
    ? `  multihop ${options.multihopTtl};\n`
    : "  direct;\n";
  if (options.description) output += `  description ${birdString(options.description)};\n`;
  if (options.routerId) output += `  router id ${options.routerId};\n`;
  if (options.vrf) output += options.vrf === "default" ? "  vrf default;\n" : `  vrf ${birdString(options.vrf)};\n`;
  if (options.interface) output += `  interface ${birdString(options.interface)};\n`;
  if (options.onlink) output += "  onlink on;\n";
  if (options.authentication !== "none") output += `  authentication ${options.authentication};\n`;
  if (options.authentication === "md5") output += `  password ${birdString(options.password)};\n`;
  if (options.authentication === "ao") output += `  keys {\n${indentBirdBlock(options.aoKeys, 4)}  };\n`;
  output += renderSetting("setkey", options.setkey);
  if (options.passive) output += "  passive on;\n";
  if (options.bfd === "custom") output += `  bfd {\n${indentBirdBlock(options.bfdOptions, 4)}  };\n`;
  else if (options.bfd !== "off") output += `  bfd ${options.bfd};\n`;
  if (options.ttlSecurity) output += "  ttl security on;\n";
  if (options.strictBind) output += "  strict bind on;\n";
  if (options.freeBind) output += "  free bind on;\n";
  output += renderSetting("check link", options.checkLink);
  if (options.rsClient) output += "  rs client;\n";
  if (options.confederation !== null) output += `  confederation ${options.confederation};\n`;
  if (options.confederationMember) output += "  confederation member on;\n";
  if (options.allowLocalPref) output += "  allow bgp_local_pref on;\n";
  if (options.allowMed) output += "  allow bgp_med on;\n";
  if (options.allowLocalAs === "all") output += "  allow local as;\n";
  else if (options.allowLocalAs !== null) output += `  allow local as ${options.allowLocalAs};\n`;
  output += renderSetting("allow as sets", options.allowAsSets);
  if (options.enforceFirstAs) output += "  enforce first as on;\n";
  output += renderSetting("enable route refresh", options.routeRefresh);
  if (options.requireRouteRefresh) output += "  require route refresh on;\n";
  output += renderSetting("enable enhanced route refresh", options.enhancedRouteRefresh);
  if (options.requireEnhancedRouteRefresh) output += "  require enhanced route refresh on;\n";
  output += renderSetting("graceful restart", options.gracefulRestart);
  if (options.gracefulRestartTime !== null) output += `  graceful restart time ${options.gracefulRestartTime};\n`;
  if (options.minGracefulRestartTime !== null) output += `  min graceful restart time ${options.minGracefulRestartTime};\n`;
  if (options.maxGracefulRestartTime !== null) output += `  max graceful restart time ${options.maxGracefulRestartTime};\n`;
  if (options.requireGracefulRestart) output += "  require graceful restart on;\n";
  output += renderSetting("long lived graceful restart", options.longLivedGracefulRestart);
  if (options.longLivedStaleTime !== null) output += `  long lived stale time ${options.longLivedStaleTime};\n`;
  if (options.minLongLivedStaleTime !== null) output += `  min long lived stale time ${options.minLongLivedStaleTime};\n`;
  if (options.maxLongLivedStaleTime !== null) output += `  max long lived stale time ${options.maxLongLivedStaleTime};\n`;
  if (options.requireLongLivedGracefulRestart) output += "  require long lived graceful restart on;\n";
  output += renderSetting("interpret communities", options.interpretCommunities);
  output += renderSetting("enable as4", options.enableAs4);
  if (options.requireAs4) output += "  require as4 on;\n";
  if (options.extendedMessages) output += "  enable extended messages on;\n";
  if (options.requireExtendedMessages) output += "  require extended messages on;\n";
  output += renderSetting("capabilities", options.capabilities);
  if (options.advertiseHostname) output += "  advertise hostname on;\n";
  if (options.requireHostname) output += "  require hostname on;\n";
  if (options.disableAfterError) output += "  disable after error on;\n";
  output += renderSetting("disable after cease", options.disableAfterCease);
  if (options.holdTime !== null) output += `  hold time ${options.holdTime};\n`;
  if (options.minHoldTime !== null) output += `  min hold time ${options.minHoldTime};\n`;
  if (options.startupHoldTime !== null) output += `  startup hold time ${options.startupHoldTime};\n`;
  if (options.keepaliveTime !== null) output += `  keepalive time ${options.keepaliveTime};\n`;
  if (options.minKeepaliveTime !== null) output += `  min keepalive time ${options.minKeepaliveTime};\n`;
  if (options.sendHoldTime !== null) output += `  send hold time ${options.sendHoldTime};\n`;
  if (options.connectDelayTime !== null) output += `  connect delay time ${options.connectDelayTime};\n`;
  if (options.connectRetryTime !== null) output += `  connect retry time ${options.connectRetryTime};\n`;
  if (options.errorWaitMin !== null) output += `  error wait time ${options.errorWaitMin}, ${options.errorWaitMax};\n`;
  if (options.errorForgetTime !== null) output += `  error forget time ${options.errorForgetTime};\n`;
  output += renderSetting("path metric", options.pathMetric);
  if (options.medMetric) output += "  med metric on;\n";
  if (options.deterministicMed) output += "  deterministic med on;\n";
  output += renderSetting("igp metric", options.igpMetric);
  if (options.preferOlder) output += "  prefer older on;\n";
  if (options.defaultMed !== null) output += `  default bgp_med ${options.defaultMed};\n`;
  if (options.defaultLocalPref !== null) output += `  default bgp_local_pref ${options.defaultLocalPref};\n`;
  if (options.localRole) output += `  local role ${options.localRole};\n`;
  if (options.requireRoles) output += "  require roles on;\n";
  output += indentBirdBlock(options.raw, 2);
  return output;
}

function renderChannelOptions(options) {
  let output = "";
  if (options.table) output += `    table ${options.table};\n`;
  if (options.preference !== null) output += `    preference ${options.preference};\n`;
  if (options.importKeepFiltered) output += "    import keep filtered on;\n";
  output += renderSetting("rpki reload", options.rpkiReload, 4);
  output += renderLimit("import limit", options.importLimit);
  output += renderLimit("receive limit", options.receiveLimit);
  output += renderLimit("export limit", options.exportLimit);
  if (options.mandatory) output += "    mandatory on;\n";
  output += renderSetting("next hop keep", options.nextHopKeep, 4);
  output += renderSetting("next hop self", options.nextHopSelf, 4);
  if (options.nextHopAddress) output += `    next hop address ${options.nextHopAddress};\n`;
  if (options.nextHopPrefer !== "default") output += `    next hop prefer ${options.nextHopPrefer};\n`;
  if (options.linkLocalNextHopFormat !== "default") output += `    link local next hop format ${options.linkLocalNextHopFormat};\n`;
  if (options.gateway !== "default") output += `    gateway ${options.gateway};\n`;
  if (options.igpTable) output += `    igp table ${options.igpTable};\n`;
  if (options.importTable) output += "    import table on;\n";
  if (options.exportTable) output += "    export table on;\n";
  if (options.secondary) output += "    secondary on;\n";
  if (options.extendedNextHop) output += "    extended next hop on;\n";
  if (options.requireExtendedNextHop) output += "    require extended next hop on;\n";
  if (options.addPaths !== "off") output += `    add paths ${options.addPaths};\n`;
  if (options.requireAddPaths) output += "    require add paths on;\n";
  if (options.aigp !== "default") output += `    aigp ${options.aigp};\n`;
  if (options.cost !== null) output += `    cost ${options.cost};\n`;
  output += renderSetting("graceful restart", options.gracefulRestart, 4);
  output += renderSetting("long lived graceful restart", options.longLivedGracefulRestart, 4);
  if (options.longLivedStaleTime !== null) output += `    long lived stale time ${options.longLivedStaleTime};\n`;
  if (options.minLongLivedStaleTime !== null) output += `    min long lived stale time ${options.minLongLivedStaleTime};\n`;
  if (options.maxLongLivedStaleTime !== null) output += `    max long lived stale time ${options.maxLongLivedStaleTime};\n`;
  output += indentBirdBlock(options.raw, 4);
  return output;
}

function renderRPKIInterval(keyword, value, keep) {
  return value === null ? "" : `  ${keyword} ${keep ? "keep " : ""}${value};\n`;
}

function renderRPKISource(source) {
  if (source.sourceType === "file") {
    let output = "";
    if (source.roa4Table) {
      output += `\nprotocol static ${source.name}_v4 {\n`;
      output += `  roa4 { table ${source.roa4Table}; };\n`;
      output += `  include ${birdString(source.file4)};\n`;
      output += "}\n";
    }
    if (source.roa6Table) {
      output += `\nprotocol static ${source.name}_v6 {\n`;
      output += `  roa6 { table ${source.roa6Table}; };\n`;
      output += `  include ${birdString(source.file6)};\n`;
      output += "}\n";
    }
    return output;
  }
  let output = `\nprotocol rpki ${source.name} {\n`;
  if (source.roa4Table) output += `  roa4 { table ${source.roa4Table}; };\n`;
  if (source.roa6Table) output += `  roa6 { table ${source.roa6Table}; };\n`;
  output += `  remote ${net.isIP(source.remote) ? source.remote : birdString(source.remote)} port ${source.port};\n`;
  if (source.localAddress) output += `  local address ${source.localAddress};\n`;
  output += renderRPKIInterval("refresh", source.refresh, source.keepRefresh);
  output += renderRPKIInterval("retry", source.retry, source.keepRetry);
  output += renderRPKIInterval("expire", source.expire, source.keepExpire);
  if (source.ignoreMaxLength !== "default") output += `  ignore max length ${source.ignoreMaxLength};\n`;
  if (source.minVersion !== null) output += `  min version ${source.minVersion};\n`;
  if (source.maxVersion !== null) output += `  max version ${source.maxVersion};\n`;
  if (source.transport === "ssh") {
    output += "  transport ssh {\n";
    output += `    bird private key ${birdString(source.birdPrivateKey)};\n`;
    output += `    remote public key ${birdString(source.remotePublicKey)};\n`;
    output += `    user ${birdString(source.user)};\n`;
    output += "  };\n";
  } else if (source.authentication === "md5") {
    output += "  transport tcp {\n    authentication md5;\n";
    output += `    password ${birdString(source.password)};\n  };\n`;
  }
  output += "}\n";
  return output;
}

export function renderBirdConfig(nodeInput, peerInputs, sessionInputs, functionInputs = [], filterInputs = [], defineInputs = [], rpkiInputs = [], staticInputs = []) {
  const node = normalizeNode(nodeInput);
  const peers = peerInputs.map(normalizePeer);
  const defines = defineInputs.map(normalizeDefine).filter((item) => item.enabled);
  const functions = functionInputs.map(normalizePolicyFunction).filter((item) => item.enabled);
  const filters = filterInputs.map(normalizePolicyFilter).filter((item) => item.enabled);
  const rpki = rpkiInputs.map(normalizeRPKISource).filter((item) => item.enabled && (item.nodeId === null || item.nodeId === node.id));
  const staticProtocols = staticInputs.map(normalizeStaticProtocol).filter((item) => item.enabled && item.nodeId === node.id);
  const sessions = sessionInputs.map(normalizeSession).filter((item) => item.enabled);
  const peerMap = new Map(peers.map((item) => [item.id, item]));
  const defineMap = new Map(defines.map((item) => [item.id, item]));
  const functionMap = new Map(functions.map((item) => [item.id, item]));
  const filterMap = new Map(filters.map((item) => [item.id, item]));
  for (const resource of [...defines, ...functions, ...filters]) {
    assert(resource.nodeId === null || resource.nodeId === node.id, `策略 ${resource.name} 对节点 ${node.name} 不可用`);
  }
  const table4Names = new Set(rpki.map((item) => item.roa4Table).filter(Boolean));
  const table6Names = new Set(rpki.map((item) => item.roa6Table).filter(Boolean));
  const active = sessions.map((session) => {
    const peer = peerMap.get(session.peerId);
    assert(session.nodeId === node.id, `会话 ${session.protocolName} 不属于节点 ${node.name}`);
    assert(peer && peer.nodeId === node.id, `会话 ${session.protocolName} 的 Peer 不属于节点 ${node.name}`);
    assert(session.localAsn !== peer.asn, `会话 ${session.protocolName} 的两端 ASN 必须不同`);
    assert(session.localAddress === null || session.localAddress !== peer.address, `会话 ${session.protocolName} 的两端地址不能相同`);
    assert(session.localAddress === null || ipFamily(session.localAddress) === ipFamily(peer.address), `会话 ${session.protocolName} 的本地与 Peer 地址必须属于同一地址族`);
    const localScope = session.localAddress === null ? null : splitScopedIPAddress(session.localAddress).zone;
    const peerScope = splitScopedIPAddress(peer.address).zone;
    if ((session.localAddress !== null && isLinkLocalIPv6(session.localAddress)) || isLinkLocalIPv6(peer.address)) {
      assert(session.bgp.connectionMode === "direct", `会话 ${session.protocolName} 的 IPv6 Link-local 地址只能用于 Direct 会话`);
      assert(session.bgp.interface !== null || localScope !== null || peerScope !== null, `会话 ${session.protocolName} 的 IPv6 Link-local 地址必须指定接口`);
      assert(localScope === null || peerScope === null || localScope === peerScope, `会话 ${session.protocolName} 的 IPv6 Scope 接口必须一致`);
    }
    const exportDefines = {};
    for (const [family, channel] of Object.entries(session.channels)) {
      const expectedType = family === "ipv4" ? "cidr4" : "cidr6";
      const exportDefine = channel.exportDefineId === null ? null : defineMap.get(channel.exportDefineId);
      assert(
        channel.exportDefineId === null || (exportDefine?.type === expectedType && (exportDefine.nodeId === null || exportDefine.nodeId === node.id)),
        `会话 ${session.protocolName} 的 ${family.toUpperCase()} 导出 CIDR Define 对节点 ${node.name} 不可用`,
      );
      for (const policy of [channel.importPolicy, channel.exportPolicy]) {
        for (const step of policy.steps.filter((item) => item.type === "function")) {
          const resource = functionMap.get(step.functionId);
          assert(resource?.callable, `会话 ${session.protocolName} 引用了不可用的 Function`);
        }
        if (policy.filterId !== null) assert(filterMap.has(policy.filterId), `会话 ${session.protocolName} 引用了不可用的 Filter`);
      }
      exportDefines[family] = exportDefine;
    }
    return { session, peer, exportDefines };
  });
  const routeActions = { ipv4: new Map(), ipv6: new Map() };
  const renderedStaticProtocols = staticProtocols.map((resource) => {
    const expectedType = resource.family === "ipv4" ? "cidr4" : "cidr6";
    const staticDefine = resource.defineId === null ? null : defineMap.get(resource.defineId);
    assert(
      resource.defineId === null || (staticDefine?.type === expectedType && (staticDefine.nodeId === null || staticDefine.nodeId === node.id)),
      `Static 资源 ${resource.name} 的 CIDR Define 对节点 ${node.name} 不可用`,
    );
    const routes = [];
    if (resource.action !== null && staticDefine !== null) {
      for (const prefix of staticDefine.entries.filter(isExactPrefix)) {
        const existing = routeActions[resource.family].get(prefix);
        assert(!existing || existing === resource.action, `节点 ${node.name} 对 ${prefix} 配置了冲突的静态路由动作`);
        routeActions[resource.family].set(prefix, resource.action);
        routes.push([prefix, resource.action]);
      }
    }
    return { ...resource, routes };
  }).filter((resource) => resource.routes.length || resource.raw);

  let config = "# Generated by Birdbox Demo. Manual changes will be replaced.\n";
  if (node.deploymentMode === "legacy") {
    config += `router id ${node.routerId};\n\nprotocol device birdbox_device {\n}\n`;
  } else {
    config += "# This file is included by the system BIRD configuration.\n";
  }

  for (const resource of defines) {
    const value = resource.type.startsWith("cidr") ? `[ ${resource.entries.join(", ")} ]` : resource.value;
    config += `\ndefine ${resource.name} = ${value};\n`;
  }

  for (const table of table4Names) config += `\nroa4 table ${table};\n`;
  for (const table of table6Names) config += `\nroa6 table ${table};\n`;
  for (const source of rpki) config += renderRPKISource(source);

  for (const resource of functions) config += `\n${resource.source}\n`;
  for (const resource of filters) config += `\n${resource.source}\n`;

  if (active.some(({ session }) => session.bgp.bfd !== "off")) {
    config += "\nprotocol bfd birdbox_bfd {\n}\n";
  }

  for (const staticProtocol of renderedStaticProtocols) {
    config += `\nprotocol static ${staticProtocol.name} {\n` +
      `  ${staticProtocol.family} {\n` +
      `    import ${staticProtocol.import};\n` +
      `    export ${staticProtocol.export};\n` +
      "  };\n";
    for (const [prefix, action] of staticProtocol.routes) config += `  route ${prefix} ${action};\n`;
    if (staticProtocol.raw) config += indentBirdBlock(staticProtocol.raw, 2);
    config += `}\n`;
  }

  for (const { session, peer, exportDefines } of active) {
    const renderPolicy = (policy, direction, exportDefine) => {
      if (policy.mode === "custom") return `    ${direction} filter ${filterMap.get(policy.filterId).name};\n`;
      const formDecision = direction === "import"
        ? `      ${policy.formAction === "all" ? "accept" : "reject"};\n`
        : policy.formAction === "all"
          ? "      accept;\n"
          : policy.formAction === "none"
            ? "      reject;\n"
            : `      if net ~ ${exportDefine.name} then accept;\n`;
      const stepLines = policy.mode === "combined"
        ? policy.steps.map((step, index) => {
          if (step.type === "form") {
            const finalExportReject = direction === "export" && policy.formAction === "none" && index === policy.steps.length - 1;
            return finalExportReject ? "" : formDecision;
          }
          const functionName = functionMap.get(step.functionId).name;
          if (step.action === "execute") return `      ${functionName}();\n`;
          return `      if ${functionName}() then ${step.action};\n`;
        }).join("")
        : "";
      if (direction === "import") {
        return stepLines
          ? `    import filter {\n${stepLines}    };\n`
          : `    import ${policy.formAction};\n`;
      }
      if (policy.mode === "form") {
        if (policy.formAction === "all") return "    export all;\n";
        if (policy.formAction === "none") return "    export none;\n";
      }
      const renderedSteps = policy.mode === "combined" ? stepLines : formDecision;
      return `    export filter {\n${renderedSteps}      reject;\n    };\n`;
    };
    config += `\nprotocol bgp ${session.protocolName} {\n` +
      `  local${session.localAddress ? ` ${session.localAddress}` : ""} port ${session.localPort} as ${session.localAsn};\n` +
      `  neighbor ${peer.address} port ${peer.port} as ${peer.asn};\n` +
      renderBgpOptions(session);
    for (const family of ["ipv4", "ipv6"]) {
      const channel = session.channels[family];
      if (!channel.enabled) continue;
      config += `  ${family} {\n` +
        renderChannelOptions(channel) +
        renderPolicy(channel.importPolicy, "import", exportDefines[family]) +
        renderPolicy(channel.exportPolicy, "export", exportDefines[family]) +
        `  };\n`;
    }
    config += `}\n`;
  }
  return config;
}

function sshArgs(node, remoteCommand) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "HashKnownHosts=yes",
    "-o", "UpdateHostKeys=yes",
  ];
  if (node.sshPort !== 22) args.push("-p", String(node.sshPort));
  if (node.sshIdentity === "managed") {
    assert(managedSshConfiguration.identityFile && managedSshConfiguration.knownHostsFile, "Birdbox 托管 SSH 密钥尚未初始化");
    args.push(
      "-i", managedSshConfiguration.identityFile,
      "-o", `UserKnownHostsFile=${managedSshConfiguration.knownHostsFile}`,
      "-o", "IdentitiesOnly=yes",
    );
  }
  // Non-interactive SSH sessions commonly omit /usr/sbin from PATH even
  // though BIRD is installed there. Keep command execution independent of a
  // user's login shell profile while retaining the node's normal PATH.
  const commandWithSystemPath = `PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH; export PATH; ${remoteCommand}`;
  args.push("--", node.sshUser ? `${node.sshUser}@${node.sshHost}` : node.sshHost, commandWithSystemPath);
  return args;
}

function execFileWithInput(executable, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    // A remote command can reject input before SSH has consumed it. Its exit
    // status is the useful error in that case, not the resulting EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function runOnNode(nodeInput, command, options = {}) {
  assert(nodeInput?.kind === "managed-node", "命令只能在受管节点执行");
  const node = normalizeNode(nodeInput);
  const timeout = options.timeout ?? 15000;
  const maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024;
  try {
    const executable = node.transport === "local" ? "bash" : "ssh";
    const args = node.transport === "local" ? ["-lc", command] : sshArgs(node, command);
    const result = options.input === undefined
      ? await execFileAsync(executable, args, { timeout, maxBuffer })
      : await execFileWithInput(executable, args, { timeout, maxBuffer }, options.input);
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? error.message ?? "命令执行失败").trim(),
      code: error.code ?? 1,
    };
  }
}

export async function inspectNode(node) {
  const normalizedNode = normalizeNode(node);
  const command = `
version=$(bird --version 2>&1 || true)
if [ -S '${normalizedNode.socketPath}' ]; then
  protocols=$(birdc -s '${normalizedNode.socketPath}' -v 'show protocols all' 2>&1 || true)
else
  protocols=''
fi
printf '%s\\n---BIRDBOX---\\n%s\\n' "$version" "$protocols"
`.trim();
  const result = await runOnNode(node, command, { timeout: 12000 });
  const [version = "", raw = ""] = result.stdout.split("---BIRDBOX---");
  const protocols = parseProtocolStatuses(raw);
  return {
    nodeId: node.id,
    reachable: result.ok,
    bird2: /BIRD version 2\./.test(version),
    version: version.trim() || null,
    protocols,
    error: result.ok ? null : (result.stderr || "节点不可达"),
    raw: raw.trim(),
  };
}

export async function checkIncludeNodeAccess(nodeInput) {
  const node = normalizeNode(nodeInput);
  assert(node.deploymentMode === "include", "只有 Include 节点需要执行接入检查");
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
  return runOnNode(node, command, { timeout: 12000 });
}

export function parseProtocolStatus(raw) {
  const text = String(raw ?? "");
  const header = text.match(/^1002-[^\s]+\s+BGP\b[^\r\n]*$/m)?.[0] ?? "";
  const state = text.match(/BGP state:\s+([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const bgpSection = state ? text.slice(text.search(/BGP state:/i)) : text;
  const neighbor = text.match(/Neighbor address:\s+([^\s]+)/i)?.[1] ?? null;
  const neighborAs = text.match(/Neighbor AS:\s+(\d+)/i)?.[1] ?? null;
  const routes = bgpSection.match(/Routes:\s+(\d+) imported,\s+(\d+) exported/i);
  return {
    configured: text.length > 0 && !/Unable to connect/i.test(text),
    disabled: /\b(?:Admin down|Disabled)\b/i.test(header),
    state,
    established: state?.toLowerCase() === "established",
    neighbor,
    neighborAs: neighborAs ? Number(neighborAs) : null,
    imported: routes ? Number(routes[1]) : null,
    exported: routes ? Number(routes[2]) : null,
  };
}

export function parseProtocolStatuses(raw) {
  const text = String(raw ?? "");
  const headers = [...text.matchAll(/^1002-([^\s]+)\s+BGP\b/gm)];
  return headers.map((match, index) => {
    const end = headers[index + 1]?.index ?? text.length;
    return { name: match[1], ...parseProtocolStatus(text.slice(match.index, end)) };
  });
}

export async function stageAndValidate(node, config) {
  const normalizedNode = normalizeNode(node);
  if (normalizedNode.deploymentMode === "include") {
    const activePath = normalizedNode.generatedConfigPath;
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
      `test -S '${normalizedNode.socketPath}'`,
      `test -L '${activePath}'`,
      `test -w '${directory}'`,
      `bird_group=$(stat -c '%G' '${normalizedNode.socketPath}')`,
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
      `birdc -s '${normalizedNode.socketPath}' 'configure check'`,
    ].join("\n");
    return runOnNode(normalizedNode, command, { timeout: 15000, input: config });
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
  return runOnNode(node, command, { timeout: 15000, input: config });
}

export async function applyStagedConfig(node) {
  const normalizedNode = normalizeNode(node);
  if (normalizedNode.deploymentMode === "include") {
    const activePath = normalizedNode.generatedConfigPath;
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
      `if birdc -s '${normalizedNode.socketPath}' 'configure check' && birdc -s '${normalizedNode.socketPath}' configure; then cleanup_versions || true; exit 0; fi`,
      `ln -sfn "$current_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${normalizedNode.socketPath}' configure >/dev/null 2>&1 || true`,
      "exit 1",
    ].join("\n");
    return runOnNode(normalizedNode, command, { timeout: 20000 });
  }
  const command = [
    `test -f '${RUNTIME.configPath}.candidate'`,
    `if [ -f '${RUNTIME.configPath}' ]; then cp -a '${RUNTIME.configPath}' '${RUNTIME.configPath}.rollback'; else rm -f '${RUNTIME.configPath}.rollback'; fi`,
    `mv -f '${RUNTIME.configPath}.candidate' '${RUNTIME.configPath}'`,
    `chown bird:bird '${RUNTIME.configPath}' && chmod 0640 '${RUNTIME.configPath}'`,
    `if [ -S '${RUNTIME.socketPath}' ] && birdc -s '${RUNTIME.socketPath}' 'show status' >/dev/null 2>&1; then birdc -s '${RUNTIME.socketPath}' configure; else rm -f '${RUNTIME.socketPath}' '${RUNTIME.pidPath}'; bird -c '${RUNTIME.configPath}' -s '${RUNTIME.socketPath}' -P '${RUNTIME.pidPath}' -u bird -g bird; fi`,
  ].join(" && ");
  return runOnNode(node, command, { timeout: 20000 });
}

export async function rollbackNode(node) {
  const normalizedNode = normalizeNode(node);
  if (normalizedNode.deploymentMode === "include") {
    const activePath = normalizedNode.generatedConfigPath;
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
      `if birdc -s '${normalizedNode.socketPath}' 'configure check' && birdc -s '${normalizedNode.socketPath}' configure; then ln -sfn "$current_target" '${rollbackLink}'; exit 0; fi`,
      `ln -sfn "$current_target" '${switchLink}'`,
      `mv -f '${switchLink}' '${activePath}'`,
      `birdc -s '${normalizedNode.socketPath}' configure >/dev/null 2>&1 || true`,
      "exit 1",
    ].join("\n");
    return runOnNode(normalizedNode, command, { timeout: 20000 });
  }
  const command = `if [ -f '${RUNTIME.configPath}.rollback' ]; then cp -a '${RUNTIME.configPath}.rollback' '${RUNTIME.configPath}'; bird -p -c '${RUNTIME.configPath}'; if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' configure; else bird -c '${RUNTIME.configPath}' -s '${RUNTIME.socketPath}' -P '${RUNTIME.pidPath}' -u bird -g bird; fi; else if [ -S '${RUNTIME.socketPath}' ]; then birdc -s '${RUNTIME.socketPath}' down || true; fi; rm -f '${RUNTIME.configPath}'; fi`;
  return runOnNode(node, command, { timeout: 20000 });
}

export async function setProtocolState(nodeInput, protocolNameInput, enabled) {
  const node = normalizeNode(nodeInput);
  const protocolName = String(protocolNameInput ?? "").trim();
  assert(NAME_RE.test(protocolName), "BGP 协议名称不合法");
  assert(typeof enabled === "boolean", "BGP 协议状态不合法");
  const command = `${enabled ? "enable" : "disable"} ${protocolName}`;
  return runOnNode(
    node,
    `birdc -s '${node.socketPath}' '${command}'`,
    { timeout: 10000 },
  );
}

export async function stopProtocol(nodeInput, protocolName) {
  return setProtocolState(nodeInput, protocolName, false);
}

export async function startProtocol(nodeInput, protocolName) {
  return setProtocolState(nodeInput, protocolName, true);
}

export async function loadSeedNodes(nodesPath) {
  const content = await fs.readFile(nodesPath, "utf8");
  const nodes = JSON.parse(content).map(normalizeNode);
  assert(nodes.length >= 1, "至少需要配置一个受管节点");
  return nodes;
}

export async function saveJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}
