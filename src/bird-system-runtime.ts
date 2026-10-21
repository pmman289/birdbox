import type { SystemProtocolRuntimeResponse } from "../packages/contracts/src/api.js";

/** Direct/Kernel have no BGP-style neighbor session. Read only their own protocol block. */
export function parseSystemProtocolRuntime(raw: string, name: string, kind: "Direct" | "Kernel" | "Static" | "Pipe"): Pick<SystemProtocolRuntimeResponse["nodes"][number]["protocols"][number], "state" | "imported" | "exported"> {
  const lines = raw.replace(/\r/g, "").split("\n");
  const header = new RegExp(`^(?:\\d{4}[- ])?${name}\\s+${kind}\\s+\\S+\\s+(\\S+)`, "i");
  const index = lines.findIndex(line => header.test(line));
  if (index < 0) return { state: "not_configured", imported: null, exported: null };
  let imported = 0, exported = 0, hasCounts = false;
  for (const line of lines.slice(index + 1)) {
    if (/^(?:\d{4}[- ])?\S+\s+(?:Direct|Kernel|BGP|Pipe|Static|OSPF|RPKI|Device|BFD)\s+\S+\s+\S+/i.test(line)) break;
    const counts = line.match(/Routes:\s+(\d+) imported,\s+(\d+) exported/);
    if (counts) { hasCounts = true; imported += Number(counts[1]); exported += Number(counts[2]); }
  }
  const value = lines[index]!.match(header)![1]!.toLowerCase();
  const state = /\bdisabled\b/i.test(lines[index]!) ? "disabled" : value === "up" || value === "down" || value === "start" ? value : "unknown";
  return { state, imported: hasCounts ? imported : null, exported: hasCounts ? exported : null };
}
