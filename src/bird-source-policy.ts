import crypto from "node:crypto";

import type {
  ManagedNode,
  SourcePolicyEgress,
  SourcePolicyEgressGroup,
  SourcePolicyManualPlan,
  SourcePolicyRuleInstruction,
} from "../packages/contracts/src/index.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import {
  assertValidation,
  normalizeId,
  normalizeIPv4,
  normalizeLabel,
  normalizeMultiNodeResourceScope,
  normalizeOptionalInteger,
} from "./bird-normalize-common.js";

type UnknownRecord = Record<string, unknown>;

export const MAX_SOURCE_POLICY_GROUPS = 16;
export const MAX_SOURCE_POLICY_SOURCES_PER_GROUP = 64;
export const SOURCE_POLICY_PRIORITY_MIN = 10000;
export const SOURCE_POLICY_PRIORITY_WIDTH = MAX_SOURCE_POLICY_GROUPS * MAX_SOURCE_POLICY_SOURCES_PER_GROUP;
export const SOURCE_POLICY_PRIORITY_MAX = 32765;
export const SOURCE_POLICY_TABLE_MIN = 1;
export const SOURCE_POLICY_TABLE_MAX = 2147483647;
export const SOURCE_POLICY_AUTO_TABLE_MIN = 200;
export const SOURCE_POLICY_AUTO_TABLE_MAX = 10000;
const RESERVED_KERNEL_TABLES = new Set([0, 253, 254, 255]);

function record(value: unknown, message: string): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as UnknownRecord;
}

