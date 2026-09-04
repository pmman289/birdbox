import type { DashboardResponse } from "@birdbox/contracts/api";
import type { SessionMutationRequest } from "@birdbox/contracts/api";
import type {
  AddressFamily,
  BgpChannel,
  BgpOptions,
  ChannelPolicy,
  Inventory,
  Peer,
} from "@birdbox/contracts/inventory";
import { cloneReactive } from "../shared/clone-reactive";
import { uniqueBirdName } from "../shared/resource-names";

export interface SessionDraft extends Omit<SessionMutationRequest, "localAsn" | "localPort"> {
  localAsn: number | null;
  localPort: number | null;
}

function defaultPolicy(direction: "import" | "export"): ChannelPolicy {
  return {
    mode: "combined",
    steps: [{ type: "form" }],
    filterId: null,
    formAction: direction === "import" ? "all" : "none",
  };
}

export function defaultBgpOptions(): BgpOptions {
  return {
    connectionMode: "direct",
    multihopTtl: 10,
    passive: false,
    bfd: "off",
    bfdOptions: "",
    ttlSecurity: false,
    description: null,
    routerId: null,
    vrf: null,
    interface: null,
    onlink: false,
    authentication: "none",
    password: null,
    aoKeys: "",
    setkey: "default",
    strictBind: false,
    freeBind: false,
    checkLink: "default",
    rsClient: false,
    confederation: null,
    confederationMember: false,
    allowLocalPref: false,
    allowMed: false,
    allowLocalAs: null,
    allowAsSets: "default",
    enforceFirstAs: false,
    routeRefresh: "default",
    enhancedRouteRefresh: "default",
    requireRouteRefresh: false,
    requireEnhancedRouteRefresh: false,
    gracefulRestart: "default",
    gracefulRestartTime: null,
    minGracefulRestartTime: null,
    maxGracefulRestartTime: null,
    requireGracefulRestart: false,
    longLivedGracefulRestart: "default",
    longLivedStaleTime: null,
    minLongLivedStaleTime: null,
    maxLongLivedStaleTime: null,
    requireLongLivedGracefulRestart: false,
    interpretCommunities: "default",
    enableAs4: "default",
    requireAs4: false,
    extendedMessages: false,
    requireExtendedMessages: false,
    capabilities: "default",
    advertiseHostname: false,
    requireHostname: false,
    disableAfterError: false,
    disableAfterCease: "default",
    holdTime: null,
    minHoldTime: null,
    startupHoldTime: null,
    keepaliveTime: null,
    minKeepaliveTime: null,
    sendHoldTime: null,
    connectDelayTime: null,
    connectRetryTime: null,
    errorWaitMin: null,
    errorWaitMax: null,
    errorForgetTime: null,
    pathMetric: "default",
    medMetric: false,
    deterministicMed: false,
    igpMetric: "default",
    preferOlder: false,
    defaultMed: null,
    defaultLocalPref: null,
    localRole: "",
    requireRoles: false,
    rrClient: false,
    rrClusterId: null,
    raw: "",
  };
}

export function defaultChannel(): BgpChannel {
  return {
    enabled: true,
    importPolicy: defaultPolicy("import"),
    exportPolicy: defaultPolicy("export"),
    exportDefineId: null,
    table: null,
    preference: null,
    importKeepFiltered: false,
    rpkiReload: "default",
    importLimit: { value: null, action: "disable" },
    receiveLimit: { value: null, action: "disable" },
    exportLimit: { value: null, action: "disable" },
    mandatory: false,
    nextHopKeep: "default",
    nextHopSelf: "default",
    nextHopAddress: null,
    nextHopPrefer: "default",
    linkLocalNextHopFormat: "default",
    gateway: "default",
    igpTable: null,
    importTable: false,
    exportTable: false,
    secondary: false,
    extendedNextHop: false,
    requireExtendedNextHop: false,
    addPaths: "off",
    requireAddPaths: false,
    aigp: "default",
    cost: null,
    gracefulRestart: "default",
    longLivedGracefulRestart: "default",
    longLivedStaleTime: null,
    minLongLivedStaleTime: null,
    maxLongLivedStaleTime: null,
    raw: "",
  };
}

export function defaultProtocolName(inventory: Inventory, peer: Peer): string {
  return uniqueBirdName(inventory, "bgp", peer.name);
}

export function createSessionDraft(dashboard: DashboardResponse): SessionDraft | null {
  const peer = dashboard.selectedPeer;
  const node = dashboard.node;
  if (!peer || !node) return null;
  if (peer.session) {
    const { id: _id, ...session } = cloneReactive(peer.session);
    for (const family of ["ipv4", "ipv6"] as const) {
      for (const direction of ["importPolicy", "exportPolicy"] as const) {
        const policy = session.channels[family][direction];
        if (policy.mode === "form") {
          policy.mode = "combined";
          policy.steps = [{ type: "form" }];
        }
      }
    }
    return session;
  }
  return {
    nodeId: node.id,
    peerId: peer.id,
    protocolName: defaultProtocolName(dashboard.inventory, peer),
    sessionType: "ebgp",
    enabled: true,
    // New eBGP sessions bind to the configured IGP transport address. Do not
    // derive it from Router ID: Router ID may deliberately be public.
    localAddress: node.igpAddress ?? null,
    localAsn: null,
    localPort: node.listenPort || 179,
    bgp: defaultBgpOptions(),
    channels: {
      ipv4: defaultChannel(),
      ipv6: defaultChannel(),
    },
  };
}

export function channelRequiresExtendedNextHop(peer: Peer, family: AddressFamily): boolean {
  return peer.address.includes(":") && family === "ipv4";
}

export function toSessionMutationRequest(draft: SessionDraft, peer: Peer): SessionMutationRequest {
  if (draft.localAsn === null || !Number.isSafeInteger(draft.localAsn)) throw new Error("本地 ASN 不能为空");
  if (draft.localPort === null || !Number.isSafeInteger(draft.localPort)) throw new Error("本地端口不能为空");
  const payload = cloneReactive(draft) as SessionMutationRequest;
  for (const family of ["ipv4", "ipv6"] as const) {
    if (payload.channels[family].enabled && channelRequiresExtendedNextHop(peer, family)) {
      payload.channels[family].extendedNextHop = true;
    }
  }
  return payload;
}
