import net from "node:net";

import type { RpkiFileSource, RpkiServerSource, RpkiSource } from "../packages/contracts/src/inventory.js";
import {
  assertValidation,
  normalizeEnum,
  normalizeId,
  normalizeIPAddress,
  normalizeLabel,
  normalizeOptionalInteger,
  normalizeOptionalName,
  normalizeOptionalString,
  normalizePort,
  normalizeResourceScope,
} from "./bird-normalize-common.js";

type UnknownRecord = Record<string, unknown>;

const RPKI_SOURCE_TYPES = new Set(["file", "server"] as const);
const RPKI_TRANSPORTS = new Set(["tcp", "ssh"] as const);
const RPKI_TCP_AUTHENTICATION = new Set(["none", "md5"] as const);
const RPKI_SWITCH_SETTINGS = new Set(["default", "on", "off"] as const);

function inputRecord(value: unknown): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), "RPKI 资源参数不能为空");
  return value as UnknownRecord;
}

function normalizeRPKIPath(value: unknown, label: string): string | null {
  const normalizedPath = normalizeOptionalString(value, label, 512);
  if (normalizedPath === null) return null;
  assertValidation(normalizedPath.startsWith("/"), `${label}必须使用绝对路径`);
  return normalizedPath;
}

function normalizeRPKIRemote(value: unknown): string {
  const remote = normalizeOptionalString(value, "RPKI 服务器", 253);
  assertValidation(remote !== null, "RPKI 服务器不能为空");
  assertValidation(!remote.includes("/") && !remote.includes("\\") && !remote.includes("\""), "RPKI 服务器地址不合法");
  assertValidation(net.isIP(remote) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(remote), "RPKI 服务器地址不合法");
  return remote;
}

export function normalizeRPKISource(inputValue: unknown): RpkiSource {
  const input = inputRecord(inputValue);
  const sourceType = normalizeEnum(input.sourceType ?? input.kind, RPKI_SOURCE_TYPES, "file", "RPKI 来源类型");
  const roa4Table = normalizeOptionalName(input.roa4Table ?? input.table4, "IPv4 ROA Table");
  const roa6Table = normalizeOptionalName(input.roa6Table ?? input.table6, "IPv6 ROA Table");
  assertValidation(roa4Table !== null || roa6Table !== null, "RPKI 至少需要启用一个 ROA Table");
  assertValidation(roa4Table === null || roa4Table !== roa6Table, "IPv4 与 IPv6 ROA Table 名称必须不同");
  const base = {
    id: normalizeId(input.id, "RPKI 资源 ID"),
    nodeId: normalizeResourceScope(input.nodeId),
    label: normalizeLabel(input.label ?? input.name, "RPKI 资源名称"),
    name: normalizeId(input.name, "RPKI 协议名称"),
    roa4Table,
    roa6Table,
    enabled: input.enabled !== false,
  };
  assertValidation(sourceType !== "file" || base.name.length <= 60, "本地 ROA 资源名称最多 60 个字符");
  if (sourceType === "file") {
    const file4 = normalizeRPKIPath(input.file4 ?? input.roa4File, "IPv4 ROA 文件");
    const file6 = normalizeRPKIPath(input.file6 ?? input.roa6File, "IPv6 ROA 文件");
    assertValidation(roa4Table === null || file4 !== null, "启用 IPv4 ROA Table 时必须填写 IPv4 ROA 文件");
    assertValidation(roa6Table === null || file6 !== null, "启用 IPv6 ROA Table 时必须填写 IPv6 ROA 文件");
    assertValidation(file4 === null || roa4Table !== null, "填写 IPv4 ROA 文件时必须启用 IPv4 ROA Table");
    assertValidation(file6 === null || roa6Table !== null, "填写 IPv6 ROA 文件时必须启用 IPv6 ROA Table");
    return { ...base, sourceType, file4, file6 } satisfies RpkiFileSource;
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
  assertValidation(minVersion === null || maxVersion === null || minVersion <= maxVersion, "RPKI 版本范围必须从小到大");
  const ignoreMaxLength = normalizeEnum(input.ignoreMaxLength, RPKI_SWITCH_SETTINGS, "default", "RPKI Max Length 设置");
  const authentication = normalizeEnum(input.authentication, RPKI_TCP_AUTHENTICATION, "none", "RPKI TCP 认证方式");
  const password = normalizeOptionalString(input.password, "RPKI TCP-MD5 密码", 80);
  assertValidation(transport === "tcp" || authentication === "none", "SSH 传输不能配置 TCP-MD5");
  assertValidation(authentication !== "md5" || password !== null, "RPKI TCP-MD5 必须填写密码");
  assertValidation(authentication === "md5" || password === null, "只有 RPKI TCP-MD5 可以填写密码");
  const birdPrivateKey = normalizeRPKIPath(input.birdPrivateKey, "RPKI SSH 私钥");
  const remotePublicKey = normalizeRPKIPath(input.remotePublicKey, "RPKI SSH 公钥");
  const user = normalizeOptionalString(input.user, "RPKI SSH 用户名", 80);
  assertValidation(transport !== "ssh" || (birdPrivateKey !== null && remotePublicKey !== null && user !== null), "RPKI SSH 必须填写私钥、公钥和用户名");
  assertValidation(transport !== "tcp" || (birdPrivateKey === null && remotePublicKey === null && user === null), "TCP 传输不能填写 SSH 参数");
  return {
    ...base,
    sourceType,
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
  } satisfies RpkiServerSource;
}

export function normalizeRPKI(input: unknown): RpkiSource {
  return normalizeRPKISource(input);
}
