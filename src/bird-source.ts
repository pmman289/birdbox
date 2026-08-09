import { assertValidation } from "./bird-normalize-common.js";

const MAX_POLICY_SOURCE_LENGTH = 32 * 1024;

export function normalizeBirdBlockSource(value: unknown, label: string): string {
  const source = String(value ?? "").replaceAll("\r\n", "\n").trim();
  assertValidation(source.length <= MAX_POLICY_SOURCE_LENGTH, `${label}不能超过 32 KiB`);
  assertValidation(!source.includes("\0"), `${label}不能包含空字符`);
  let depth = 0;
  let quote: string | null = null;
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
      assertValidation(end >= 0, `${label}包含未结束的块注释`);
      cursor = end + 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      assertValidation(depth > 0, `${label}不能结束外层配置块`);
      depth -= 1;
    }
  }
  assertValidation(quote === null && depth === 0, `${label}的引号或花括号没有完整结束`);
  return source;
}
