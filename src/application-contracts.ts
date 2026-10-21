import type { PolicyCollection } from "../packages/contracts/src/inventory.js";

export interface MutationResult {
  status: number;
  payload: unknown;
}

export interface MutationService {
  createNodeSetupScript(body: Record<string, unknown>): Promise<MutationResult>;
  createNodeReinstallScript(nodeId: string): Promise<MutationResult>;
  getNodeSetupScript(deliveryToken: string): Promise<string>;
  createNodeAgentUpgradeScript(nodeId: string): Promise<MutationResult>;
  promoteNodeToAgent(nodeId: string): Promise<MutationResult>;
  testNode(body: Record<string, unknown>): Promise<MutationResult>;
  createNode(body: Record<string, unknown>): Promise<MutationResult>;
  updateNode(nodeId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteNode(nodeId: string, force: boolean): Promise<MutationResult>;
  createPeer(nodeId: string, body: Record<string, unknown>): Promise<MutationResult>;
  updatePeer(peerId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deletePeer(peerId: string): Promise<MutationResult>;
  previewStatic(body: Record<string, unknown>): Promise<MutationResult>;
  createStatic(body: Record<string, unknown>): Promise<MutationResult>;
  updateStatic(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteStatic(resourceId: string): Promise<MutationResult>;
  getSystemProtocolContext(kind: "directs" | "kernels", resourceId: string | null): Promise<MutationResult>;
  previewSystemProtocol(kind: "directs" | "kernels", body: Record<string, unknown>): Promise<MutationResult>;
  createDirect(body: Record<string, unknown>): Promise<MutationResult>;
  updateDirect(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteDirect(resourceId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  previewPipe(body: Record<string, unknown>): Promise<MutationResult>;
  createPipe(body: Record<string, unknown>): Promise<MutationResult>;
  updatePipe(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deletePipe(resourceId: string): Promise<MutationResult>;
  createKernel(body: Record<string, unknown>): Promise<MutationResult>;
  updateKernel(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteKernel(resourceId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  createRpki(body: Record<string, unknown>): Promise<MutationResult>;
  getRpkiContext(resourceId: string | null): Promise<MutationResult>;
  previewRpki(body: Record<string, unknown>): Promise<MutationResult>;
  updateRpki(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteRpki(resourceId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  getSourcePolicyPlan(resourceId: string, nodeId: string | null): Promise<MutationResult>;
  getSourcePolicyContext(resourceId?: string): Promise<MutationResult>;
  previewSourcePolicy(body: Record<string, unknown>): Promise<MutationResult>;
  createSourcePolicy(body: Record<string, unknown>): Promise<MutationResult>;
  updateSourcePolicy(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteSourcePolicy(resourceId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  createPolicy(collection: PolicyCollection, body: Record<string, unknown>): Promise<MutationResult>;
  getPolicyContext(collection: "functions" | "filters", resourceId: string | null): Promise<MutationResult>;
  previewPolicy(collection: "functions" | "filters", body: Record<string, unknown>): Promise<MutationResult>;
  getDefineContext(resourceId: string | null): Promise<MutationResult>;
  previewDefine(body: Record<string, unknown>): Promise<MutationResult>;
  movePolicy(
    collection: "functions" | "defines",
    resourceId: string,
    direction: "up" | "down",
  ): Promise<MutationResult>;
  updatePolicy(
    collection: PolicyCollection,
    resourceId: string,
    body: Record<string, unknown>,
  ): Promise<MutationResult>;
  deletePolicy(collection: PolicyCollection, resourceId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  resolveIrrDefine(body: Record<string, unknown>): Promise<MutationResult>;
  syncIrrDefine(resourceId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  previewSession(body: Record<string, unknown>): Promise<MutationResult>;
  getSessionContext(nodeId: string, peerId: string): Promise<MutationResult>;
  applySession(body: Record<string, unknown>): Promise<MutationResult>;
  deleteSession(sessionId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  listIbgpDomains(): Promise<MutationResult>;
  previewIbgpDomain(body: Record<string, unknown>): Promise<MutationResult>;
  createIbgpDomain(body: Record<string, unknown>): Promise<MutationResult>;
  updateIbgpDomain(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteIbgpDomain(domainId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  updateIbgpDomainLayout(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
  listOspfDomains(): Promise<MutationResult>;
  updateOspfLayout(body: Record<string, unknown>): Promise<MutationResult>;
  previewOspfDomain(body: Record<string, unknown>): Promise<MutationResult>;
  renderOspfDomain(body: Record<string, unknown>): Promise<MutationResult>;
  createOspfDomain(body: Record<string, unknown>): Promise<MutationResult>;
  updateOspfDomain(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteOspfDomain(domainId: string, body?: Record<string, unknown>): Promise<MutationResult>;
  updateOspfDomainLayout(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
}
