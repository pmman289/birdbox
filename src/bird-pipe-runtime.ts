import type { PipeChannelRuntime, PipeRuntimeResponse } from "../packages/contracts/src/api.js";

export function parsePipeRuntime(raw: string, name: string): Pick<PipeRuntimeResponse["nodes"][number], "state" | "primary" | "peer"> {
  const empty = (): PipeChannelRuntime => ({ table: null, state: null, imported: null, exported: null });
  const lines = raw.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^(?:1002[- ])?${name}\\s+Pipe\\s+`).test(line));
  if (start < 0) return { state: "not_configured", primary: empty(), peer: empty() };
  const end = lines.findIndex((line, index) => index > start && /^1002[- ]\S/.test(line));
  const block = lines.slice(start, end < 0 ? undefined : end).join("\n");
  const headerState = lines[start]?.match(/\bPipe\s+\S+\s+(\S+)/)?.[1]?.toLowerCase();
  const state = /\b(?:disabled|admin down)\b/i.test(lines[start] ?? "") ? "disabled"
    : headerState === "up" || headerState === "down" || headerState === "start" ? headerState : "unknown";
  const counts = block.match(/Routes:\s+(\d+) imported,\s+(\d+) exported/);
  return {
    state,
    primary: {
      table: block.match(/^\s+Table:\s+(\S+)/m)?.[1] ?? null,
      state: block.match(/Import state:\s+(\S+)/)?.[1] ?? null,
      imported: counts ? Number(counts[1]) : null, exported: counts ? Number(counts[2]) : null,
    },
    // BIRD 2 exposes one main channel, not a second independently measured channel.
    peer: { ...empty(), table: block.match(/Peer table:\s+(\S+)/)?.[1] ?? null },
  };
}
