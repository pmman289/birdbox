import net from "node:net";
import path from "node:path";

import type { ManagedNode, Peer } from "../packages/contracts/src/inventory.js";

type UnknownRecord = Record<string, unknown>;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9_.:@-]{1,253}$/;
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const ABSOLUTE_PATH_RE = /^\/[A-Za-z0-9_./-]{1,254}$/;
const DEPLOYMENT_MODES = new Set(["legacy", "include"] as const);
const SSH_IDENTITY_MODES = new Set(["default", "managed"] as const);

export const RUNTIME = Object.freeze({
  baseDir: process.env.BIRDBOX_RUNTIME_DIR ?? "/var/lib/birdbox-demo",
  configPath: `${process.env.BIRDBOX_RUNTIME_DIR ?? "/var/lib/birdbox-demo"}/bird.conf`,
  socketPath: process.env.BIRDBOX_SOCKET_PATH ?? "/run/bird/birdbox-demo.ctl",
  pidPath: process.env.BIRDBOX_PID_PATH ?? "/run/bird/birdbox-demo.pid",
  defaultBgpPort: 179,
});

function inputRecord(value: unknown, message: string): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as UnknownRecord;
}

export function assertValidation(condition: unknown, message: string): asserts condition {
  if (!condition) {
    const error = new Error(message) as Error & { status: number };
    error.status = 400;
    throw error;
  }
}

export function normalizeId(value: unknown, label: string): string {
  const id = String(value ?? "").trim();
  assertValidation(NAME_RE.test(id), `${label}不合法`);
  return id;
}

export function normalizeLabel(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  assertValidation(text.length >= 1 && text.length <= 80, `${label}长度应为 1 到 80 个字符`);
  assertValidation(!/[\u0000-\u001f\u007f]/.test(text), `${label}不能包含控制字符`);
  return text;
}

export function normalizeAsn(value: unknown, label: string): number {
  const normalized = Number(value);
  assertValidation(Number.isInteger(normalized) && normalized >= 1 && normalized <= 4294967295, `${label}超出范围`);
  return normalized;
}

export function normalizePort(value: unknown, label: string, fallback: number): number {
  const normalized = Number(value ?? fallback);
  assertValidation(Number.isInteger(normalized) && normalized >= 1 && normalized <= 65535, `${label}超出范围`);
  return normalized;
}

export function normalizeOptionalInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = 4294967295,
): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const normalized = Number(value);
  assertValidation(Number.isInteger(normalized) && normalized >= minimum && normalized <= maximum, `${label}超出范围`);
  return normalized;
}

export function normalizeOptionalString(value: unknown, label: string, maximum = 255): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).replaceAll("\r\n", "\n").trim();
  assertValidation(text.length >= 1 && text.length <= maximum, `${label}长度应为 1 到 ${maximum} 个字符`);
  assertValidation(!/[\u0000-\u001f\u007f]/.test(text), `${label}不能包含控制字符`);
  return text;
}

export function normalizeAbsolutePath(value: unknown, label: string, fallback: string): string {
  const normalized = path.posix.normalize(String(value ?? fallback).trim());
  assertValidation(ABSOLUTE_PATH_RE.test(normalized) && !normalized.includes("/../"), `${label}必须是安全的绝对路径`);
  return normalized;
}

export function normalizeEnum<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<Value>,
  fallback: Value,
  label: string,
): Value {
  const normalized = String(value ?? fallback).trim().toLowerCase() as Value;
  assertValidation(allowed.has(normalized), `${label}不合法`);
  return normalized;
}

export function normalizeOptionalName(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return normalizeId(value, label);
}

export function normalizeIPv4(value: unknown, label: string): string {
  const address = String(value ?? "").trim();
  assertValidation(net.isIPv4(address), `${label}必须是有效的 IPv4 地址`);
  return address;
}

export function splitScopedIPAddress(value: unknown): { address: string; base: string; zone: string | null } {
  const address = String(value ?? "").trim();
  const zoneIndex = address.lastIndexOf("%");
  if (zoneIndex < 0) return { address, base: address, zone: null };
  const base = address.slice(0, zoneIndex);
  const zone = address.slice(zoneIndex + 1);
  assertValidation(zone.length >= 1 && zone.length <= 80 && /^[A-Za-z0-9_.:@-]+$/.test(zone), "IPv6 Scope 接口不合法");
  return { address, base, zone };
}

