import net from "node:net";

type IpFamily = 4 | 6;

const PREFIX_PATTERN_RE = /^(.+)\/(\d{1,3})(?:(\+|-)|\{(\d{1,3}),(\d{1,3})\})?$/;

function validationError(message: string): never {
  const error = new Error(message) as Error & { status: number };
  error.status = 400;
  throw error;
}

export function isExactPrefix(pattern: string): boolean {
  return /^.+\/\d{1,3}$/.test(pattern);
}

export function normalizeBirdPrefixPattern(value: unknown, expectedFamily: IpFamily | null = null): string {
  const pattern = String(value ?? "").replace(/\s+/g, "");
  const match = PREFIX_PATTERN_RE.exec(pattern);
  const address = match?.[1];
  const family = address ? net.isIP(address) : 0;
  if (!match || family === 0) validationError(`无效的 BIRD IP 前缀模式: ${String(value)}`);
  if (expectedFamily !== null && family !== expectedFamily) {
    validationError(`CIDR 条目必须是 IPv${expectedFamily}: ${String(value)}`);
  }
  const maximum = family === 4 ? 32 : 128;
  const prefixLength = Number(match[2]);
  if (prefixLength > maximum) validationError(`前缀长度超出 IPv${family} 范围: ${String(value)}`);
  if (match[4] !== undefined) {
    const low = Number(match[4]);
    const high = Number(match[5]);
    if (low > maximum || high > maximum) {
      validationError(`无效的前缀长度范围，超出 IPv${family} 范围: ${String(value)}`);
    }
    if (low > high) validationError(`前缀长度范围必须从小到大: ${String(value)}`);
  }
  return pattern;
}

export function parseBirdPrefixEntries(value: unknown, expectedFamily: IpFamily | null = null): string[] {
  let entries: string[];
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
  if (entries.length < 1) validationError("CIDR 列表至少需要一个条目");
  if (entries.length > 256) validationError("单个 CIDR 列表最多支持 256 个条目");
  if (new Set(entries).size !== entries.length) validationError("CIDR 列表包含重复条目");
  return entries;
}
