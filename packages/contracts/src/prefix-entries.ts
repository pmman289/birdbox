/** Split a prefix list without interpreting or discarding invalid input.
 * In particular, commas within BIRD length ranges belong to the prefix.
 * Validation and normalization remain the server's responsibility. */
export function splitBirdPrefixEntries(value: string): string[] {
  let source = value.trim();
  if (source.startsWith("[") && source.endsWith("]")) source = source.slice(1, -1);
  const entries: string[] = [];
  let start = 0, depth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "{") depth++;
    if (character === "}") depth--;
    if ((character === "," || character === ";" || character === "\n") && depth === 0) {
      const entry = source.slice(start, index).trim();
      if (entry) entries.push(entry);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) entries.push(tail);
  return entries;
}
