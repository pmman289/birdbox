export type AddressFamily = "ipv4" | "ipv6";
export type SwitchSetting = "default" | "on" | "off";
export type ResourceScope = string | null;
export type MultiNodeResourceScope = string[] | null;
export type BgpSessionType = "ebgp" | "ibgp";

export interface ManagedNode {
  id: string;
  kind: "managed-node";
  name: string;
  transport: "local" | "ssh";
  /** SSH management endpoint; independent from the BGP/IGP transport address. */
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  sshIdentity: "default" | "managed";
  deploymentMode: "legacy" | "include";
  mainConfigPath: string;
  generatedConfigPath: string;
  socketPath: string;
  routerId: string;
  /** Transport address used when Birdbox creates new BGP adjacencies. */
  igpAddress: string | null;
  listenPort: number;
}

export interface TopologyPosition {
  x: number;
  y: number;
  locked: boolean;
}

export type BgpManagedBy = {
  kind: "ibgp-domain";
  domainId: string;
  adjacencyId: string;
};

export interface Peer {
  id: string;
  nodeId: string;
  name: string;
  address: string;
  asn: number;
  port: number;
  managedBy?: BgpManagedBy;
}

interface NamedPolicyResourceBase {
  id: string;
  label: string;
  name: string;
  enabled: boolean;
}

interface MultiNodePolicyResourceBase extends NamedPolicyResourceBase {
  nodeIds: MultiNodeResourceScope;
}

export interface CidrDefine extends MultiNodePolicyResourceBase {
  type: "cidr4" | "cidr6";
  entrySource: { kind: "manual" } | {
    kind: "irr-as-set";
    asSet: string;
    server: string;
    databases: string[];
    refreshIntervalSeconds: number;
    prefixLimit: number;
    allowMoreSpecific: boolean;
  };
  entries: string[];
  sync: {
    status: "never" | "ready" | "error";
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextRefreshAt: string | null;
    error: string | null;
    contentHash: string | null;
  };
}

export interface ExpressionDefine extends MultiNodePolicyResourceBase {
  type: "expression";
  value: string;
}

export type PolicyDefine = CidrDefine | ExpressionDefine;

export interface PolicyFunction extends MultiNodePolicyResourceBase {
  source: string;
  callable: boolean;
}

export interface PolicyFilter extends MultiNodePolicyResourceBase {
  source: string;
}

export type StaticRouteFilterOperation =
  | { type: "set"; attribute: "preference" | "igp_metric" | "bgp_local_pref" | "bgp_med"; value: number }
  | { type: "set"; attribute: "bgp_origin"; value: "igp" | "egp" | "incomplete" }
  | { type: "community"; list: "standard" | "large"; operation: "empty" }
  | { type: "community"; list: "standard" | "large"; operation: "add" | "delete"; value: number[] }
  | { type: "prepend"; asn: number; count: number };

export interface StaticRouteFilter {
  operations: StaticRouteFilterOperation[];
  custom: string;
}

export interface StaticProtocol {
  id: string;
  nodeId: string;
  label: string;
  name: string;
  family: AddressFamily;
  defineId: string | null;
  action: string | null;
  routeActions: Record<string, string>;
  routeFilters: Record<string, StaticRouteFilter>;
  import: "all" | "none";
  export: "all" | "none";
  raw: string;
  enabled: boolean;
}

export interface SourcePolicyEgressGroup {
  id: string;
  egressAddress: string;
  sources: string[];
  kernelTable: number;
  ruleSlot: number;
}

export interface SourcePolicyEgress {
  id: string;
  label: string;
  enabled: boolean;
  nodeIds: MultiNodeResourceScope;
  groups: SourcePolicyEgressGroup[];
  rulePriorityBase: number;
  copyInternalRoutes: boolean;
  internalDefineIds: string[];
}

interface RpkiBase extends MultiNodePolicyResourceBase {
  sourceType: "file" | "server";
  roa4Table: string | null;
  roa6Table: string | null;
}

export interface RpkiFileSource extends RpkiBase {
  sourceType: "file";
  file4: string | null;
  file6: string | null;
}

export interface RpkiServerSource extends RpkiBase {
  sourceType: "server";
  remote: string;
  port: number;
  localAddress: string | null;
  refresh: number | null;
  keepRefresh: boolean;
  retry: number | null;
  keepRetry: boolean;
  expire: number | null;
  keepExpire: boolean;
  ignoreMaxLength: SwitchSetting;
  minVersion: number | null;
  maxVersion: number | null;
  transport: "tcp" | "ssh";
  authentication: "none" | "md5";
  password: string | null;
  birdPrivateKey: string | null;
  remotePublicKey: string | null;
  user: string | null;
}

export type RpkiSource = RpkiFileSource | RpkiServerSource;

export interface PolicyFunctionStep {
  type: "function";
  functionId: string;
  action: "accept" | "reject" | "execute";
}

export interface PolicyFormStep {
  type: "form";
}

