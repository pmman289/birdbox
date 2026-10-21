export function birdIdentifierList(sourceInput: unknown): string[] {
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
    if (character === "'") {
      // BIRD single quotes delimit symbols; double quotes delimit strings.
      // Only complete names that Birdbox can manage participate in this graph.
      let end = cursor + 1;
      while (end < source.length && source[end] !== "'") {
        if (source[end] === "\\") end++;
        end++;
      }
      const name = source.slice(cursor + 1, end);
      code += end < source.length && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? ` ${name} ` : " ";
      cursor = end;
      continue;
    }
    if (character === "\"") {
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
  return code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

export function birdIdentifiers(sourceInput: unknown): Set<string> {
  return new Set(birdIdentifierList(sourceInput));
}

export function birdSourceReferencesSymbol(source: unknown, symbol: unknown): boolean {
  return birdIdentifiers(source).has(String(symbol ?? ""));
}
