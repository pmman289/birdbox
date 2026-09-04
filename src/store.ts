import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  BgpSession,
  Inventory,
  ManagedNode,
  Peer,
  PolicyDefine,
} from "../packages/contracts/src/inventory.js";

import {
  loadSeedNodes,
  makeStaticProtocolName,
  normalizeDefine,
  normalizePeer,
  normalizeSession,
  validateInventory,
} from "./bird.js";
import type { BirdboxError, StateDatabase } from "./database.js";

type LegacyRecord = Record<string, unknown>;

interface InventoryStoreOptions {
  database: StateDatabase;
  dataDir: string;
  nodesPath: string;
  legacySessionPath: string;
  stateKey?: string;
}

function optionalRecord(value: unknown): LegacyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LegacyRecord : {};
}

function requiredRecord(value: unknown, label: string): LegacyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as LegacyRecord;
}

function recordArray(value: unknown, label: string): LegacyRecord[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value.map((item) => requiredRecord(item, `${label}条目`));
}

function normalizeInventory(value: unknown): Inventory {
  return validateInventory(value) as Inventory;
}

function normalizeStoredInventory(value: unknown): Inventory {
  return validateInventory(value, { allowInvalidResourceDependencies: true }) as Inventory;
}

const INVENTORY_STATE_KEY = "inventory";
const CURRENT_INVENTORY_VERSION = 28;
const NORMALIZATION_RETRIES = 3;

function inventoryVersionError(version: number): BirdboxError {
  const error = new Error(`库存版本 ${version} 高于当前 Birdbox 支持的版本 ${CURRENT_INVENTORY_VERSION}，拒绝降级写入`) as BirdboxError;
  error.status = 409;
  error.code = "INVENTORY_VERSION_TOO_NEW";
  return error;
}

function assertSupportedInventoryVersion(input: LegacyRecord): void {
  const version = Number(input.version);
  if (Number.isFinite(version) && version > CURRENT_INVENTORY_VERSION) throw inventoryVersionError(version);
}

function safeLegacyId(prefix: string, value: unknown): string {
  const normalized = String(value ?? "item").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
  return `${prefix}_${normalized || "item"}`;
}

function safeLegacySymbol(value: unknown): string {
  const normalized = String(value ?? "PREFIXES").toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+/, "").slice(0, 48);
  return `PL_${normalized || "PREFIXES"}`;
}

function upgradeResourceOrder(resources: unknown): LegacyRecord[] {
  return recordArray(resources, "策略资源")
    .map((resource, index) => ({ resource, index }))
    .sort((left, right) => Number(left.resource.order ?? left.index) - Number(right.resource.order ?? right.index) || left.index - right.index)
    .map(({ resource }) => {
      const { order, ...upgraded } = resource;
      return upgraded;
    });
}

function upgradeIbgpDomains(domainsInput: unknown, sourceVersion: unknown): LegacyRecord[] {
  return recordArray(domainsInput, "iBGP 域").map((domain) => {
    const members = recordArray(domain.members, "iBGP 域成员").map((member) => {
      if (Number(sourceVersion) >= 23) return { ...member };
      const { address4, address6, ...rest } = member;
      return { ...rest, address: member.address ?? address4 ?? address6 };
    });
    if (Number(sourceVersion) >= 23) return { ...domain, members };
    const { families, ...rest } = domain;
    return { ...rest, members };
  });
}

