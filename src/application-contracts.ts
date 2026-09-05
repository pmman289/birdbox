import type { PolicyCollection } from "../packages/contracts/src/inventory.js";

export interface MutationResult {
  status: number;
  payload: unknown;
}

export interface MutationService {
  createNodeSetupScript(body: Record<string, unknown>): Promise<MutationResult>;
  testNode(body: Record<string, unknown>): Promise<MutationResult>;
  createNode(body: Record<string, unknown>): Promise<MutationResult>;
  updateNode(nodeId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteNode(nodeId: string, force: boolean): Promise<MutationResult>;
  createPeer(nodeId: string, body: Record<string, unknown>): Promise<MutationResult>;
  updatePeer(peerId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deletePeer(peerId: string): Promise<MutationResult>;
  createStatic(body: Record<string, unknown>): Promise<MutationResult>;
  updateStatic(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteStatic(resourceId: string): Promise<MutationResult>;
  createRpki(body: Record<string, unknown>): Promise<MutationResult>;
  updateRpki(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteRpki(resourceId: string): Promise<MutationResult>;
  getSourcePolicyPlan(resourceId: string, nodeId: string | null): Promise<MutationResult>;
  previewSourcePolicy(body: Record<string, unknown>): Promise<MutationResult>;
  createSourcePolicy(body: Record<string, unknown>): Promise<MutationResult>;
  updateSourcePolicy(resourceId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteSourcePolicy(resourceId: string): Promise<MutationResult>;
  createPolicy(collection: PolicyCollection, body: Record<string, unknown>): Promise<MutationResult>;
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
  deletePolicy(collection: PolicyCollection, resourceId: string): Promise<MutationResult>;
  resolveIrrDefine(body: Record<string, unknown>): Promise<MutationResult>;
  syncIrrDefine(resourceId: string): Promise<MutationResult>;
  previewSession(body: Record<string, unknown>): Promise<MutationResult>;
  applySession(body: Record<string, unknown>): Promise<MutationResult>;
  deleteSession(sessionId: string): Promise<MutationResult>;
  listIbgpDomains(): Promise<MutationResult>;
  previewIbgpDomain(body: Record<string, unknown>): Promise<MutationResult>;
  createIbgpDomain(body: Record<string, unknown>): Promise<MutationResult>;
  updateIbgpDomain(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteIbgpDomain(domainId: string): Promise<MutationResult>;
  updateIbgpDomainLayout(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
  listOspfDomains(): Promise<MutationResult>;
  updateOspfLayout(body: Record<string, unknown>): Promise<MutationResult>;
  previewOspfDomain(body: Record<string, unknown>): Promise<MutationResult>;
  createOspfDomain(body: Record<string, unknown>): Promise<MutationResult>;
  updateOspfDomain(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
  deleteOspfDomain(domainId: string): Promise<MutationResult>;
  updateOspfDomainLayout(domainId: string, body: Record<string, unknown>): Promise<MutationResult>;
}
