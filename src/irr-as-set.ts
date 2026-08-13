import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { normalizeBirdPrefixPattern } from "./bird-prefix.js";
import { isIrrAsSetName, normalizeIrrAsSetName } from "./irr-name.js";

export interface IrrResolveRequest {
  family: 4 | 6;
  asSet: string;
  server: string;
  databases: string[];
  prefixLimit: number;
  allowMoreSpecific: boolean;
}

export interface IrrResolveResult {
  entries: string[];
  contentHash: string;
  command: string[];
}

const MAX_PREFIXES = 100_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function invalid(message: string): never {
  const error = new Error(message) as Error & { status: number };
  error.status = 400;
  throw error;
}

export function normalizeIrrResolveRequest(value: IrrResolveRequest): IrrResolveRequest {
  const family = Number(value.family);
  if (family !== 4 && family !== 6) invalid("IRR 地址族必须是 IPv4 或 IPv6");
  const asSet = normalizeIrrAsSetName(value.asSet);
  const server = String(value.server ?? "rr.ntt.net").trim().toLowerCase();
  if (!isIrrAsSetName(asSet)) invalid("AS-SET 名称不合法");
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/.test(server) || /[\s'"`$\\]/.test(server)) invalid("IRR Server 不合法");
  const databases = (value.databases ?? []).map((item) => String(item).trim().toUpperCase()).filter(Boolean);
  if (databases.length > 32 || databases.some((item) => !/^[A-Z0-9_-]{1,32}$/.test(item))) invalid("IRR Database 列表不合法");
  const prefixLimit = Number(value.prefixLimit);
  if (!Number.isSafeInteger(prefixLimit) || prefixLimit < 1 || prefixLimit > MAX_PREFIXES) invalid(`前缀上限必须是 1 到 ${MAX_PREFIXES} 之间的整数`);
  return { family, asSet, server, databases, prefixLimit, allowMoreSpecific: value.allowMoreSpecific === true };
}

export function parseBgpq4Json(output: string, requestInput: IrrResolveRequest): IrrResolveResult {
  const request = normalizeIrrResolveRequest(requestInput);
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) invalid("bgpq4 输出超过 16 MiB 安全上限");
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { invalid("bgpq4 返回了无法解析的 JSON"); }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const list = root ? Object.values(root)[0] : null;
  if (!Array.isArray(list)) invalid("bgpq4 JSON 中缺少前缀列表");
  const entries = list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("bgpq4 返回了非法前缀条目");
    const record = item as Record<string, unknown>;
    const prefix = normalizeBirdPrefixPattern(record.prefix, request.family);
    if (record.exact !== true) invalid(`bgpq4 返回了非精确前缀: ${prefix}`);
    return request.allowMoreSpecific ? `${prefix}+` : prefix;
  });
  const normalized = [...new Set(entries)].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (!normalized.length) invalid("AS-SET 没有展开出任何前缀，继续保留旧快照");
  if (normalized.length > request.prefixLimit) invalid(`AS-SET 展开得到 ${normalized.length} 条前缀，超过用户设置的 ${request.prefixLimit} 条上限`);
  return {
    entries: normalized,
    contentHash: createHash("sha256").update(normalized.join("\n")).digest("hex"),
    command: [],
  };
}

export async function resolveIrrAsSet(requestInput: IrrResolveRequest, timeoutMs = 45_000): Promise<IrrResolveResult> {
  const request = normalizeIrrResolveRequest(requestInput);
  const args = ["-h", request.server];
  if (request.databases.length) args.push("-S", request.databases.join(","));
  args.push(request.family === 4 ? "-4" : "-6", "-j", "-l", "birdbox_prefixes", request.asSet);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("bgpq4", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) reject(Object.assign(new Error("bgpq4 展开超时"), { status: 504 }));
      settled = true;
    }, timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(errors, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(Object.assign(new Error(error.message.includes("ENOENT") ? "控制器未安装 bgpq4" : error.message), { status: 503 }));
      settled = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (size > MAX_OUTPUT_BYTES) return reject(Object.assign(new Error("bgpq4 输出超过 16 MiB 安全上限"), { status: 413 }));
      if (code !== 0) return reject(Object.assign(new Error(Buffer.concat(errors).toString("utf8").trim() || `bgpq4 退出码 ${code}`), { status: 502 }));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  return { ...parseBgpq4Json(output, request), command: ["bgpq4", ...args] };
}
