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
  PipeProtocol,
  OspfDomain,
} from "./inventory.js";
import type { DefineReference } from "./define-references.js";

export type SystemProtocolKind = "directs" | "kernels";
export interface RpkiEditorContext {
  inventoryRevision: number | null;
  resource: RpkiSource | null;
  references: Array<{ kind: "defines" | "functions" | "filters" | "statics"; id: string; label: string; symbols: string[] }>;
}
export interface RpkiPreviewResponse extends RpkiEditorContext {
  valid: boolean;
  previewId: string;
  candidateHash: string;
  resource: RpkiSource;
  configs: Array<{ nodeId: string; config: string; diff: string; validation: NodeCommandResponse }>;
}
export interface RpkiRuntimeResponse {
  resourceId: string;
  nodes: Array<{ nodeId: string; lastCheckedAt: string; protocols: Array<{
    name: string; state: "up" | "down" | "start" | "disabled" | "not_configured" | "error" | "unknown";
    rtrState: string | null;
    channels: Array<{ family: AddressFamily; table: string; state: string | null; imported: number | null }>;
    raw: string; error: string | null;
  }> }>;
}
export interface RpkiRoaResponse {
  resourceId: string; nodeId: string; family: AddressFamily; table: string;
  entries: Array<{ prefix: string; maxLength: number; asn: number; protocol: string | null; raw: string }>;
  truncated: boolean; limit: number;
}
export interface SystemProtocolEditorContext {
  inventoryRevision: number | null;
  resource: DirectProtocol | KernelProtocol | null;
}
export interface SystemProtocolPreviewResponse extends SystemProtocolEditorContext {
  valid: boolean;
  previewId: string;
  candidateHash: string;
  resource: DirectProtocol | KernelProtocol;
  configs: Array<{ nodeId: string; config: string; diff: string; validation: { ok: boolean; stdout: string; stderr: string } }>;
}
export interface SystemProtocolRuntimeResponse {
  resourceId: string;
  nodes: Array<{
    nodeId: string;
    lastCheckedAt: string;
    protocols: Array<{
      name: string;
      family: AddressFamily | "dual";
      state: "up" | "down" | "start" | "disabled" | "not_configured" | "error" | "unknown";
      imported: number | null;
      exported: number | null;
      raw: string;
      error: string | null;
    }>;
  }>;
}

export interface PolicyResourceEditorContext {
  inventoryRevision: number | null;
  resource: PolicyDefine | PolicyFunction | PolicyFilter | null;
  references: DefineReference[];
}
export interface DefineEditorContext extends PolicyResourceEditorContext {
  resource: PolicyDefine | null;
}

export interface PolicyResourcePreviewResponse extends PolicyResourceEditorContext {
  valid: boolean;
  previewId: string;
  candidateHash: string;
  resource: PolicyDefine | PolicyFunction | PolicyFilter;
  changes: { added: string[]; removed: string[]; addedCount: number; removedCount: number };
  configs: Array<{
    nodeId: string;
    config: string;
    diff: string;
    validation: NodeCommandResponse;
  }>;
}

export interface DefinePreviewResponse extends PolicyResourcePreviewResponse { resource: PolicyDefine; }

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
  deployment?: DeploymentReport;
}

export interface OspfProtocolRuntime {
  state: "up" | "down" | "start" | "disabled" | "not_configured" | "unknown" | "error";
  areas: Array<{ area: string; type?: "normal" | "stub" | "nssa" | null; interfaces: number | null; neighbors: number | null; adjacentNeighbors: number | null; raw: string }>;
  areasAvailable?: boolean;
  areaError?: string | null;
  raw: string;
  error: string | null;
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
  pipeProtocols: PipeProtocol[];
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
  nodeResults?: Array<{ nodeId: string; status: "success" | "failed" | "rolled_back" | "unknown" | "not_attempted"; error?: string | null }>;
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
  inventoryRevision: number | null;
  previewId: string;
  candidateHash: string;
  session: BgpSession;
  config: string;
  previousConfig: string;
  diff: string;
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
  inventoryRevision: number | null;
  manualPlans: SourcePolicyManualPlan[];
}

