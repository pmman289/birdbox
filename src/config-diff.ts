/** A bounded, order-sensitive view of the changed region in generated config. */
export function configDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (start < endA && start < endB && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const lines = ["--- 当前配置", "+++ 候选配置", ...a.slice(Math.max(0, start - 2), start).map(line => `  ${line}`), ...a.slice(start, endA).map(line => `- ${line}`), ...b.slice(start, endB).map(line => `+ ${line}`), ...a.slice(endA, endA + 2).map(line => `  ${line}`)];
  return lines.length <= 1000 ? lines.join("\n") : [...lines.slice(0, 1000), `…差异共 ${lines.length} 行；完整配置见预览`].join("\n");
}