export function ipFamily(value: unknown): number {
  return net.isIP(splitScopedIPAddress(value).base);
}

export function channelUsesCrossFamilyTransport(peerAddress: string, family: "ipv4" | "ipv6"): boolean {
  return ipFamily(peerAddress) !== (family === "ipv4" ? 4 : 6);
}

export function isLinkLocalIPv6(value: unknown): boolean {
  const { base } = splitScopedIPAddress(value);
  if (!net.isIPv6(base)) return false;
  const first = Number.parseInt(base.split(":")[0] || "0", 16);
  return (first & 0xffc0) === 0xfe80;
}

export function normalizeIPAddress(value: unknown, label: string, expectedFamily: number | null = null): string {
  const { address, base, zone } = splitScopedIPAddress(value);
  const family = net.isIP(base);
  assertValidation(family !== 0, `${label}必须是有效的 IP 地址`);
  assertValidation(zone === null || (family === 6 && isLinkLocalIPv6(address)), `${label}只有 IPv6 Link-local 地址可以指定 Scope 接口`);
  assertValidation(expectedFamily === null || family === expectedFamily, `${label}必须是 IPv${expectedFamily} 地址`);
  return address;
}

export function normalizeResourceScope(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : normalizeId(value, "所属节点 ID");
}

export function normalizeNode(inputValue: unknown): ManagedNode {
  const input = inputRecord(inputValue, "节点参数不能为空");
  const transport = input.transport ?? "ssh";
  assertValidation(transport === "local" || transport === "ssh", "节点管理方式不合法");
  const sshHost = transport === "ssh" ? String(input.sshHost ?? "").trim() : null;
  if (transport === "ssh") assertValidation(HOST_RE.test(sshHost as string) && !(sshHost as string).startsWith("-"), "SSH 目标不合法");
  const deploymentMode = normalizeEnum(input.deploymentMode, DEPLOYMENT_MODES, "legacy", "节点部署模式");
  const sshIdentity = normalizeEnum(input.sshIdentity, SSH_IDENTITY_MODES, deploymentMode === "include" ? "managed" : "default", "SSH 凭据模式");
  const sshUser = transport === "ssh" && input.sshUser !== null && input.sshUser !== undefined && input.sshUser !== ""
    ? String(input.sshUser).trim()
    : null;
  if (sshUser !== null) assertValidation(SSH_USER_RE.test(sshUser), "SSH 用户名不合法");
  if (deploymentMode === "include") {
    assertValidation(transport === "ssh", "Include 节点必须使用 SSH");
    assertValidation(sshUser !== null, "Include 节点必须指定 SSH 用户");
    assertValidation(!(sshHost as string).includes("@"), "Include 节点的主机与 SSH 用户必须分开填写");
    assertValidation(sshIdentity === "managed", "Include 节点必须使用 Birdbox 托管密钥");
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

export function normalizePeer(inputValue: unknown): Peer {
  const input = inputRecord(inputValue, "Peer 参数不能为空");
  const managedByInput = input.managedBy && typeof input.managedBy === "object" && !Array.isArray(input.managedBy)
    ? input.managedBy as UnknownRecord
    : null;
  const managedBy = managedByInput?.kind === "ibgp-domain"
    ? {
        kind: "ibgp-domain" as const,
        domainId: normalizeId(managedByInput.domainId, "iBGP 域 ID"),
        adjacencyId: normalizeId(managedByInput.adjacencyId, "iBGP 邻接 ID"),
      }
    : undefined;
  return {
    id: normalizeId(input.id, "Peer ID"),
    nodeId: normalizeId(input.nodeId, "所属节点 ID"),
    name: normalizeLabel(input.name, "Peer 名称"),
    address: normalizeIPAddress(input.address, "Peer 地址"),
    asn: normalizeAsn(input.asn, "远端 ASN "),
    port: normalizePort(input.port, "远端 BGP 端口", 179),
    ...(managedBy ? { managedBy } : {}),
  };
}