export interface ChannelPolicy {
  mode: "form" | "combined" | "custom";
  steps: Array<PolicyFunctionStep | PolicyFormStep>;
  filterId: string | null;
  formAction: "all" | "none" | "cidr";
}

export interface ChannelLimit {
  value: number | null;
  action: "warn" | "block" | "restart" | "disable";
}

export interface BgpChannel {
  enabled: boolean;
  importPolicy: ChannelPolicy;
  exportPolicy: ChannelPolicy;
  exportDefineId: string | null;
  table: string | null;
  preference: number | null;
  importKeepFiltered: boolean;
  rpkiReload: SwitchSetting;
  importLimit: ChannelLimit;
  receiveLimit: ChannelLimit;
  exportLimit: ChannelLimit;
  mandatory: boolean;
  nextHopKeep: "default" | "off" | "on" | "ibgp" | "ebgp";
  nextHopSelf: "default" | "off" | "on" | "ibgp" | "ebgp";
  nextHopAddress: string | null;
  nextHopPrefer: "default" | "global" | "local";
  linkLocalNextHopFormat: "default" | "native" | "single" | "double";
  gateway: "default" | "direct" | "recursive";
  igpTable: string | null;
  importTable: boolean;
  exportTable: boolean;
  secondary: boolean;
  extendedNextHop: boolean;
  requireExtendedNextHop: boolean;
  addPaths: "off" | "on" | "rx" | "tx";
  requireAddPaths: boolean;
  aigp: "default" | "off" | "on" | "originate";
  cost: number | null;
  gracefulRestart: SwitchSetting;
  longLivedGracefulRestart: SwitchSetting;
  longLivedStaleTime: number | null;
  minLongLivedStaleTime: number | null;
  maxLongLivedStaleTime: number | null;
  raw: string;
}

export interface BgpOptions {
  connectionMode: "direct" | "multihop";
  multihopTtl: number;
  passive: boolean;
  bfd: "off" | "on" | "graceful" | "custom";
  bfdOptions: string;
  ttlSecurity: boolean;
  description: string | null;
  routerId: string | null;
  vrf: string | null;
  interface: string | null;
  onlink: boolean;
  authentication: "none" | "md5" | "ao";
  password: string | null;
  aoKeys: string;
  setkey: SwitchSetting;
  strictBind: boolean;
  freeBind: boolean;
  checkLink: SwitchSetting;
  rsClient: boolean;
  confederation: number | null;
  confederationMember: boolean;
  allowLocalPref: boolean;
  allowMed: boolean;
  allowLocalAs: number | "all" | null;
  allowAsSets: SwitchSetting;
  enforceFirstAs: boolean;
  routeRefresh: SwitchSetting;
  enhancedRouteRefresh: SwitchSetting;
  requireRouteRefresh: boolean;
  requireEnhancedRouteRefresh: boolean;
  gracefulRestart: "default" | "off" | "aware" | "on";
  gracefulRestartTime: number | null;
  minGracefulRestartTime: number | null;
  maxGracefulRestartTime: number | null;
  requireGracefulRestart: boolean;
  longLivedGracefulRestart: "default" | "off" | "aware" | "on";
  longLivedStaleTime: number | null;
  minLongLivedStaleTime: number | null;
  maxLongLivedStaleTime: number | null;
  requireLongLivedGracefulRestart: boolean;
  interpretCommunities: SwitchSetting;
  enableAs4: SwitchSetting;
  requireAs4: boolean;
  extendedMessages: boolean;
  requireExtendedMessages: boolean;
  capabilities: SwitchSetting;
  advertiseHostname: boolean;
  requireHostname: boolean;
  disableAfterError: boolean;
  disableAfterCease: SwitchSetting;
  holdTime: number | null;
  minHoldTime: number | null;
  startupHoldTime: number | null;
  keepaliveTime: number | null;
  minKeepaliveTime: number | null;
  sendHoldTime: number | null;
  connectDelayTime: number | null;
  connectRetryTime: number | null;
  errorWaitMin: number | null;
  errorWaitMax: number | null;
  errorForgetTime: number | null;
  pathMetric: SwitchSetting;
  medMetric: boolean;
  deterministicMed: boolean;
  igpMetric: SwitchSetting;
  preferOlder: boolean;
  defaultMed: number | null;
  defaultLocalPref: number | null;
  localRole: "" | "provider" | "rs_server" | "rs_client" | "customer" | "peer";
  requireRoles: boolean;
  rrClient: boolean;
  rrClusterId: string | null;
  raw: string;
}

export interface BgpSession {
  id: string;
  nodeId: string;
  peerId: string;
  protocolName: string;
  localAddress: string | null;
  localAsn: number;
  localPort: number;
  bgp: BgpOptions;
  channels: Record<AddressFamily, BgpChannel>;
  enabled: boolean;
  sessionType: BgpSessionType;
  managedBy?: BgpManagedBy;
}

export interface IbgpMember {
  nodeId: string;
  address: string;
}

