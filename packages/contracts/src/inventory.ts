export type AddressFamily = "ipv4" | "ipv6";
export type SwitchSetting = "default" | "on" | "off";
export type ResourceScope = string | null;

export interface ManagedNode {
  id: string;
  kind: "managed-node";
  name: string;
  transport: "local" | "ssh";
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  sshIdentity: "default" | "managed";
  deploymentMode: "legacy" | "include";
  mainConfigPath: string;
  generatedConfigPath: string;
  socketPath: string;
  routerId: string;
  listenPort: number;
}

export interface Peer {
  id: string;
  nodeId: string;
  name: string;
  address: string;
  asn: number;
  port: number;
}

interface PolicyResourceBase {
  id: string;
  nodeId: ResourceScope;
  label: string;
  name: string;
  enabled: boolean;
}

export interface CidrDefine extends PolicyResourceBase {
  type: "cidr4" | "cidr6";
  entries: string[];
}

export interface ExpressionDefine extends PolicyResourceBase {
  type: "expression";
  value: string;
}

export type PolicyDefine = CidrDefine | ExpressionDefine;

export interface PolicyFunction extends PolicyResourceBase {
  source: string;
  callable: boolean;
}

export interface PolicyFilter extends PolicyResourceBase {
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

interface RpkiBase extends PolicyResourceBase {
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
}

export interface Inventory {
  version: 20;
  nodes: ManagedNode[];
  peers: Peer[];
  defines: PolicyDefine[];
  functions: PolicyFunction[];
  filters: PolicyFilter[];
  rpki: RpkiSource[];
  staticProtocols: StaticProtocol[];
  sessions: BgpSession[];
}

export type PolicyCollection = "defines" | "functions" | "filters";
