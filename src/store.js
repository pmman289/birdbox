import { promises as fs } from "node:fs";
import path from "node:path";

import {
  loadSeedNodes,
  normalizeDefine,
  normalizePeer,
  normalizeSession,
  saveJsonAtomic,
  validateInventory,
} from "./bird.js";

function safeLegacyId(prefix, value) {
  const normalized = String(value ?? "item").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
  return `${prefix}_${normalized || "item"}`;
}

function safeLegacySymbol(value) {
  const normalized = String(value ?? "PREFIXES").toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+/, "").slice(0, 48);
  return `PL_${normalized || "PREFIXES"}`;
}

function upgradeResourceOrder(resources) {
  return (resources ?? [])
    .map((resource, index) => ({ resource, index }))
    .sort((left, right) => (left.resource.order ?? left.index) - (right.resource.order ?? right.index) || left.index - right.index)
    .map(({ resource }) => {
      const { order, ...upgraded } = resource;
      return upgraded;
    });
}

function upgradeChannel(channel, defaults) {
  const value = channel ?? {};
  const legacyRouteAction = value.routeAction ?? null;
  const staticConfig = value.static ?? {
    defineId: legacyRouteAction === null ? null : (value.staticDefineId ?? value.exportDefineId ?? null),
    action: legacyRouteAction,
    raw: value.staticRaw ?? "",
  };
  const { routeAction, staticDefineId, staticRaw, ...upgradedValue } = value;
  return {
    enabled: value.enabled ?? true,
    ...upgradedValue,
    importPolicy: {
      ...(value.importPolicy ?? { mode: "form", steps: [], filterId: null }),
      formAction: value.importPolicy?.formAction ?? "all",
    },
    exportPolicy: {
      ...(value.exportPolicy ?? { mode: "form", steps: [], filterId: null }),
      formAction: value.exportPolicy?.formAction ?? (value.exportDefineId ? "cidr" : "none"),
    },
    exportDefineId: value.exportDefineId ?? null,
    static: {
      defineId: staticConfig.defineId ?? null,
      action: staticConfig.action ?? null,
      raw: staticConfig.raw ?? "",
    },
    ...defaults,
  };
}

function upgradeSessionV15(session, nodes) {
  const node = (nodes ?? []).find((item) => item.id === session.nodeId);
  const {
    multihop, ipv4, channels, exportDefineId, routeAction, importPolicy, exportPolicy,
    ...upgraded
  } = session;
  const upgradedChannels = channels
    ? {
        ipv4: upgradeChannel(channels.ipv4),
        ipv6: upgradeChannel(channels.ipv6),
      }
    : {
        ipv4: upgradeChannel({
          ...(ipv4 ?? {}),
          enabled: true,
          exportDefineId: exportDefineId ?? null,
          routeAction: routeAction ?? null,
          importPolicy,
          exportPolicy,
        }),
        ipv6: upgradeChannel({ enabled: true }),
      };
  return {
    ...upgraded,
    localPort: session.localPort ?? node?.listenPort ?? 179,
    bgp: {
      connectionMode: session.bgp?.connectionMode ?? (multihop === false ? "direct" : "multihop"),
      multihopTtl: session.bgp?.multihopTtl ?? 10,
      ...(session.bgp ?? {}),
    },
    channels: upgradedChannels,
  };
}

