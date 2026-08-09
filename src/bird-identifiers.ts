import { createHash } from "node:crypto";

import type { AddressFamily } from "../packages/contracts/src/inventory.js";

export function makeStaticProtocolName(family: AddressFamily, protocolName: string): string {
  const fullName = `birdbox_static${family === "ipv4" ? "4" : "6"}_${protocolName}`;
  if (fullName.length <= 64) return fullName;
  const digest = createHash("sha256").update(fullName).digest("hex").slice(0, 10);
  return `${fullName.slice(0, 64 - digest.length - 1)}_${digest}`;
}

export function birdIdentifiers(sourceInput: unknown): Set<string> {
  const source = String(sourceInput ?? "");
  let code = "";
  let quote: string | null = null;
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

export function birdSourceReferencesSymbol(source: unknown, symbol: unknown): boolean {
  return birdIdentifiers(source).has(String(symbol ?? ""));
}