function canonicalIPv4Cidr(value: unknown): string {
  const source = String(value ?? "").trim();
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(source);
  assertValidation(match, `源地址必须是合法的 IPv4 CIDR：${source}`);
  const address = normalizeIPv4(match?.[1] ?? "", "源地址");
  const prefix = Number(match?.[2]);
  assertValidation(Number.isInteger(prefix) && prefix >= 0 && prefix <= 32, `源地址前缀长度不合法：${source}`);
  const octets = (address ?? "").split(".").map(Number);
  const valueNumber = (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (valueNumber & mask) >>> 0;
  return `${[(network >>> 24) & 255, (network >>> 16) & 255, (network >>> 8) & 255, network & 255].join(".")}/${prefix}`;
}

function cidrRange(prefix: string): [number, number] {
  const [address, lengthValue] = prefix.split("/");
  const octets = (address ?? "").split(".").map(Number);
  const value = ((((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0);
  const length = Number(lengthValue);
  const hostBits = 32 - length;
  const size = hostBits === 32 ? 0xffffffff : (2 ** hostBits) - 1;
  return [value, value + size];
}

function rangesOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1];
}

function stableNumber(value: string): number {
  return Number.parseInt(crypto.createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

function groupInputSources(input: UnknownRecord): unknown[] {
  const value = input.sources ?? input.sourcePrefixes ?? [];
  assertValidation(Array.isArray(value), "出口组源地址必须是数组");
  return value;
}

function normalizeGroup(inputValue: unknown, index: number): SourcePolicyEgressGroup {
  const input = record(inputValue, "源地址出口组不能为空");
  const sources = groupInputSources(input).map((source) => canonicalIPv4Cidr(
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as UnknownRecord).prefix
      : source,
  ));
  assertValidation(sources.length > 0, "每个出口组至少需要一个源 CIDR");
  assertValidation(sources.length <= MAX_SOURCE_POLICY_SOURCES_PER_GROUP, `单个出口组最多支持 ${MAX_SOURCE_POLICY_SOURCES_PER_GROUP} 个源 CIDR`);
  assertValidation(new Set(sources).size === sources.length, "同一出口组不能重复使用源 CIDR");
  const ranges = sources.map((prefix) => cidrRange(prefix));
  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      assertValidation(!rangesOverlap(ranges[left]!, ranges[right]!), `同一出口组的源 CIDR 不能重叠：${sources[left]} 与 ${sources[right]}`);
    }
  }
  const kernelTable = normalizeOptionalInteger(input.kernelTable, "内核路由表", SOURCE_POLICY_TABLE_MIN, SOURCE_POLICY_TABLE_MAX) ?? (SOURCE_POLICY_AUTO_TABLE_MIN + index);
  assertValidation(!RESERVED_KERNEL_TABLES.has(kernelTable), "内核路由表不能使用 0、253、254 或 255");
  return {
    id: normalizeId(input.id ?? `egress_${index + 1}`, "出口组 ID"),
    egressAddress: normalizeIPv4(input.egressAddress ?? input.gateway, "出口地址"),
    sources,
    kernelTable,
    ruleSlot: normalizeOptionalInteger(input.ruleSlot, "规则分配槽位", 0, MAX_SOURCE_POLICY_GROUPS - 1) ?? index,
  };
}

export function normalizeSourcePolicyEgress(inputValue: unknown): SourcePolicyEgress {
  const input = record(inputValue, "源地址出口映射不能为空");
  const groupsInput = input.groups ?? input.mappings;
  assertValidation(Array.isArray(groupsInput), "源地址出口映射必须包含出口组列表");
  assertValidation(groupsInput.length > 0 && groupsInput.length <= MAX_SOURCE_POLICY_GROUPS, `出口组数量必须为 1 到 ${MAX_SOURCE_POLICY_GROUPS}`);
  const groups = groupsInput.map(normalizeGroup);
  assertValidation(new Set(groups.map((group) => group.id)).size === groups.length, "出口组 ID 重复");
  assertValidation(new Set(groups.map((group) => group.egressAddress)).size === groups.length, "同一个映射集不能重复配置出口地址");
  assertValidation(new Set(groups.map((group) => group.ruleSlot)).size === groups.length, "出口组规则分配槽位重复");
  assertValidation(new Set(groups.map((group) => group.kernelTable)).size === groups.length, "出口组内核路由表重复");
  const nodeIds = normalizeMultiNodeResourceScope(input.nodeIds, input.nodeId);
  const rulePriorityBase = normalizeOptionalInteger(input.rulePriorityBase, "规则优先级范围", SOURCE_POLICY_PRIORITY_MIN, SOURCE_POLICY_PRIORITY_MAX - SOURCE_POLICY_PRIORITY_WIDTH + 1) ?? SOURCE_POLICY_PRIORITY_MIN;
  assertValidation(rulePriorityBase + SOURCE_POLICY_PRIORITY_WIDTH - 1 <= SOURCE_POLICY_PRIORITY_MAX, "规则优先级范围超出 Linux 默认规则之前的可用区间");
  const copyInternalRoutes = input.copyInternalRoutes !== false;
  const internalDefineIds = Array.isArray(input.internalDefineIds)
    ? input.internalDefineIds.map((value) => normalizeId(value, "内部路由 Define ID"))
    : [];
  assertValidation(new Set(internalDefineIds).size === internalDefineIds.length, "内部路由 Define 不能重复选择");
  return {
    id: normalizeId(input.id, "源地址出口映射 ID"),
    label: normalizeLabel(input.label ?? input.name, "源地址出口映射名称"),
    enabled: input.enabled !== false,
    nodeIds,
    groups,
    rulePriorityBase,
    copyInternalRoutes,
    internalDefineIds,
  };
}

function nextFree<T>(values: ReadonlySet<T>, candidates: Iterable<T>): T | null {
  for (const candidate of candidates) if (!values.has(candidate)) return candidate;
  return null;
}

function allocateKernelTable(used: ReadonlySet<number>): number {
  for (let table = SOURCE_POLICY_AUTO_TABLE_MIN; table <= SOURCE_POLICY_AUTO_TABLE_MAX; table += 1) {
    if (!RESERVED_KERNEL_TABLES.has(table) && !used.has(table)) return table;
  }
  assertValidation(false, "自动分配的 Linux 内核路由表空间已耗尽；请为出口组手工指定 table ID");
}

function allocatePriorityBase(id: string, used: ReadonlySet<number>): number {
  const slots = Math.floor((SOURCE_POLICY_PRIORITY_MAX - SOURCE_POLICY_PRIORITY_MIN + 1) / SOURCE_POLICY_PRIORITY_WIDTH);
  const start = stableNumber(id) % Math.max(slots, 1);
  for (let offset = 0; offset < slots; offset += 1) {
    const slot = (start + offset) % slots;
    const candidate = SOURCE_POLICY_PRIORITY_MIN + slot * SOURCE_POLICY_PRIORITY_WIDTH;
    if (!used.has(candidate)) return candidate;
  }
  assertValidation(false, "Linux 源地址策略规则优先级空间已耗尽");
}

export function prepareSourcePolicyEgress(
  inputValue: unknown,
  previous: SourcePolicyEgress | null,
  existing: readonly SourcePolicyEgress[],
  makeId: (prefix: string) => string,
): SourcePolicyEgress {
  const requested = record(inputValue, "源地址出口映射不能为空");
  const input = { ...(previous ?? {}), ...requested } as UnknownRecord;
  const id = normalizeId(input.id ?? previous?.id ?? makeId("source_policy"), "源地址出口映射 ID");
  const rawGroups = input.groups ?? input.mappings;
  assertValidation(Array.isArray(rawGroups), "源地址出口映射必须包含出口组列表");
  const previousById = new Map((previous?.groups ?? []).map((group) => [group.id, group]));
  const previousByAddress = new Map((previous?.groups ?? []).map((group) => [group.egressAddress, group]));
  const requestedGroups = rawGroups.map((value) => {
    const raw = record(value, "源地址出口组不能为空");
    const requestedId = raw.id === undefined ? null : normalizeId(raw.id, "出口组 ID");
    const address = normalizeIPv4(raw.egressAddress ?? raw.gateway, "出口地址");
    const old = (requestedId ? previousById.get(requestedId) : null) ?? previousByAddress.get(address) ?? null;
    return { raw, requestedId, address, old };
  });
  const usedTables = new Set<number>(requestedGroups.map((group) => group.old?.kernelTable).filter((value): value is number => value !== undefined));
  for (const resource of existing) {
    if (resource.id === previous?.id || resource.id === id) continue;
    for (const group of resource.groups) usedTables.add(group.kernelTable);
  }
  const usedSlots = new Set<number>(requestedGroups.map((group) => group.old?.ruleSlot).filter((value): value is number => value !== undefined));
  const groups = requestedGroups.map(({ raw, requestedId, address, old }, index) => {
    const groupId = old?.id ?? requestedId ?? makeId("source_gateway");
    const normalized = normalizeGroup({ ...raw, id: groupId, egressAddress: address }, index);
    const slot = old?.ruleSlot ?? normalizeOptionalInteger(raw.ruleSlot, "规则分配槽位", 0, MAX_SOURCE_POLICY_GROUPS - 1) ?? nextFree(usedSlots, Array.from({ length: MAX_SOURCE_POLICY_GROUPS }, (_, item) => item)) ?? index;
    usedSlots.add(slot);
    const requestedKernelTable = normalizeOptionalInteger(raw.kernelTable, "内核路由表", SOURCE_POLICY_TABLE_MIN, SOURCE_POLICY_TABLE_MAX);
    const kernelTable = requestedKernelTable ?? old?.kernelTable ?? allocateKernelTable(usedTables);
    usedTables.add(kernelTable);
    return { ...normalized, ruleSlot: slot, kernelTable };
  });
  const usedBases = new Set(existing.filter((resource) => resource.id !== previous?.id && resource.id !== id).map((resource) => resource.rulePriorityBase));
  const rulePriorityBase = previous?.rulePriorityBase ?? normalizeOptionalInteger(input.rulePriorityBase, "规则优先级范围", SOURCE_POLICY_PRIORITY_MIN, SOURCE_POLICY_PRIORITY_MAX - SOURCE_POLICY_PRIORITY_WIDTH + 1) ?? allocatePriorityBase(id, usedBases);
  return normalizeSourcePolicyEgress({ ...input, id, groups, rulePriorityBase });
}

function token(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sourcePolicyNames(resource: SourcePolicyEgress, group: SourcePolicyEgressGroup): {
  table: string;
  staticProtocol: string;
  kernelProtocol: string;
  filter: string;
  pipe: string;
} {
  const suffix = token(`${resource.id}:${group.id}`);
  return {
    table: `bb_spe_t_${suffix}`,
    staticProtocol: `bb_spe_s_${suffix}`,
    kernelProtocol: `bb_spe_k_${suffix}`,
    filter: `bb_spe_f_${suffix}`,
    pipe: `bb_spe_p_${suffix}`,
  };
}

export function sourcePolicyRules(resource: SourcePolicyEgress): SourcePolicyRuleInstruction[] {
  return resource.groups.flatMap((group) => group.sources.map((source, index) => ({
    priority: resource.rulePriorityBase + group.ruleSlot * MAX_SOURCE_POLICY_SOURCES_PER_GROUP + index,
    source,
    table: group.kernelTable,
    egressAddress: group.egressAddress,
    groupId: group.id,
  })));
}

export function renderSourcePolicyEgress(
  resourceInput: unknown,
  internalDefineNames: readonly string[] = [],
): string {
  const resource = normalizeSourcePolicyEgress(resourceInput);
  if (!resource.enabled) return "";
  let output = `\n# birdbox-source-policy id=${resource.id} label=${resource.label}\n`;
  for (const group of resource.groups) {
    const names = sourcePolicyNames(resource, group);
    output += `\nipv4 table ${names.table};\n`;
    if (resource.copyInternalRoutes && internalDefineNames.length) {
      output += `\nfilter ${names.filter} {\n`;
      for (const define of internalDefineNames) output += `  if net ~ ${define} then accept;\n`;
      output += "  reject;\n}\n";
      output += `\nprotocol pipe ${names.pipe} {\n  table master4;\n  peer table ${names.table};\n  import none;\n  export filter ${names.filter};\n}\n`;
    }
    output += `\nprotocol static ${names.staticProtocol} {\n  ipv4 { table ${names.table}; };\n  igp table master4;\n  route 0.0.0.0/0 recursive ${group.egressAddress};\n}\n`;
    output += `\nprotocol kernel ${names.kernelProtocol} {\n  kernel table ${group.kernelTable};\n  ipv4 {\n    table ${names.table};\n    import none;\n    export all;\n  };\n}\n`;
  }
  return output;
}

function ruleKey(rule: SourcePolicyRuleInstruction): string {
  return `${rule.priority}|${rule.source}|${rule.table}`;
}

function shellRule(rule: SourcePolicyRuleInstruction, action: "add" | "del"): string {
  return `ip -4 rule ${action} priority ${rule.priority} from '${rule.source}' table ${rule.table}`;
}

function renderApplyScript(removeRules: readonly SourcePolicyRuleInstruction[], rules: readonly SourcePolicyRuleInstruction[]): string {
  const removals = new Map<string, SourcePolicyRuleInstruction>();
  for (const rule of [...removeRules, ...rules]) removals.set(ruleKey(rule), rule);
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "[ \"$(id -u)\" -eq 0 ] || { echo '请使用 root 身份执行此脚本' >&2; exit 1; }",
    "command -v ip >/dev/null 2>&1 || { echo '缺少 ip 命令' >&2; exit 1; }",
    "",
    "# 删除旧规则和目标规则，保证重复执行幂等。",
    ...[...removals.values()].map((rule) => `${shellRule(rule, "del")} 2>/dev/null || true`),
    "",
    "# 添加当前映射集规则。",
    ...rules.map((rule) => shellRule(rule, "add")),
    "ip route flush cache 2>/dev/null || true",
  ];
  return `${lines.join("\n")}\n`;
}

function renderCleanupScript(removeRules: readonly SourcePolicyRuleInstruction[]): string | null {
  if (!removeRules.length) return null;
  return `${[
    "#!/bin/sh",
    "set -eu",
    "[ \"$(id -u)\" -eq 0 ] || { echo '请使用 root 身份执行此脚本' >&2; exit 1; }",
    ...removeRules.map((rule) => `${shellRule(rule, "del")} 2>/dev/null || true`),
    "ip route flush cache 2>/dev/null || true",
    "",
  ].join("\n")}`;
}

function systemdPaths(resourceId: string): { unitName: string; unitPath: string; helperPath: string } {
  const unitName = "birdbox-source-policy-" + resourceId + ".service";
  return {
    unitName,
    unitPath: "/etc/systemd/system/" + unitName,
    helperPath: "/usr/local/lib/birdbox/source-policy-" + resourceId + ".sh",
  };
}

function uniqueRules(rules: readonly SourcePolicyRuleInstruction[]): SourcePolicyRuleInstruction[] {
  return [...new Map(rules.map((rule) => [ruleKey(rule), rule])).values()];
}

function renderSystemdHelperScript(
  removeRules: readonly SourcePolicyRuleInstruction[],
  rules: readonly SourcePolicyRuleInstruction[],
): string {
  const cleanupRules = uniqueRules([...removeRules, ...rules]);
  const argument = "$" + "{1:-apply}";
  return [
    "#!/bin/sh",
    "set -eu",
    "[ \"$(id -u)\" -eq 0 ] || { echo '请使用 root 身份执行此脚本' >&2; exit 1; }",
    "command -v ip >/dev/null 2>&1 || { echo '缺少 ip 命令' >&2; exit 1; }",
    "",
    "case \"" + argument + "\" in",
    "  apply)",
    "    # 删除旧规则和目标规则，保证更新、重启时幂等。",
    ...uniqueRules([...removeRules, ...rules]).map((rule) => "    " + shellRule(rule, "del") + " 2>/dev/null || true"),
    ...rules.map((rule) => "    " + shellRule(rule, "add")),
    "    ip route flush cache 2>/dev/null || true",
    "    ;;",
    "  cleanup)",
    ...cleanupRules.map((rule) => "    " + shellRule(rule, "del") + " 2>/dev/null || true"),
    "    ip route flush cache 2>/dev/null || true",
    "    ;;",
    "  *)",
    "    echo \"用法：$0 {apply|cleanup}\" >&2",
    "    exit 2",
    "    ;;",
    "esac",
    "",
  ].join("\n");
}

function renderSystemdUnit(resourceId: string): string {
  const paths = systemdPaths(resourceId);
  return [
    "[Unit]",
    "Description=Birdbox source-policy egress " + resourceId,
    "Wants=network-online.target",
    "After=network-online.target bird.service",
    "",
    "[Service]",
    "Type=oneshot",
    "ExecStart=" + paths.helperPath + " apply",
    "ExecStop=" + paths.helperPath + " cleanup",
    "RemainAfterExit=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function renderSystemdInstallScript(
  resourceId: string,
  removeRules: readonly SourcePolicyRuleInstruction[],
  rules: readonly SourcePolicyRuleInstruction[],
): string {
  const paths = systemdPaths(resourceId);
  const cleanupRules = uniqueRules([...removeRules, ...rules]);
  if (!rules.length) {
    return [
      "#!/bin/sh",
      "set -eu",
      "[ \"$(id -u)\" -eq 0 ] || { echo '请使用 root 身份执行此脚本' >&2; exit 1; }",
      "systemctl disable --now '" + paths.unitName + "' 2>/dev/null || true",
      ...cleanupRules.map((rule) => shellRule(rule, "del") + " 2>/dev/null || true"),
      "ip route flush cache 2>/dev/null || true",
      "rm -f '" + paths.helperPath + "' '" + paths.unitPath + "'",
      "systemctl daemon-reload",
      "",
    ].join("\n");
  }
  return [
    "#!/bin/sh",
    "set -eu",
    "[ \"$(id -u)\" -eq 0 ] || { echo '请使用 root 身份执行此脚本' >&2; exit 1; }",
    "install -d -m 0755 /usr/local/lib/birdbox",
    "cat > '" + paths.helperPath + "' <<'BIRDBOX_SOURCE_POLICY_HELPER'",
    renderSystemdHelperScript(removeRules, rules).trimEnd(),
    "BIRDBOX_SOURCE_POLICY_HELPER",
    "chmod 0755 '" + paths.helperPath + "'",
    "cat > '" + paths.unitPath + "' <<'BIRDBOX_SOURCE_POLICY_UNIT'",
    renderSystemdUnit(resourceId).trimEnd(),
    "BIRDBOX_SOURCE_POLICY_UNIT",
    "systemctl daemon-reload",
    "systemctl enable '" + paths.unitName + "'",
    "systemctl restart '" + paths.unitName + "'",
    "systemctl --no-pager --full status '" + paths.unitName + "'",
    "",
  ].join("\n");
}

export function sourcePolicyManualPlan(
  node: ManagedNode,
  current: SourcePolicyEgress | null,
  previous: SourcePolicyEgress | null,
  operation: SourcePolicyManualPlan["operation"],
  birdConfig: string,
): SourcePolicyManualPlan {
  const rules = current && current.enabled && resourceAppliesToNode(current, node.id) ? sourcePolicyRules(current) : [];
  // A disabled mapping never installs system rules, so it has nothing to clean up.
  const oldRules = previous?.enabled && resourceAppliesToNode(previous, node.id) ? sourcePolicyRules(previous) : [];
  const removeRules = oldRules;
  const platform = node.mainConfigPath === "/etc/bird.conf" ? "openwrt" : "linux";
  const applyScript = platform === "linux" && rules.length ? renderApplyScript(removeRules, rules) : null;
  const cleanupScript = renderCleanupScript(removeRules);
  const systemdUnit = platform === "linux" && rules.length
    ? renderSystemdUnit(current?.id ?? previous?.id ?? "source_policy")
    : null;
  const systemdInstallScript = platform === "linux" && (rules.length || removeRules.length)
    ? renderSystemdInstallScript(current?.id ?? previous?.id ?? "source_policy", removeRules, rules)
    : null;
  const instructions = platform === "openwrt"
    ? [
        "在 LuCI 的 Network -> Routing -> IPv4 Rules 中添加或更新以下规则。",
        "规则的 Priority、源地址和 Lookup table 必须与清单完全一致。",
        "完成后重新读取 BIRD 路由，确认对应表中存在递归默认路由。",
      ]
    : [
        "以 root 身份执行脚本；Birdbox 不会自动修改 ip rule。",
        "需要开机持久化时，可直接执行下方生成的 systemd 安装/更新脚本。",
        "执行后使用 ip -4 rule show 和 ip -4 route show table <table> 验证。",
      ];
  return {
    operation,
    resourceId: current?.id ?? previous?.id ?? "source_policy",
    resourceLabel: current?.label ?? previous?.label ?? "源地址出口映射",
    nodeId: node.id,
    nodeName: node.name,
    platform,
    birdConfig,
    rules,
    removeRules,
    applyScript,
    cleanupScript,
    systemdUnit,
    systemdInstallScript,
    instructions,
  };
}