export interface SourcePolicyEditorContext {
  resource: SourcePolicyEgress | null;
  inventoryRevision: number | null;
}

export interface SourcePolicyPreviewResponse extends SourcePolicyEditorContext {
  resource: SourcePolicyEgress;
  manualPlans: SourcePolicyManualPlan[];
  valid?: boolean;
  previewId?: string;
  candidateHash?: string;
  configs?: PolicyResourcePreviewResponse["configs"];
}

export interface SourcePolicyRuntimeResponse {
  resourceId: string;
  nodes: Array<{
    nodeId: string;
    lastCheckedAt: string;
    rules: {
      expected: number;
      installed: number | null;
      missing: SourcePolicyRuleInstruction[];
      unexpected: Array<{ priority: number; source?: string; destination?: string; table: number }>;
      persistence: "ready" | "pending" | "missing" | "manual" | "error" | "unknown";
      error: string | null;
      raw: string;
    };
    groups: Array<{
      groupId: string;
      egressAddress: string;
      table: string;
      kernelTable: number;
      skipped: boolean;
      protocols: Array<{
        name: string; kind: "Static" | "Kernel" | "Pipe";
        state: "up" | "down" | "start" | "disabled" | "not_configured" | "error" | "unknown";
        raw: string; error: string | null;
      }>;
      kernelRoutes: Array<{ prefix: string; gateway: string | null; interface: string | null; type: string; raw: string }>;
      routesTruncated: boolean;
      routeError: string | null;
    }>;
  }>;
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
  inventoryRevision?: number | null;
  domains: IbgpDomain[];
  inventory: Inventory;
}

export interface IbgpDomainMutationResponse {
  inventoryRevision?: number | null;
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
  inventoryRevision?: number | null;
  previewId?: string;
  candidateHash?: string;
  configs?: Array<{ nodeId: string; nodeName: string; config: string; previousConfig: string; diff: string; validation: NodeCommandResponse }>;
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
  page: number;
  pageSize: number;
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

export interface PipePreviewResponse {
  valid: boolean;
  resource: PipeProtocol;
  configs: Array<{ nodeId: string; config: string; validation: NodeCommandResponse }>;
}
export interface PipeChannelRuntime {
  table: string | null;
  state: string | null;
  imported: number | null;
  exported: number | null;
}
export interface PipeRuntimeResponse {
  resourceId: string;
  lastCheckedAt: string;
  nodes: Array<{
    nodeId: string;
    ok: boolean;
    state: "up" | "down" | "start" | "disabled" | "not_configured" | "error" | "unknown";
    lastCheckedAt: string;
    primary: PipeChannelRuntime;
    peer: PipeChannelRuntime;
    error: string | null;
    raw: string;
  }>;
}
export interface PipeRoutesResponse {
  resourceId: string;
  nodeId: string;
  family: AddressFamily;
  side: "primary" | "peer";
  table: string;
  routes: RouteDetail[];
  truncated: boolean;
  limit: number;
}

export interface StaticPreviewResponse {
  valid: boolean;
  previewId: string;
  inventoryRevision: number | null;
  resource: StaticProtocol;
  configs: Array<{ nodeId: string; config: string; previousConfig: string; diff: string; validation: NodeCommandResponse }>;
}
export interface StaticRuntimeResponse {
  resourceId: string;
  nodeId: string;
  lastCheckedAt: string;
  state: "up" | "down" | "start" | "disabled" | "not_configured" | "error" | "unknown";
  table: string;
  imported: number | null;
  exported: number | null;
  error: string | null;
  raw: string;
}
export interface StaticRoutesResponse {
  resourceId: string;
  nodeId: string;
  family: AddressFamily;
  table: string;
  routes: RouteDetail[];
  truncated: boolean;
  limit: number;
}
