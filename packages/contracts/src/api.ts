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
  SourcePolicyEgress,
  StaticProtocol,
  DirectProtocol,
  KernelProtocol,
  OspfDomain,
} from "./inventory.js";

export type SessionMutationRequest = Omit<BgpSession, "id" | "managedBy">;
export type NodeMutationRequest = Omit<ManagedNode, "id" | "kind">;
export type PeerMutationRequest = Omit<Peer, "id" | "nodeId" | "managedBy">;
export type StaticMutationRequest = Omit<StaticProtocol, "id">;
export type DirectMutationRequest = Omit<DirectProtocol, "id">;
export type KernelMutationRequest = Omit<KernelProtocol, "id">;
export type RpkiMutationRequest = Omit<RpkiSource, "id">;
export type SourcePolicyMutationRequest = Omit<SourcePolicyEgress, "id" | "rulePriorityBase">;

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
  nodeStatuses?: NodeHealthSummary[];
}

export interface NodeHealthSummary {
  nodeId: string;
  name: string;
  status: "ready" | "warning" | "error";
  reachable: boolean;
  bird2: boolean;
  version: string | null;
  error: string | null;
  activeSessions: number;
  normalSessions: number;
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
  directProtocols: DirectProtocol[];
  kernelProtocols: KernelProtocol[];
  sourcePolicies: SourcePolicyEgress[];
  selectedPeer: DashboardPeer | null;
  runtime: NodeRuntime;
  health: InventoryHealth;
  established: boolean;
  config: string;
  events: ChangeEvent[];
}

export interface DashboardRuntimeResponse {
  nodeId: string;
  runtime: NodeRuntime;
  sessions: BgpSession[];
  config: string;
  events: ChangeEvent[];
}

export interface DeploymentReport {
  applied: boolean;
  /** Stable transaction identifier for querying or explaining a deployment. */
  transactionId?: string;
  nodeIds: string[];
  nodes: Array<{ id: string; name: string }>;
  nodeResults?: Array<{ nodeId: string; status: "success" | "failed" | "rolled_back" | "unknown"; error?: string | null }>;
  rollback?: { attempted: boolean; succeeded: boolean; error?: string | null };
  sessions: Array<{ id: string; nodeId: string; protocolName: string }>;
}

export interface NodeCommandResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number;
}

export interface OspfPreviewNode {
  nodeId: string;
  config: string;
  diff: { changed: boolean; added: number; removed: number; unified: string };
  validation: NodeCommandResponse;
}

export interface OspfPreviewResponse {
  valid: boolean;
  domain: OspfDomain;
  configs: OspfPreviewNode[];
  diagnostics: Array<{ nodeId: string; message: string; code: string | number | null }>;
}

export interface OspfRuntimeResponse {
  domainId: string;
  lastCheckedAt: string;
  nodes: Array<{ nodeId: string; name: string; runtime: unknown }>;
}

export interface SessionPreviewResponse {
  valid: boolean;
  session: BgpSession;
  config: string;
  /** Only the BGP block represented by the submitted draft. */
  sessionConfig: string;
  validation: NodeCommandResponse;
  events: ChangeEvent[];
}

export interface SessionApplyResponse {
  applied: true;
  enabled: boolean;
  established: boolean;
  session: BgpSession;
  config: string;
  /** Only the BGP block represented by the applied session. */
  sessionConfig: string;
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

export interface SourcePolicyRuleInstruction {
  priority: number;
  /** Source selector for a policy rule. Exactly one of source/destination is set. */
  source: string | null;
  /** Destination selector used to keep an egress gateway on the underlay table. */
  destination: string | null;
  kind: "source" | "gateway";
  table: number;
  egressAddress: string;
  groupId: string;
}

export interface SourcePolicyManualPlan {
  operation: "create" | "update" | "delete" | "reconcile";
  resourceId: string;
  resourceLabel: string;
  nodeId: string;
  nodeName: string;
  platform: "linux" | "openwrt";
  birdConfig: string;
  rules: SourcePolicyRuleInstruction[];
  removeRules: SourcePolicyRuleInstruction[];
  gatewayRules: SourcePolicyRuleInstruction[];
  removeGatewayRules: SourcePolicyRuleInstruction[];
  /** Complete node-level rule set used by generated scripts and Agent reconcile. */
  managedRules: SourcePolicyRuleInstruction[];
  removeManagedRules: SourcePolicyRuleInstruction[];
  applyScript: string | null;
  cleanupScript: string | null;
  systemdUnit: string | null;
  systemdInstallScript: string | null;
  instructions: string[];
  /** Whether the controller applies kernel rules automatically. */
  management: "agent" | "local" | "manual";
  upgradeRequired: boolean;
  warning: string | null;
}

export interface SourcePolicyMutationResponse extends ResourceMutationResponse<SourcePolicyEgress> {
  manualPlans: SourcePolicyManualPlan[];
}

export interface NodeMutationResponse {
  node: ManagedNode;
  agentToken?: string;
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
  /** Short-lived capability URL for `bash <(curl -fsSL ...)` execution. */
  setupScriptUrl?: string;
  publicKey: string;
  /** Returned only once for Agent onboarding; do not persist in inventory responses. */
  agentToken?: string;
  nodeId?: string;
  rpkiRequirements: NodeOnboardingRpkiRequirement[];
}

export interface AgentStatus {
  nodeId: string;
  connected: boolean;
  registeredAt: string;
  lastSeenAt: string;
  agentVersion: string;
  protocolVersion: number;
  capabilities: string[];
  platform: string | null;
  architecture: string | null;
  hostname: string | null;
}

export interface AgentStatusResponse {
  agents: AgentStatus[];
}

export interface AgentUpgradeResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number;
  result?: { version?: unknown };
}

export interface AgentBatchUpgradeItem {
  nodeId: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result?: AgentUpgradeResponse;
}

export interface AgentBatchUpgradeJob {
  id: string;
  status: "running" | "completed";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentNodeId: string | null;
  items: AgentBatchUpgradeItem[];
}

export interface AgentBatchUpgradeResponse {
  job: AgentBatchUpgradeJob | null;
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

export interface ProtocolDetailsResponse {
  session: { id: string; protocolName: string };
  ok: boolean;
  output: string;
  error: string | null;
}

export interface RoutePathHop {
  address: string | null;
  interface: string | null;
}

export interface RoutePathEntry extends RouteDetail {
  nextHops: RoutePathHop[];
}

export interface RoutePathResponse {
  node: { id: string; name: string };
  target: string;
  family: AddressFamily;
  table: string;
  reachable: boolean;
  error: string | null;
  routes: RoutePathEntry[];
  truncated: boolean;
  limit: number;
}
