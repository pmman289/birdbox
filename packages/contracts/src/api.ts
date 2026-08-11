import type {
  AddressFamily,
  BgpSession,
  IbgpDomain,
  Inventory,
  ManagedNode,
  Peer,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
  RpkiSource,
  StaticProtocol,
} from "./inventory.js";

export type SessionMutationRequest = Omit<BgpSession, "id" | "managedBy">;
export type NodeMutationRequest = Omit<ManagedNode, "id" | "kind">;
export type PeerMutationRequest = Omit<Peer, "id" | "nodeId" | "managedBy">;
export type StaticMutationRequest = Omit<StaticProtocol, "id">;
export type RpkiMutationRequest = Omit<RpkiSource, "id">;

export type PolicyResource = PolicyDefine | PolicyFunction | PolicyFilter;
export type PolicyMutationRequest<Resource extends PolicyResource = PolicyResource> = Omit<Resource, "id">;

export interface ApiErrorResponse {
  error: string;
  code?: string;
  events?: ChangeEvent[];
}

export interface ProtocolChannelRuntime {
  state: string | null;
  table: string | null;
  imported: number | null;
  exported: number | null;
  preferred: number | null;
}

export interface ProtocolRuntime {
  name: string;
  configured: boolean;
  disabled: boolean;
  state: string | null;
  established: boolean;
  neighbor: string | null;
  neighborAs: number | null;
  imported: number | null;
  exported: number | null;
  channels?: Record<string, ProtocolChannelRuntime>;
}

export interface NodeRuntime {
  nodeId: string | null;
  reachable: boolean;
  bird2: boolean;
  version: string | null;
  protocols: ProtocolRuntime[];
  error: string | null;
  raw?: string;
}

export interface InventoryHealth {
  status: "ready" | "warning" | "error";
  totalNodes: number;
  onlineNodes: number;
  activeSessions: number;
  normalSessions: number;
  abnormalSessions: number;
}

export interface ChangeEvent {
  timestamp: string;
  level: string;
  message: string;
  nodeId: string | null;
}

export interface DashboardPeer extends Peer {
  session: BgpSession | null;
  protocol: ProtocolRuntime | null;
}

export interface DashboardResponse {
  inventory: Inventory;
  selection: { nodeId: string | null; peerId: string | null };
  node: ManagedNode | null;
  peers: DashboardPeer[];
  cidrDefines: Record<AddressFamily, PolicyDefine[]>;
  defines: PolicyDefine[];
  functions: PolicyFunction[];
  filters: PolicyFilter[];
  rpki: RpkiSource[];
  staticProtocols: StaticProtocol[];
  selectedPeer: DashboardPeer | null;
  runtime: NodeRuntime;
  health: InventoryHealth;
  established: boolean;
  config: string;
  events: ChangeEvent[];
}

export interface DeploymentReport {
  applied: boolean;
  nodeIds: string[];
  nodes: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; nodeId: string; protocolName: string }>;
}

export interface NodeCommandResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number;
}

export interface SessionPreviewResponse {
  valid: boolean;
  session: BgpSession;
  config: string;
  validation: NodeCommandResponse;
  events: ChangeEvent[];
}

export interface SessionApplyResponse {
  applied: true;
  enabled: boolean;
  established: boolean;
  session: BgpSession;
  config: string;
  status: unknown;
  events: ChangeEvent[];
}

export interface SessionDeleteResponse {
  inventory: Inventory;
  events: ChangeEvent[];
}

export interface ResourceMutationResponse<Resource> {
  resource: Resource;
  inventory: Inventory;
  deployment: DeploymentReport;
  events: ChangeEvent[];
}

export interface NodeMutationResponse {
  node: ManagedNode;
  inventory: Inventory;
  deployment: DeploymentReport;
  events: ChangeEvent[];
}

export interface NodeOnboardingRpkiRequirement {
  resourceId: string;
  resourceLabel: string;
  family: AddressFamily;
  path: string;
}

export interface NodeSetupScriptResponse {
  script: string;
  includeLine: string;
  publicKey: string;
  rpkiRequirements: NodeOnboardingRpkiRequirement[];
}

export interface NodeTestResponse {
  ok: true;
  node: Pick<ManagedNode, "name" | "sshHost" | "sshPort" | "sshUser">;
  runtime: Pick<NodeRuntime, "version" | "bird2">;
}

export interface PeerMutationResponse {
  peer: Peer;
  inventory: Inventory;
  deployment?: DeploymentReport;
  events: ChangeEvent[];
}

export interface ResourceDeleteResponse {
  inventory: Inventory;
  deployment: DeploymentReport;
  events: ChangeEvent[];
}

export interface IbgpDomainListResponse {
  domains: IbgpDomain[];
  inventory: Inventory;
}

export interface IbgpDomainMutationResponse {
  domain?: IbgpDomain;
  inventory: Inventory;
  deployment?: DeploymentReport;
  events?: ChangeEvent[];
}

export interface IbgpPreviewSide {
  side: "left" | "right";
  nodeId: string;
  nodeName: string;
  session: BgpSession;
  config: string;
  validation: NodeCommandResponse;
}

export interface IbgpDomainPreviewResponse {
  valid: boolean;
  domain: IbgpDomain;
  sessions: BgpSession[];
  sides: IbgpPreviewSide[];
}

export interface RouteDetail {
  prefix: string;
  summary: string;
  details: string;
}

export interface RouteDetailsResponse {
  session: { id: string; protocolName: string };
  family: AddressFamily;
  direction: "import" | "export";
  table: string | null;
  routes: RouteDetail[];
  truncated: boolean;
  limit: number;
}
