import net from "node:net";

import type { AddressFamily, ChannelPolicy, DirectProtocol, KernelExportPolicy, KernelProtocol } from "../packages/contracts/src/inventory.js";
import {
  assertValidation,
  normalizeEnum,
  normalizeId,
  normalizeLabel,
  normalizeMultiNodeResourceScope,
  normalizeOptionalInteger,
} from "./bird-normalize-common.js";
import { normalizeChannelPolicy } from "./bird-session.js";

type RecordValue = Record<string, unknown>;

// These declarations are emitted by Birdbox itself. Direct and Kernel
// resources are user-named, so reject collisions here before a duplicate
// protocol block can make an otherwise valid deployment unloadable.
const RESERVED_PROTOCOL_NAMES = new Set([
  "birdbox_device",
  "birdbox_static",
  "birdbox_static4",
  "birdbox_static6",
  "birdbox_bfd",
]);

function assertAvailableProtocolName(name: string, label: string): void {
  assertValidation(!RESERVED_PROTOCOL_NAMES.has(name), `${label}与 Birdbox 内部协议冲突`);
}

function record(value: unknown, message: string): RecordValue {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as RecordValue;
}

function interfaces(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : String(value).split(",");
  const result = list.map((item) => String(item).trim()).filter(Boolean);
  assertValidation(result.length <= 64, "Direct 接口列表过多");
  for (const item of result) assertValidation(item.length <= 128 && !/[\u0000-\u001f\u007f;]/.test(item), "Direct 接口匹配规则不合法");
  return [...new Set(result)];
}

function normalizeKernelExportPolicy(value: unknown, fallback: ChannelPolicy, family: AddressFamily): KernelExportPolicy {
  if (value === undefined || value === null) return { mode: "visual", policy: fallback, prefSrc: null };
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const mode = input.mode === "krt_prefsrc" || input.mode === "krt-prefsrc" ? "krt_prefsrc" : "visual";
  if (mode === "krt_prefsrc") {
    const prefSrc = String(input.prefSrc ?? input.krtPrefSrc ?? "").trim();
    assertValidation(net.isIP(prefSrc) === (family === "ipv4" ? 4 : 6), `Kernel ${family.toUpperCase()} krt_prefsrc 必须是有效的${family === "ipv4" ? " IPv4" : " IPv6"}地址`);
    return { mode, policy: fallback, prefSrc };
  }
  const policyInput = input.policy && typeof input.policy === "object" && !Array.isArray(input.policy) ? input.policy : value;
  const policy = normalizeChannelPolicy(policyInput, `Kernel ${family.toUpperCase()} 导出策略`, "export");
  assertValidation(policy.formAction === "all" || policy.formAction === "none", `Kernel ${family.toUpperCase()} 导出策略只能选择 all 或 none`);
  return { mode, policy, prefSrc: null };
}

export function normalizeDirectProtocol(inputValue: unknown): DirectProtocol {
  const input = record(inputValue, "Direct 资源参数不能为空");
  const name = normalizeId(input.name ?? "birdbox_direct", "Direct 协议名称");
  assertAvailableProtocolName(name, "Direct 协议名称");
  const ipv4 = input.ipv4 !== false;
  const ipv6 = input.ipv6 !== false;
  assertValidation(ipv4 || ipv6, "Direct 至少启用一个地址族");
  return {
    id: normalizeId(input.id, "Direct 资源 ID"),
    label: normalizeLabel(input.label ?? name, "Direct 显示名称"),
    name,
    nodeId: normalizeId(input.nodeId, "Direct 所属节点 ID"),
    interfaces: interfaces(input.interfaces),
    ipv4,
    ipv6,
    enabled: input.enabled !== false,
  };
}

export function normalizeKernelProtocol(inputValue: unknown): KernelProtocol {
  const input = record(inputValue, "Kernel 资源参数不能为空");
  const name = normalizeId(input.name ?? "birdbox_kernel", "Kernel 协议名称");
  assertAvailableProtocolName(name, "Kernel 协议名称");
  const ipv4 = input.ipv4 !== false;
  const ipv6 = input.ipv6 !== false;
  assertValidation(ipv4 || ipv6, "Kernel 至少启用一个地址族");
  const importPolicy = normalizeChannelPolicy(input.importPolicy, "Kernel 导入策略", "import");
  const exportPolicy = normalizeChannelPolicy(input.exportPolicy, "Kernel 导出策略", "export");
  assertValidation(importPolicy.formAction === "all" || importPolicy.formAction === "none", "Kernel 导入策略只能选择 all 或 none");
  assertValidation(exportPolicy.formAction === "all" || exportPolicy.formAction === "none", "Kernel 导出策略只能选择 all 或 none");
  const rawExportPolicies = input.exportPolicies && typeof input.exportPolicies === "object" && !Array.isArray(input.exportPolicies)
    ? input.exportPolicies as Record<string, unknown>
    : {};
  const exportPolicies = {
    ipv4: normalizeKernelExportPolicy(rawExportPolicies.ipv4, exportPolicy, "ipv4"),
    ipv6: normalizeKernelExportPolicy(rawExportPolicies.ipv6, exportPolicy, "ipv6"),
  } satisfies Record<AddressFamily, KernelExportPolicy>;
  return {
    id: normalizeId(input.id, "Kernel 资源 ID"),
    label: normalizeLabel(input.label ?? name, "Kernel 显示名称"),
    name,
    nodeIds: normalizeMultiNodeResourceScope(input.nodeIds, input.nodeId),
    ipv4,
    ipv6,
    importPolicy,
    exportPolicy,
    exportPolicies,
    table: normalizeOptionalInteger(input.table, "Kernel 路由表", 1, 4294967295),
    scanTime: normalizeOptionalInteger(input.scanTime, "Kernel 扫描周期", 1, 86400),
    persist: input.persist === true,
    enabled: input.enabled !== false,
  };
}

export function defaultKernelPolicy(direction: "import" | "export") {
  return { mode: "form" as const, steps: [], filterId: null, formAction: direction === "import" ? "none" as const : "all" as const };
}
