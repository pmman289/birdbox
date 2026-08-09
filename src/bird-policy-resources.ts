import type { PolicyDefine, PolicyFilter, PolicyFunction } from "../packages/contracts/src/inventory.js";
import { assertValidation, normalizeId, normalizeLabel, normalizeResourceScope } from "./bird-normalize-common.js";
import { parseBirdPrefixEntries } from "./bird-prefix.js";

type UnknownRecord = Record<string, unknown>;
type PolicyKind = "function" | "filter";

const MAX_POLICY_SOURCE_LENGTH = 32 * 1024;
const RESERVED_PROTOCOL_NAMES = new Set(["birdbox_device", "birdbox_static", "birdbox_static4", "birdbox_static6", "birdbox_bfd"]);

function record(value: unknown, message: string): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as UnknownRecord;
}

function prefixFamily(type: string): 4 | 6 | null {
  return type === "cidr4" ? 4 : type === "cidr6" ? 6 : null;
}

function normalizeDefineValue(input: unknown): string {
  const value = String(input ?? "").replaceAll("\r\n", "\n").trim();
  assertValidation(value.length >= 1, "Define 表达式不能为空");
  assertValidation(value.length <= MAX_POLICY_SOURCE_LENGTH, "Define 表达式不能超过 32 KiB");
  assertValidation(!value.includes("\0"), "Define 表达式不能包含空字符");
  const pairs = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
  const openings = new Set(pairs.keys());
  const closings = new Set(pairs.values());
  const stack: string[] = [];
  let quote: string | null = null;
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
      assertValidation(end >= 0, "Define 表达式包含未结束的块注释");
      cursor = end + 1;
      continue;
    }
    assertValidation(character !== ";", "Define 表达式不能包含额外的顶层语句");
    if (character && openings.has(character)) stack.push(character);
    if (character && closings.has(character)) {
      const opening = stack.pop();
      assertValidation(opening && pairs.get(opening) === character, "Define 表达式的括号不匹配");
    }
  }
  assertValidation(quote === null && stack.length === 0, "Define 表达式没有完整结束");
  return value;
}

export function normalizeDefine(inputValue: unknown): PolicyDefine {
  const input = record(inputValue, "Define 参数不能为空");
  const name = normalizeId(input.name, "BIRD Define 名称");
  assertValidation(!RESERVED_PROTOCOL_NAMES.has(name), "Define 名称与 Birdbox 内部协议冲突");
  const requestedType = String(input.type ?? "expression").trim().toLowerCase();
  const type = requestedType === "cidr" ? "cidr4" : requestedType;
  assertValidation(type === "cidr4" || type === "cidr6" || type === "expression", "Define 类型不合法");
  const base = {
    id: normalizeId(input.id, "Define ID"),
    nodeId: normalizeResourceScope(input.nodeId),
    label: normalizeLabel(input.label ?? input.name, "Define 显示名称"),
    name,
    enabled: input.enabled !== false,
  };
  if (type === "expression") return { ...base, type, value: normalizeDefineValue(input.value) };
  return { ...base, type, entries: parseBirdPrefixEntries(input.entries, prefixFamily(type)) };
}

function skipBirdTrivia(source: string, start = 0): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor] ?? "")) {
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
      assertValidation(end >= 0, "策略源码包含未结束的块注释");
      cursor = end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function findDeclarationEnd(source: string, openingBrace: number): number {
  let depth = 0;
  let quote: string | null = null;
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
      assertValidation(end >= 0, "策略源码包含未结束的块注释");
      cursor = end + 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
      assertValidation(depth >= 0, "策略源码的花括号不匹配");
    }
  }
  throw new Error("策略源码缺少结束花括号");
}

function inspectPolicyDeclaration(sourceInput: unknown, kind: PolicyKind, name: string): { source: string; callable: boolean } {
  const source = String(sourceInput ?? "").replaceAll("\r\n", "\n").trim();
  assertValidation(source.length >= 1, "策略源码不能为空");
  assertValidation(source.length <= MAX_POLICY_SOURCE_LENGTH, "单个策略源码不能超过 32 KiB");
  assertValidation(!source.includes("\0"), "策略源码不能包含空字符");
  const start = skipBirdTrivia(source);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = kind === "function"
    ? new RegExp(`^function\\s+${escapedName}\\s*\\(([^)]*)\\)\\s*\\{`)
    : new RegExp(`^filter\\s+${escapedName}\\s*\\{`);
  const match = headerPattern.exec(source.slice(start));
  assertValidation(match, `源码必须以完整的 ${kind === "function" ? "function" : "filter"} ${name} 声明开始`);
  const openingBrace = start + match[0].lastIndexOf("{");
  const end = findDeclarationEnd(source, openingBrace);
  assertValidation(skipBirdTrivia(source, end) === source.length, "一个策略资源只能包含一条顶层声明");
  return { source, callable: kind === "function" && (match[1] ?? "").trim() === "" };
}

function normalizePolicyResource(inputValue: unknown, kind: PolicyKind): PolicyFunction | PolicyFilter {
  const noun = kind === "function" ? "Function" : "Filter";
  const input = record(inputValue, `${noun} 参数不能为空`);
  const name = normalizeId(input.name, `BIRD ${noun} 名称`);
  const label = normalizeLabel(input.label ?? input.name, `${noun} 显示名称`);
  assertValidation(!RESERVED_PROTOCOL_NAMES.has(name), "策略名称与 Birdbox 内部协议冲突");
  const declaration = inspectPolicyDeclaration(input.source, kind, name);
  const base = {
    id: normalizeId(input.id, `${noun} ID`),
    nodeId: normalizeResourceScope(input.nodeId),
    label,
    name,
    source: declaration.source,
    enabled: input.enabled !== false,
  };
  return kind === "function" ? { ...base, callable: declaration.callable } : base;
}

export function normalizePolicyFunction(input: unknown): PolicyFunction {
  return normalizePolicyResource(input, "function") as PolicyFunction;
}

export function normalizePolicyFilter(input: unknown): PolicyFilter {
  return normalizePolicyResource(input, "filter") as PolicyFilter;
}
