import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  loadSeedNodes,
  normalizeDefine,
  normalizePeer,
  normalizeSession,
  validateInventory,
} from "./bird.js";

const INVENTORY_STATE_KEY = "inventory";
const CURRENT_INVENTORY_VERSION = 18;
const NORMALIZATION_RETRIES = 3;

function inventoryVersionError(version) {
  const error = new Error(`库存版本 ${version} 高于当前 Birdbox 支持的版本 ${CURRENT_INVENTORY_VERSION}，拒绝降级写入`);
  error.status = 409;
  error.code = "INVENTORY_VERSION_TOO_NEW";
  return error;
}

function assertSupportedInventoryVersion(input) {
  const version = Number(input?.version);
  if (Number.isFinite(version) && version > CURRENT_INVENTORY_VERSION) throw inventoryVersionError(version);
}

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
      import: staticConfig.import ?? "all",
      export: staticConfig.export ?? "none",
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
  assertSupportedInventoryVersion(input);
  if (Number(input.version) >= 11) {
    return {
      ...input,
      version: CURRENT_INVENTORY_VERSION,
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
    version: CURRENT_INVENTORY_VERSION,
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
  constructor({ database, dataDir, nodesPath, legacySessionPath, stateKey = INVENTORY_STATE_KEY }) {
    this.database = database;
    this.stateKey = stateKey;
    this.inventoryPath = path.join(dataDir, "inventory.json");
    this.nodesPath = nodesPath;
    this.legacySessionPath = legacySessionPath;
    this.revisions = new WeakMap();
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = this.#initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async #initialize() {
    await this.database.initialize();
    const existing = await this.database.readState(this.stateKey);
    if (!existing) {
      const initial = await this.loadLegacyInventory();
      await this.database.createState(this.stateKey, initial);
    }
    await this.#readNormalized();
  }

  async read() {
    await this.initialize();
    return this.#readNormalized();
  }

  async #readNormalized() {
    for (let attempt = 0; attempt < NORMALIZATION_RETRIES; attempt += 1) {
      let record = await this.database.readState(this.stateKey);
      const normalized = validateInventory(upgradeInventory(record.value));
      if (isDeepStrictEqual(normalized, record.value)) return this.#track(normalized, record.revision);
      try {
        record = await this.database.replaceState(this.stateKey, record.revision, normalized);
        return this.#track(normalized, record.revision);
      } catch (error) {
        if (error.code !== "STATE_CONFLICT" || attempt === NORMALIZATION_RETRIES - 1) throw error;
      }
    }
    throw new Error("库存规范化重试次数超限");
  }

  async loadLegacyInventory() {
    try {
      return validateInventory(upgradeInventory(JSON.parse(await fs.readFile(this.inventoryPath, "utf8"))));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return this.createInitialInventory();
    }
  }

  async createInitialInventory() {
    let nodes = [];
    try {
      nodes = await loadSeedNodes(this.nodesPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const state = { version: CURRENT_INVENTORY_VERSION, nodes, peers: [], defines: [], functions: [], filters: [], rpki: [], sessions: [] };
    try {
      const legacy = JSON.parse(await fs.readFile(this.legacySessionPath, "utf8"));
      const local = legacy.local ?? legacy.left;
      const remote = legacy.remote ?? legacy.right;
      if (!local || !remote || !nodes.length) return validateInventory(state);
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
    await this.initialize();
    const normalized = validateInventory(value);
    const current = await this.database.readState(this.stateKey);
    const written = await this.database.replaceState(this.stateKey, current.revision, normalized);
    return this.#track(normalized, written.revision);
  }

  async replace(current, value) {
    await this.initialize();
    const revision = this.revisions.get(current);
    if (!revision) {
      const error = new Error("无法确认库存版本，请刷新后重试");
      error.status = 409;
      error.code = "STATE_CONFLICT";
      throw error;
    }
    const normalized = validateInventory(value);
    try {
      const written = await this.database.replaceState(this.stateKey, revision, normalized);
      return this.#track(normalized, written.revision);
    } catch (error) {
      // MySQL may commit the CAS before a lost connection hides its response.
      // Confirm the durable value so callers do not roll back a committed deploy.
      try {
        const record = await this.database.readState(this.stateKey);
        if (record && isDeepStrictEqual(record.value, normalized)) {
          return this.#track(normalized, record.revision);
        }
      } catch {
        // Preserve the original write error when confirmation is unavailable.
      }
      throw error;
    }
  }

  async mutate(mutator) {
    await this.initialize();
    const operation = await this.database.mutateState(
      this.stateKey,
      { version: CURRENT_INVENTORY_VERSION, nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [], sessions: [] },
      async (current) => {
        const draft = structuredClone(validateInventory(upgradeInventory(current)));
        const result = await mutator(draft);
        const state = validateInventory(draft);
        return { value: state, result };
      },
    );
    return { state: this.#track(operation.value, operation.revision), result: operation.result };
  }

  #track(value, revision) {
    this.revisions.set(value, revision);
    return value;
  }
}