function upgradeInventory(input) {
  if (Number(input.version) >= 11) {
    return {
      ...input,
      version: 17,
      defines: upgradeResourceOrder(input.defines).map((item) => ({
        ...item,
        label: item.label ?? item.name,
        type: item.type === "cidr" ? "cidr4" : (item.type ?? "expression"),
      })),
      functions: upgradeResourceOrder(input.functions),
      filters: upgradeResourceOrder(input.filters),
      rpki: (input.rpki ?? []).map((item) => ({ ...item })),
      sessions: (input.sessions ?? []).map((session) => upgradeSessionV15(session, input.nodes)),
    };
  }
  const prefixLists = (input.prefixLists ?? []).map((item) => ({
    ...item,
    symbol: item.symbol ?? safeLegacySymbol(item.id ?? item.name),
  }));
  const sessions = (input.sessions ?? []).map((session) => {
    let upgraded = session;
    const missingPrefixListField = !Object.hasOwn(session, "prefixListId");
    if (missingPrefixListField || !session.localAddress || !session.localAsn) {
      const node = (input.nodes ?? []).find((item) => item.id === session.nodeId);
      const prefixListId = missingPrefixListField
        ? safeLegacyId("prefix", session.id ?? session.protocolName)
        : session.prefixListId;
      if (missingPrefixListField && !prefixLists.some((item) => item.id === prefixListId)) {
        prefixLists.push({
          id: prefixListId,
          nodeId: session.nodeId,
          name: `${session.protocolName} CIDRs`,
          symbol: safeLegacySymbol(session.protocolName),
          entries: [session.advertisePrefix],
        });
      }
      upgraded = {
        ...session,
        prefixListId,
        localAddress: session.localAddress ?? node?.address,
        localAsn: session.localAsn ?? node?.asn,
      };
    }
    const withRouteAction = Object.hasOwn(upgraded, "routeAction") ? upgraded : { ...upgraded, routeAction: "blackhole" };
    return {
      ...withRouteAction,
      importPolicy: withRouteAction.importPolicy ?? { mode: "form", steps: [], filterId: null },
      exportPolicy: withRouteAction.exportPolicy ?? { mode: "form", steps: [], filterId: null },
    };
  });
  return {
    ...input,
    version: 17,
    defines: [
      ...prefixLists.map((item) => ({
        id: item.id,
        nodeId: item.nodeId ?? null,
        label: item.name,
        name: item.symbol,
        type: "cidr4",
        entries: item.entries,
        enabled: true,
      })),
      ...upgradeResourceOrder(input.defines).map((item) => ({
        ...item,
        label: item.label ?? item.name,
        type: "expression",
      })),
    ],
    functions: upgradeResourceOrder(input.functions),
    filters: upgradeResourceOrder(input.filters),
    rpki: (input.rpki ?? []).map((item) => ({ ...item })),
    sessions: sessions.map(({ prefixListId, ...session }) => upgradeSessionV15({
      ...session,
      exportDefineId: prefixListId ?? null,
    }, input.nodes)),
  };
}

export class InventoryStore {
  constructor({ dataDir, nodesPath, legacySessionPath }) {
    this.inventoryPath = path.join(dataDir, "inventory.json");
    this.nodesPath = nodesPath;
    this.legacySessionPath = legacySessionPath;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const stored = JSON.parse(await fs.readFile(this.inventoryPath, "utf8"));
      const upgraded = upgradeInventory(stored);
      const normalized = validateInventory(upgraded);
      const missingResourceLabels = ["defines", "functions", "filters"].some((collection) =>
        (stored[collection] ?? []).some((resource) => !resource.label),
      );
      if (stored.version !== normalized.version || missingResourceLabels) await saveJsonAtomic(this.inventoryPath, normalized);
      return normalized;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const initial = await this.createInitialInventory();
      await this.write(initial);
      return initial;
    }
  }

  async createInitialInventory() {
    const nodes = await loadSeedNodes(this.nodesPath);
    const state = { version: 17, nodes, peers: [], defines: [], functions: [], filters: [], rpki: [], sessions: [] };
    try {
      const legacy = JSON.parse(await fs.readFile(this.legacySessionPath, "utf8"));
      const local = legacy.local ?? legacy.left;
      const remote = legacy.remote ?? legacy.right;
      if (!local || !remote) return validateInventory(state);
      const node = nodes.find((item) => item.id === local.nodeId) ?? nodes[0];
      const peer = normalizePeer({
        id: safeLegacyId("peer", remote.name ?? "external"),
        nodeId: node.id,
        name: remote.name ?? "External peer",
        address: remote.address,
        asn: remote.asn,
        port: remote.port ?? 179,
      });
      const exportDefine = normalizeDefine({
        id: safeLegacyId("prefix", legacy.name ?? "birdbox_peer"),
        nodeId: node.id,
        label: `${legacy.name ?? "birdbox_peer"} CIDRs`,
        name: safeLegacySymbol(legacy.name ?? "birdbox_peer"),
        type: "cidr4",
        entries: [local.advertisePrefix ?? "10.250.1.0/24"],
      });
      const session = normalizeSession({
        id: safeLegacyId("session", legacy.name ?? "birdbox_peer"),
        nodeId: node.id,
        peerId: peer.id,
        exportDefineId: exportDefine.id,
        protocolName: legacy.name ?? "birdbox_peer",
        localAddress: local.address,
        localAsn: local.asn,
        localPort: node.listenPort,
        routeAction: "blackhole",
        multihop: legacy.multihop,
        enabled: true,
      });
      state.peers.push(peer);
      state.defines.push(exportDefine);
      state.sessions.push(session);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return validateInventory(state);
  }

  async write(value) {
    const normalized = validateInventory(value);
    await saveJsonAtomic(this.inventoryPath, normalized);
    return normalized;
  }

  async mutate(mutator) {
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      const draft = structuredClone(current);
      const result = await mutator(draft);
      const state = await this.write(draft);
      return { state, result };
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