function upgradeChannel(channel: unknown, defaults: LegacyRecord = {}): LegacyRecord {
  const value = optionalRecord(channel);
  const legacyRouteAction = value.routeAction ?? null;
  const staticConfig = value.static && typeof value.static === "object" && !Array.isArray(value.static)
    ? value.static as LegacyRecord
    : {
    defineId: legacyRouteAction === null ? null : (value.staticDefineId ?? value.exportDefineId ?? null),
    action: legacyRouteAction,
    raw: value.staticRaw ?? "",
      };
  const { routeAction, staticDefineId, staticRaw, ...upgradedValue } = value;
  return {
    enabled: value.enabled ?? true,
    ...upgradedValue,
    importPolicy: {
      ...optionalRecord(value.importPolicy ?? { mode: "form", steps: [], filterId: null }),
      formAction: optionalRecord(value.importPolicy).formAction ?? "all",
    },
    exportPolicy: {
      ...optionalRecord(value.exportPolicy ?? { mode: "form", steps: [], filterId: null }),
      formAction: optionalRecord(value.exportPolicy).formAction ?? (value.exportDefineId ? "cidr" : "none"),
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

function upgradeSessionV15(sessionInput: unknown, nodesInput: unknown): LegacyRecord {
  const session = requiredRecord(sessionInput, "历史会话");
  const nodes = recordArray(nodesInput, "历史节点");
  const node = nodes.find((item) => item.id === session.nodeId);
  const {
    multihop, ipv4, channels, exportDefineId, routeAction, importPolicy, exportPolicy,
    ...upgraded
  } = session;
  const channelRecords = optionalRecord(channels);
  const upgradedChannels = channels
    ? {
        ipv4: upgradeChannel(channelRecords.ipv4),
        ipv6: upgradeChannel(channelRecords.ipv6),
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
    sessionType: session.sessionType === "ibgp" ? "ibgp" : "ebgp",
    localPort: session.localPort ?? node?.listenPort ?? 179,
    bgp: {
      connectionMode: optionalRecord(session.bgp).connectionMode ?? (multihop === false ? "direct" : "multihop"),
      multihopTtl: optionalRecord(session.bgp).multihopTtl ?? 10,
      ...optionalRecord(session.bgp),
    },
    channels: upgradedChannels,
  };
}

function migrateSessionStatics(sessionsInput: unknown, existingStaticProtocols: unknown, sourceVersion: unknown): {
  sessions: LegacyRecord[];
  staticProtocols: LegacyRecord[];
} {
  const sessions = recordArray(sessionsInput, "历史会话");
  const staticProtocols = recordArray(existingStaticProtocols, "历史 Static 资源").map((item) => ({ ...item }));
  const usedIds = new Set(staticProtocols.map((item) => item.id));
  const uniqueStaticId = (sessionId: unknown, family: string): string => {
    const base = safeLegacyId("static", `${sessionId}_${family}`);
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) candidate = `${base.slice(0, 60 - String(suffix).length)}_${suffix++}`;
    usedIds.add(candidate);
    return candidate;
  };
  const migratedSessions = sessions.map((session) => ({
    ...session,
    channels: Object.fromEntries(Object.entries(requiredRecord(session.channels, "历史会话 Channels")).map(([family, channelInput]) => {
      if (family !== "ipv4" && family !== "ipv6") throw new Error(`历史会话 Channel 地址族不合法: ${family}`);
      const channel = requiredRecord(channelInput, "历史会话 Channel");
      const { static: legacyStaticInput, ...sessionChannel } = channel;
      const legacyStatic = optionalRecord(legacyStaticInput);
      const shouldMigrate = Number(sourceVersion) < 19 && legacyStatic && (legacyStatic.action || String(legacyStatic.raw ?? "").trim());
      if (shouldMigrate) {
        staticProtocols.push({
          id: uniqueStaticId(session.id, family),
          nodeId: session.nodeId,
          label: `${session.protocolName} ${family.toUpperCase()} Static`,
          name: makeStaticProtocolName(family, String(session.protocolName ?? "static")),
          family,
          defineId: legacyStatic.action ? (legacyStatic.defineId ?? null) : null,
          action: legacyStatic.action ?? null,
          import: legacyStatic.import ?? "all",
          export: legacyStatic.export ?? "none",
          raw: legacyStatic.raw ?? "",
          enabled: session.enabled !== false && channel.enabled !== false,
        });
      }
      return [family, sessionChannel];
    })),
  }));
  return { sessions: migratedSessions, staticProtocols };
}

function upgradeInventory(input: unknown): LegacyRecord {
  const source = requiredRecord(input, "库存数据");
  assertSupportedInventoryVersion(source);
  if (Number(source.version) >= 11) {
    const migrated = migrateSessionStatics(
      recordArray(source.sessions, "会话").map((session) => upgradeSessionV15(session, source.nodes)),
      source.staticProtocols,
      source.version,
    );
    return {
      ...source,
      version: CURRENT_INVENTORY_VERSION,
      // A missing value intentionally stays null. Existing session/member
      // addresses remain authoritative and must not be inferred from Router ID.
      nodes: recordArray(source.nodes, "节点").map((item) => ({ ...item, igpAddress: item.igpAddress ?? null })),
      defines: upgradeResourceOrder(source.defines).map((item) => ({
        ...item,
        label: item.label ?? item.name,
        type: item.type === "cidr" ? "cidr4" : (item.type ?? "expression"),
        ...(item.type === "expression" ? {} : { entrySource: item.entrySource ?? item.source ?? { kind: "manual" } }),
      })),
      functions: upgradeResourceOrder(source.functions),
      filters: upgradeResourceOrder(source.filters),
      rpki: recordArray(source.rpki, "RPKI 资源").map((item) => ({ ...item })),
      staticProtocols: migrated.staticProtocols.map((item) => ({ ...item, routeFilters: item.routeFilters ?? {} })),
      sourcePolicies: recordArray(source.sourcePolicies, "源地址出口映射").map((item) => ({ ...item })),
      sessions: migrated.sessions,
      ibgpDomains: upgradeIbgpDomains(source.ibgpDomains, source.version),
      ospfDomains: recordArray(source.ospfDomains, "OSPF 域").map((item) => ({ ...item })),
    };
  }
  const prefixLists: LegacyRecord[] = recordArray(source.prefixLists, "历史 Prefix List").map((item) => ({
    ...item,
    symbol: item.symbol ?? safeLegacySymbol(item.id ?? item.name),
  }));
  const sessions: LegacyRecord[] = recordArray(source.sessions, "历史会话").map((session) => {
    let upgraded = session;
    const missingPrefixListField = !Object.hasOwn(session, "prefixListId");
    if (missingPrefixListField || !session.localAddress || !session.localAsn) {
      const node = recordArray(source.nodes, "历史节点").find((item) => item.id === session.nodeId);
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
  const migrated = migrateSessionStatics(sessions.map(({ prefixListId, ...session }) => upgradeSessionV15({
    ...session,
    exportDefineId: prefixListId ?? null,
  }, source.nodes)), source.staticProtocols, source.version);
  return {
    ...source,
    version: CURRENT_INVENTORY_VERSION,
    defines: [
      ...prefixLists.map((item) => ({
        id: item.id,
        nodeId: item.nodeId ?? null,
        label: item.name,
        name: item.symbol,
        type: "cidr4",
        entrySource: { kind: "manual" },
        entries: item.entries,
        enabled: true,
      })),
      ...upgradeResourceOrder(source.defines).map((item) => ({
        ...item,
        label: item.label ?? item.name,
        type: "expression",
      })),
    ],
    functions: upgradeResourceOrder(source.functions),
    filters: upgradeResourceOrder(source.filters),
    rpki: recordArray(source.rpki, "RPKI 资源").map((item) => ({ ...item })),
    staticProtocols: migrated.staticProtocols.map((item) => ({ ...item, routeFilters: item.routeFilters ?? {} })),
    sourcePolicies: recordArray(source.sourcePolicies, "源地址出口映射").map((item) => ({ ...item })),
    sessions: migrated.sessions,
    ibgpDomains: upgradeIbgpDomains(source.ibgpDomains, source.version),
    ospfDomains: recordArray(source.ospfDomains, "OSPF 域").map((item) => ({ ...item })),
  };
}

export class InventoryStore {
  private readonly database: StateDatabase;
  private readonly stateKey: string;
  private readonly inventoryPath: string;
  private readonly nodesPath: string;
  private readonly legacySessionPath: string;
  private readonly revisions: WeakMap<Inventory, number>;
  private initialization: Promise<void> | null;

  constructor({ database, dataDir, nodesPath, legacySessionPath, stateKey = INVENTORY_STATE_KEY }: InventoryStoreOptions) {
    this.database = database;
    this.stateKey = stateKey;
    this.inventoryPath = path.join(dataDir, "inventory.json");
    this.nodesPath = nodesPath;
    this.legacySessionPath = legacySessionPath;
    this.revisions = new WeakMap();
    this.initialization = null;
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.#initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async #initialize(): Promise<void> {
    await this.database.initialize();
    const existing = await this.database.readState<unknown>(this.stateKey);
    if (!existing) {
      const initial = await this.loadLegacyInventory();
      await this.database.createState(this.stateKey, initial);
    }
    await this.#readNormalized();
  }

  async read(): Promise<Inventory> {
    await this.initialize();
    return this.#readNormalized();
  }

  async #readNormalized(): Promise<Inventory> {
    for (let attempt = 0; attempt < NORMALIZATION_RETRIES; attempt += 1) {
      let record = await this.database.readState<unknown>(this.stateKey);
      if (!record) throw new Error("Birdbox 库存状态不存在");
      const normalized = normalizeStoredInventory(upgradeInventory(record.value));
      if (isDeepStrictEqual(normalized, record.value)) return this.#track(normalized, record.revision);
      try {
        record = await this.database.replaceState<Inventory>(this.stateKey, record.revision, normalized);
        return this.#track(normalized, record.revision);
      } catch (error) {
        if ((error as Partial<BirdboxError>).code !== "STATE_CONFLICT" || attempt === NORMALIZATION_RETRIES - 1) throw error;
      }
    }
    throw new Error("库存规范化重试次数超限");
  }

  async loadLegacyInventory(): Promise<Inventory> {
    try {
      return normalizeStoredInventory(upgradeInventory(JSON.parse(await fs.readFile(this.inventoryPath, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.createInitialInventory();
    }
  }

  async createInitialInventory(): Promise<Inventory> {
    let nodes: ManagedNode[] = [];
    try {
      nodes = await loadSeedNodes(this.nodesPath) as ManagedNode[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = {
      version: CURRENT_INVENTORY_VERSION,
      nodes,
      peers: [] as Peer[],
      defines: [] as PolicyDefine[],
      functions: [],
      filters: [],
      rpki: [],
      staticProtocols: [] as LegacyRecord[],
      sourcePolicies: [] as LegacyRecord[],
      sessions: [] as BgpSession[],
      ibgpDomains: [] as LegacyRecord[],
      ospfDomains: [] as LegacyRecord[],
    };
    try {
      const legacy = JSON.parse(await fs.readFile(this.legacySessionPath, "utf8"));
      const local = legacy.local ?? legacy.left;
      const remote = legacy.remote ?? legacy.right;
      if (!local || !remote || !nodes.length) return normalizeInventory(state);
      const localRecord = requiredRecord(local, "旧会话本地端");
      const remoteRecord = requiredRecord(remote, "旧会话远端");
      const node = nodes.find((item) => item.id === localRecord.nodeId) ?? nodes[0];
      if (!node) return normalizeInventory(state);
      const peer = normalizePeer({
        id: safeLegacyId("peer", remoteRecord.name ?? "external"),
        nodeId: node.id,
        name: remoteRecord.name ?? "External peer",
        address: remoteRecord.address,
        asn: remoteRecord.asn,
        port: remoteRecord.port ?? 179,
      }) as Peer;
      const exportDefine = normalizeDefine({
        id: safeLegacyId("prefix", legacy.name ?? "birdbox_peer"),
        nodeId: node.id,
        label: `${legacy.name ?? "birdbox_peer"} CIDRs`,
        name: safeLegacySymbol(legacy.name ?? "birdbox_peer"),
        type: "cidr4",
        entries: [localRecord.advertisePrefix ?? "10.250.1.0/24"],
      }) as PolicyDefine;
      const session = normalizeSession({
        id: safeLegacyId("session", legacy.name ?? "birdbox_peer"),
        nodeId: node.id,
        peerId: peer.id,
        exportDefineId: exportDefine.id,
        protocolName: legacy.name ?? "birdbox_peer",
        localAddress: localRecord.address,
        localAsn: localRecord.asn,
        localPort: node.listenPort,
        multihop: legacy.multihop,
        enabled: true,
      }) as BgpSession;
      state.peers.push(peer);
      state.defines.push(exportDefine);
      state.sessions.push(session);
      state.staticProtocols.push({
        id: safeLegacyId("static", session.id),
        nodeId: node.id,
        label: `${session.protocolName} IPv4 Static`,
        name: makeStaticProtocolName("ipv4", session.protocolName),
        family: "ipv4",
        defineId: exportDefine.id,
        action: "blackhole",
        import: "all",
        export: "none",
        raw: "",
        enabled: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return normalizeInventory(state);
  }

  async write(value: unknown): Promise<Inventory> {
    await this.initialize();
    const normalized = normalizeInventory(value);
    const current = await this.database.readState<unknown>(this.stateKey);
    if (!current) throw new Error("Birdbox 库存状态不存在");
    const written = await this.database.replaceState<Inventory>(this.stateKey, current.revision, normalized);
    return this.#track(normalized, written.revision);
  }

  async replace(current: Inventory, value: unknown): Promise<Inventory> {
    await this.initialize();
    const revision = this.revisions.get(current);
    if (!revision) {
      const error = new Error("无法确认库存版本，请刷新后重试") as BirdboxError;
      error.status = 409;
      error.code = "STATE_CONFLICT";
      throw error;
    }
    const normalized = normalizeInventory(value);
    try {
      const written = await this.database.replaceState<Inventory>(this.stateKey, revision, normalized);
      return this.#track(normalized, written.revision);
    } catch (error) {
      // MySQL may commit the CAS before a lost connection hides its response.
      // Confirm the durable value so callers do not roll back a committed deploy.
      try {
        const record = await this.database.readState<Inventory>(this.stateKey);
        if (record && isDeepStrictEqual(record.value, normalized)) {
          return this.#track(normalized, record.revision);
        }
      } catch {
        // Preserve the original write error when confirmation is unavailable.
      }
      throw error;
    }
  }

  async mutate<Result>(mutator: (draft: Inventory) => Promise<Result> | Result): Promise<{ state: Inventory; result: Result | undefined }> {
    await this.initialize();
    const operation = await this.database.mutateState<unknown, Result>(
      this.stateKey,
      { version: CURRENT_INVENTORY_VERSION, nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [] },
      async (current) => {
        const draft = structuredClone(normalizeStoredInventory(upgradeInventory(current)));
        const result = await mutator(draft);
        const state = normalizeInventory(draft);
        return { value: state, result };
      },
    );
    return { state: this.#track(normalizeInventory(operation.value), operation.revision), result: operation.result };
  }

  #track(value: Inventory, revision: number): Inventory {
    this.revisions.set(value, revision);
    return value;
  }
}
