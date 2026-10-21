import { pinyin } from "pinyin-pro";

import type { Inventory } from "@birdbox/contracts/inventory";

function birdNameSlug(label: string): string {
  return pinyin(label.trim(), { toneType: "none", type: "array", nonZh: "consecutive" }).join("_")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function usedBirdNames(inventory: Inventory, excluded: string[] = []): Set<string> {
  const excludedSet = new Set(excluded);
  return new Set([
    ...inventory.defines.map((resource) => resource.name),
    ...inventory.functions.map((resource) => resource.name),
    ...inventory.filters.map((resource) => resource.name),
    ...inventory.rpki.flatMap((resource) => [resource.name, resource.roa4Table, resource.roa6Table]),
    ...inventory.staticProtocols.map((resource) => resource.name),
    ...(inventory.directProtocols ?? []).map(resource => resource.name),
    ...(inventory.kernelProtocols ?? []).flatMap(resource => [resource.name, ...(resource.ipv4 && resource.ipv6 ? [`${resource.name}4`, `${resource.name}6`] : []), ...Object.values(resource.tables ?? {}).map(table => table.name)]),
    ...(inventory.pipeProtocols ?? []).flatMap(resource => [resource.name, resource.table.name, resource.peerTable.name]),
    ...(inventory.sourcePolicies ?? []).map((resource) => resource.id),
    ...inventory.sessions.map((session) => session.protocolName),
  ].filter((name): name is string => typeof name === "string" && name.length > 0 && !excludedSet.has(name)));
}

export function uniqueBirdName(
  inventory: Inventory,
  prefix: string,
  label: string,
  excluded: string[] = [],
  maxLength = 64,
): string {
  const used = usedBirdNames(inventory, excluded);
  const slug = birdNameSlug(label) || "resource";
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `_${index}`;
    const room = Math.max(1, maxLength - prefix.length - 1 - suffix.length);
    const candidate = `${prefix}_${slug.slice(0, room)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
