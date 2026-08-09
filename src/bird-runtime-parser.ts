import net from "node:net";

import type {
  AddressFamily,
} from "../packages/contracts/src/inventory.js";
import type {
  ProtocolChannelRuntime,
  ProtocolRuntime,
  RouteDetail,
} from "../packages/contracts/src/api.js";

type ProtocolStatus = Omit<ProtocolRuntime, "name">;

interface ParsedRouteDetails {
  family: AddressFamily;
  table: string | null;
  routes: RouteDetail[];
  truncated: boolean;
  limit: number;
}

interface PendingRoute extends Omit<RouteDetail, "details"> {
  details: string[];
}

function validationError(message: string): never {
  const error = new Error(message) as Error & { status: number };
  error.status = 400;
  throw error;
}

function routeCount(
  channels: ProtocolChannelRuntime[],
  key: "imported" | "exported",
): number | null {
  return channels.some((channel) => channel[key] !== null)
    ? channels.reduce((total, channel) => total + (channel[key] ?? 0), 0)
    : null;
}

export function parseProtocolStatus(raw: unknown): ProtocolStatus {
  const text = String(raw ?? "");
  const header = text.match(/^1002-[^\s]+\s+BGP\b[^\r\n]*$/m)?.[0] ?? "";
  const state = text.match(/BGP state:\s+([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const bgpSection = state ? text.slice(text.search(/BGP state:/i)) : text;
  const neighbor = text.match(/Neighbor address:\s+([^\s]+)/i)?.[1] ?? null;
  const neighborAs = text.match(/Neighbor AS:\s+(\d+)/i)?.[1] ?? null;
  const channelHeaders = [...text.matchAll(/^(?:\d{4}[- ]?)?\s*Channel\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/gmi)];
  const channelEntries: Array<[string, ProtocolChannelRuntime]> = [];

  for (let index = 0; index < channelHeaders.length; index += 1) {
    const match = channelHeaders[index];
    const name = match?.[1];
    if (!match || !name || match.index === undefined) continue;
    const end = channelHeaders[index + 1]?.index ?? text.length;
    const section = text.slice(match.index, end);
    const routeCounts = section.match(/Routes:\s+(\d+) imported,\s+(\d+) exported(?:,\s+(\d+) preferred)?/i);
    channelEntries.push([name.toLowerCase(), {
      state: section.match(/State:\s+([^\r\n]+)/i)?.[1]?.trim() ?? null,
      table: section.match(/Table:\s+([^\s]+)/i)?.[1] ?? null,
      imported: routeCounts ? Number(routeCounts[1]) : null,
      exported: routeCounts ? Number(routeCounts[2]) : null,
      preferred: routeCounts?.[3] ? Number(routeCounts[3]) : null,
    }]);
  }

  const channels = Object.fromEntries(channelEntries);
  const fallbackRoutes = bgpSection.match(/Routes:\s+(\d+) imported,\s+(\d+) exported/i);
  const channelValues = Object.values(channels);
  return {
    configured: text.length > 0 && !/Unable to connect/i.test(text),
    disabled: /\b(?:Admin down|Disabled)\b/i.test(header),
    state,
    established: state?.toLowerCase() === "established",
    neighbor,
    neighborAs: neighborAs ? Number(neighborAs) : null,
    imported: channelValues.length ? routeCount(channelValues, "imported") : (fallbackRoutes ? Number(fallbackRoutes[1]) : null),
    exported: channelValues.length ? routeCount(channelValues, "exported") : (fallbackRoutes ? Number(fallbackRoutes[2]) : null),
    ...(channelValues.length ? { channels } : {}),
  };
}

export function parseProtocolStatuses(raw: unknown): ProtocolRuntime[] {
  const text = String(raw ?? "");
  const headers = [...text.matchAll(/^1002-([^\s]+)\s+BGP\b/gm)];
  return headers.flatMap((match, index) => {
    const name = match[1];
    if (!name || match.index === undefined) return [];
    const end = headers[index + 1]?.index ?? text.length;
    return [{ name, ...parseProtocolStatus(text.slice(match.index, end)) }];
  });
}

export function parseRouteDetails(raw: unknown, family: AddressFamily, limit = 200): ParsedRouteDetails {
  if (family !== "ipv4" && family !== "ipv6") validationError("路由地址族不合法");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) validationError("路由明细数量限制不合法");
  const expectedFamily = family === "ipv4" ? 4 : 6;
  const routes: RouteDetail[] = [];
  let current: PendingRoute | null = null;
  let table: string | null = null;
  let truncated = false;
  const pushCurrent = (): void => {
    if (!current) return;
    routes.push({ ...current, details: current.details.join("\n").trim() });
    current = null;
  };

  for (const inputLine of String(raw ?? "").split(/\r?\n/)) {
    if (inputLine.trim() === "---BIRDBOX-ROUTE-TRUNCATED---") {
      truncated = true;
      continue;
    }
    const line = inputLine.replace(/^\d{4}[- ]/, "");
    const tableMatch = line.match(/^Table\s+([^:]+):\s*$/i);
    if (tableMatch?.[1]) {
      table = tableMatch[1].trim();
      continue;
    }
    if (/^BIRD\s+\S+\s+ready\.?$/i.test(line.trim()) || /^\d{4}\s*$/.test(line.trim())) continue;
    const routeMatch = line.match(/^\s*([0-9A-Fa-f:.]+\/(\d+))\s+(.+)$/);
    const prefix = routeMatch?.[1];
    if (prefix && net.isIP(prefix.slice(0, prefix.lastIndexOf("/"))) === expectedFamily) {
      pushCurrent();
      if (routes.length >= limit) {
        truncated = true;
        continue;
      }
      current = { prefix, summary: routeMatch[3]?.trim() ?? "", details: [] };
      continue;
    }
    if (current && line.trim()) current.details.push(line.trimEnd());
  }
  pushCurrent();
  return { family, table, routes, truncated, limit };
}
