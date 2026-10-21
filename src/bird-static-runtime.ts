import type { StaticRuntimeResponse } from "../packages/contracts/src/api.js";

/** Static has no neighbor handshake: read the actual protocol state and channel counters. */
export function parseStaticRuntime(raw: string, name: string): Pick<StaticRuntimeResponse, "state" | "imported" | "exported"> {
  const lines = raw.replace(/\r/g, "").split("\n");
  const index = lines.findIndex(line => new RegExp(`^(?:1002[- ])?${name}\\s+Static\\s+`).test(line));
  if (index < 0) return { state: "not_configured", imported: null, exported: null };
  const next = lines.findIndex((line, i) => i > index && /^1002[- ]\S/.test(line));
  const block = lines.slice(index, next < 0 ? undefined : next).join("\n");
  const header = lines[index]!;
  const state = header.match(/\bStatic\s+\S+\s+(\S+)/)?.[1]?.toLowerCase();
  const counts = block.match(/Routes:\s+(\d+) imported,\s+(\d+) exported/);
  return {
    state: /\bdisabled\b/i.test(header) ? "disabled" : state === "up" || state === "down" || state === "start" ? state : "unknown",
    imported: counts ? Number(counts[1]) : null,
    exported: counts ? Number(counts[2]) : null,
  };
}
