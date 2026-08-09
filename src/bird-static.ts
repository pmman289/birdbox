import type {
  AddressFamily,
  StaticProtocol,
  StaticRouteFilter,
  StaticRouteFilterOperation,
} from "../packages/contracts/src/inventory.js";
import {
  assertValidation,
  normalizeEnum,
  normalizeId,
  normalizeIPAddress,
  normalizeLabel,
  normalizeOptionalInteger,
} from "./bird-normalize-common.js";
import { isExactPrefix, normalizeBirdPrefixPattern } from "./bird-prefix.js";
import { normalizeBirdBlockSource } from "./bird-source.js";

type UnknownRecord = Record<string, unknown>;
type SetAttribute = "preference" | "igp_metric" | "bgp_local_pref" | "bgp_med" | "bgp_origin";
type IntegerSetAttribute = Exclude<SetAttribute, "bgp_origin">;

interface IntegerAttributeDefinition {
  kind: "integer";
  minimum: number;
  maximum: number;
}

interface OriginAttributeDefinition {
  kind: "origin";
}

const STATIC_ROUTE_ACTIONS = new Set(["blackhole", "reject", "unreachable", "prohibit"]);
const STATIC_CHANNEL_POLICIES = new Set(["all", "none"] as const);
const STATIC_ROUTE_FILTER_OPERATION_TYPES = new Set(["set", "community", "prepend"] as const);
const STATIC_ROUTE_FILTER_ATTRIBUTES = new Map<SetAttribute, IntegerAttributeDefinition | OriginAttributeDefinition>([
  ["preference", { kind: "integer", minimum: 0, maximum: 4294967295 }],
  ["igp_metric", { kind: "integer", minimum: 0, maximum: 4294967295 }],
  ["bgp_local_pref", { kind: "integer", minimum: 0, maximum: 4294967295 }],
  ["bgp_med", { kind: "integer", minimum: 0, maximum: 4294967295 }],
  ["bgp_origin", { kind: "origin" }],
]);
const STATIC_ROUTE_FILTER_COMMUNITY_LISTS = new Set(["standard", "large"] as const);
const STATIC_ROUTE_FILTER_COMMUNITY_OPERATIONS = new Set(["add", "delete", "empty"] as const);
const STATIC_ROUTE_FILTER_ORIGINS = new Set(["igp", "egp", "incomplete"] as const);
const MAX_STATIC_ROUTE_FILTER_CUSTOM_LENGTH = 8 * 1024;
const MAX_STATIC_ROUTE_FILTER_TOTAL_LENGTH = 256 * 1024;
const MAX_STATIC_ROUTE_FILTER_OPERATIONS = 32;

function record(value: unknown, message: string): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as UnknownRecord;
}

function normalizeRequiredEnum<Value extends string>(value: unknown, allowed: ReadonlySet<Value>, label: string): Value {
  const normalized = String(value ?? "").trim().toLowerCase() as Value;
  assertValidation(allowed.has(normalized), `${label}不合法`);
  return normalized;
}

function normalizeStaticRouteAction(value: unknown, family: AddressFamily, label = "Static 路由动作"): string {
  const action = String(value ?? "").trim().toLowerCase();
  assertValidation(STATIC_ROUTE_ACTIONS.has(action) || /^via\s+\S+$/i.test(action), `${label}不合法`);
  if (!action.startsWith("via ")) return action;
  const address = normalizeIPAddress(action.slice(4).trim(), `${label} via 地址`, family === "ipv4" ? 4 : 6);
  return `via ${address}`;
}