export interface IbgpAdjacency {
  id: string;
  leftNodeId: string;
  rightNodeId: string;
  enabled: boolean;
  leftSessionId: string;
  rightSessionId: string;
}

export interface IbgpDomain {
  id: string;
  name: string;
  asn: number;
  members: IbgpMember[];
  adjacencies: IbgpAdjacency[];
  layout: Record<string, TopologyPosition>;
}

export type OspfVersion = "ospfv2" | "ospfv3";

/** BIRD OSPF protocol-level knobs. Optional for backwards-compatible inventory files. */
export interface OspfProtocolOptions {
  rfc1583compat?: boolean;
  rfc5838?: boolean;
  instanceId?: number | null;
  stubRouter?: boolean;
  tick?: number | null;
  ecmp?: boolean | null;
  ecmpLimit?: number | null;
  mergeExternal?: boolean;
  gracefulRestartMode?: "off" | "aware" | "on";
  gracefulRestartTime?: number | null;
}

export interface OspfAreaOptions {
  stub?: boolean;
  nssa?: boolean;
  summary?: boolean | null;
  defaultNssa?: boolean;
  defaultCost?: number | null;
  defaultCost2?: number | null;
  translator?: boolean;
  translatorStability?: number | null;
  networks?: Array<{ prefix: string; hidden?: boolean }>;
  external?: Array<{ prefix: string; hidden?: boolean; tag?: number | null }>;
  stubnets?: Array<{ prefix: string; hidden?: boolean; summary?: boolean; cost?: number | null }>;
}

export interface OspfVirtualLink {
  id: string;
  area: string;
  instanceId?: number | null;
  hello?: number | null;
  retransmit?: number | null;
  wait?: number | null;
  dead?: number | null;
  authentication?: "none" | "simple" | "cryptographic";
  password?: string | null;
  passwordOptions?: OspfPasswordOptions;
}

export interface OspfPasswordOptions {
  id?: number | null;
  generateFrom?: string | null;
  generateTo?: string | null;
  acceptFrom?: string | null;
  acceptTo?: string | null;
  from?: string | null;
  to?: string | null;
  algorithm?: "keyed-md5" | "keyed-sha1" | "hmac-sha1" | "hmac-sha256" | "hmac-sha384" | "hmac-sha512";
}

export interface OspfInterfaceOptions {
  instanceId?: number | null;
  stub?: boolean;
  poll?: number | null;
  retransmit?: number | null;
  transmitDelay?: number | null;
  priority?: number | null;
  wait?: number | null;
  deadMode?: "count" | "seconds";
  rxBuffer?: "normal" | "large" | number | null;
  txLength?: number | null;
  type?: "broadcast" | "ptp" | "nbma" | "ptmp";
  linkLsaSuppression?: boolean;
  strictNonbroadcast?: boolean;
  realBroadcast?: boolean;
  ptpNetmask?: boolean;
  ptpAddress?: boolean;
  secondary?: boolean;
  checkLink?: boolean;
  bfd?: boolean;
  ecmpWeight?: number | null;
  ttlSecurity?: "off" | "on" | "tx-only";
  txClass?: number | null;
  txDscp?: number | null;
  txPriority?: number | null;
  password?: string | null;
  passwordOptions?: OspfPasswordOptions;
  neighbors?: Array<{ address: string; eligible?: boolean }>;
}

export interface OspfLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  area: string;
  localInterface: string;
  remoteInterface: string;
  cost: number;
  hello: number;
  dead: number;
  passive: boolean;
  authentication: "none" | "simple" | "md5" | "ipsec";
  options?: OspfInterfaceOptions;
}

export interface OspfNodeConfig {
  nodeId: string;
  enabled: boolean;
  versions: OspfVersion[];
  routerId: string | null;
  importPolicies: Record<OspfVersion, ChannelPolicy>;
  exportPolicies: Record<OspfVersion, ChannelPolicy>;
  exportDefineIds: Record<OspfVersion, string | null>;
  bfd: boolean;
  gracefulRestart: boolean;
  redistributeStatic: boolean;
  protocolOptions?: OspfProtocolOptions;
  areaOptions?: Record<string, OspfAreaOptions>;
  virtualLinks?: OspfVirtualLink[];
}

export interface OspfDomain {
  id: string;
  name: string;
  nodeConfigs: OspfNodeConfig[];
  links: OspfLink[];
  layout: Record<string, TopologyPosition>;
}

export interface Inventory {
  version: 28;
  nodes: ManagedNode[];
  peers: Peer[];
  defines: PolicyDefine[];
  functions: PolicyFunction[];
  filters: PolicyFilter[];
  rpki: RpkiSource[];
  staticProtocols: StaticProtocol[];
  sourcePolicies: SourcePolicyEgress[];
  sessions: BgpSession[];
  ibgpDomains: IbgpDomain[];
  ospfDomains: OspfDomain[];
}

export type PolicyCollection = "defines" | "functions" | "filters";