function normalizeStaticRouteActions(value: unknown, family: AddressFamily): Record<string, string> {
  if (value === null || value === undefined) return {};
  const input = record(value, "Static CIDR 动作必须是对象");
  const entries = Object.entries(input);
  assertValidation(entries.length <= 256, "Static CIDR 动作最多支持 256 个条目");
  const normalized: Record<string, string> = {};
  for (const [prefixInput, actionInput] of entries) {
    const prefix = normalizeBirdPrefixPattern(prefixInput, family === "ipv4" ? 4 : 6);
    assertValidation(isExactPrefix(prefix), `Static CIDR 条目必须是完整 CIDR: ${prefixInput}`);
    assertValidation(!Object.hasOwn(normalized, prefix), `Static CIDR 条目重复: ${prefix}`);
    normalized[prefix] = normalizeStaticRouteAction(actionInput, family, `Static CIDR ${prefix} 动作`);
  }
  return normalized;
}

function normalizeStaticRouteFilterOperation(inputValue: unknown, prefix: string, index: number): StaticRouteFilterOperation {
  const label = `Static CIDR ${prefix} 快捷操作 ${index + 1}`;
  const input = record(inputValue, `${label}必须是对象`);
  const type = normalizeRequiredEnum(input.type, STATIC_ROUTE_FILTER_OPERATION_TYPES, `${label}类型`);
  if (type === "set") {
    const attribute = String(input.attribute ?? "").trim().toLowerCase() as SetAttribute;
    const definition = STATIC_ROUTE_FILTER_ATTRIBUTES.get(attribute);
    assertValidation(definition, `${label}属性不合法`);
    if (definition.kind === "origin") {
      return {
        type,
        attribute: "bgp_origin",
        value: normalizeRequiredEnum(input.value, STATIC_ROUTE_FILTER_ORIGINS, `${label}值`),
      };
    }
    const value = normalizeOptionalInteger(input.value, `${label}值`, definition.minimum, definition.maximum);
    assertValidation(value !== null, `${label}值不能为空`);
    return { type, attribute: attribute as IntegerSetAttribute, value };
  }
  if (type === "community") {
    const list = normalizeEnum(input.list, STATIC_ROUTE_FILTER_COMMUNITY_LISTS, "standard", `${label} Community 类型`);
    const operation = normalizeEnum(input.operation, STATIC_ROUTE_FILTER_COMMUNITY_OPERATIONS, "add", `${label} Community 动作`);
    if (operation === "empty") return { type, list, operation };
    assertValidation(Array.isArray(input.value), `${label} Community 值必须是数组`);
    const expectedLength = list === "large" ? 3 : 2;
    const maximum = list === "large" ? 4294967295 : 65535;
    assertValidation(input.value.length === expectedLength, `${label} Community 必须包含 ${expectedLength} 个整数`);
    const community = input.value.map((part, partIndex) => {
      const normalized = normalizeOptionalInteger(part, `${label} Community 第 ${partIndex + 1} 段`, 0, maximum);
      assertValidation(normalized !== null, `${label} Community 第 ${partIndex + 1} 段不能为空`);
      return normalized;
    });
    return { type, list, operation, value: community };
  }
  const asn = normalizeOptionalInteger(input.asn, `${label} ASN`, 1, 4294967295);
  const count = normalizeOptionalInteger(input.count, `${label}次数`, 1, 20);
  assertValidation(asn !== null, `${label} ASN 不能为空`);
  assertValidation(count !== null, `${label}次数不能为空`);
  return { type, asn, count };
}

function normalizeStaticRouteFilter(inputValue: unknown, prefix: string): StaticRouteFilter {
  if (inputValue === null || inputValue === undefined) return { operations: [], custom: "" };
  const input = record(inputValue, `Static CIDR ${prefix} per-route 配置必须是对象`);
  const operationsInput = input.operations ?? [];
  assertValidation(Array.isArray(operationsInput), `Static CIDR ${prefix} 快捷操作必须是数组`);
  assertValidation(operationsInput.length <= MAX_STATIC_ROUTE_FILTER_OPERATIONS, `Static CIDR ${prefix} 快捷操作最多支持 ${MAX_STATIC_ROUTE_FILTER_OPERATIONS} 项`);
  const custom = normalizeBirdBlockSource(input.custom, `Static CIDR ${prefix} 自定义 per-route 源码`);
  assertValidation(Buffer.byteLength(custom, "utf8") <= MAX_STATIC_ROUTE_FILTER_CUSTOM_LENGTH, `Static CIDR ${prefix} 自定义 per-route 源码不能超过 8 KiB`);
  assertValidation(!(custom.startsWith("{") && custom.endsWith("}")), `Static CIDR ${prefix} 自定义 per-route 源码只填写块内容，不包含外层花括号`);
  return {
    operations: operationsInput.map((operation, index) => normalizeStaticRouteFilterOperation(operation, prefix, index)),
    custom,
  };
}

function normalizeStaticRouteFilters(value: unknown, family: AddressFamily): Record<string, StaticRouteFilter> {
  if (value === null || value === undefined) return {};
  const input = record(value, "Static CIDR per-route 配置必须是对象");
  const entries = Object.entries(input);
  assertValidation(entries.length <= 256, "Static CIDR per-route 配置最多支持 256 个条目");
  const normalized: Record<string, StaticRouteFilter> = {};
  for (const [prefixInput, filterInput] of entries) {
    const prefix = normalizeBirdPrefixPattern(prefixInput, family === "ipv4" ? 4 : 6);
    assertValidation(isExactPrefix(prefix), `Static CIDR per-route 条目必须是完整 CIDR: ${prefixInput}`);
    assertValidation(!Object.hasOwn(normalized, prefix), `Static CIDR per-route 条目重复: ${prefix}`);
    normalized[prefix] = normalizeStaticRouteFilter(filterInput, prefix);
  }
  assertValidation(Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_STATIC_ROUTE_FILTER_TOTAL_LENGTH, "单个 Static 的 per-route 配置不能超过 256 KiB");
  return normalized;
}

export function normalizeStaticProtocol(inputValue: unknown): StaticProtocol {
  const input = record(inputValue, "Static 资源参数不能为空");
  const family = normalizeEnum(input.family, new Set(["ipv4", "ipv6"] as const), "ipv4", "Static 地址族");
  const defineId = input.defineId === null || input.defineId === undefined || input.defineId === ""
    ? null
    : normalizeId(input.defineId, "Static CIDR Define ID");
  const action = input.action === null || input.action === undefined || input.action === ""
    ? null
    : normalizeStaticRouteAction(input.action, family, "静态路由动作");
  const routeActions = normalizeStaticRouteActions(input.routeActions, family);
  const routeFilters = normalizeStaticRouteFilters(input.routeFilters, family);
  assertValidation((defineId === null) === (action === null), "Static CIDR Define 与标准动作必须同时设置");
  assertValidation(defineId !== null || !Object.keys(routeActions).length, "未选择 Static CIDR Define 时不能设置逐条动作");
  assertValidation(defineId !== null || !Object.keys(routeFilters).length, "未选择 Static CIDR Define 时不能设置 per-route 配置");
  const raw = normalizeBirdBlockSource(input.raw, "额外 Static 指令");
  assertValidation(action !== null || raw, "Static 资源至少需要标准路由或自定义指令");
  const name = normalizeId(input.name, "Static 协议名称");
  assertValidation(!new Set(["birdbox_device", "birdbox_static", "birdbox_static4", "birdbox_static6", "birdbox_bfd"]).has(name), "Static 协议名称与 Birdbox 内部协议冲突");
  return {
    id: normalizeId(input.id, "Static 资源 ID"),
    nodeId: normalizeId(input.nodeId, "Static 所属节点 ID"),
    label: normalizeLabel(input.label ?? input.name, "Static 显示名称"),
    name,
    family,
    defineId,
    action,
    routeActions,
    routeFilters,
    import: normalizeEnum(input.import, STATIC_CHANNEL_POLICIES, "all", "Static Import 设置"),
    export: normalizeEnum(input.export, STATIC_CHANNEL_POLICIES, "none", "Static Export 设置"),
    raw,
    enabled: input.enabled !== false,
  };
}

export function staticRouteDefinitionSignature(action: string, routeFilter: StaticRouteFilter): string {
  return JSON.stringify({ action, ...routeFilter });
}
