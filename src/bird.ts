export { birdSourceReferencesSymbol, makeStaticProtocolName } from "./bird-identifiers.js";
export { validateInventory } from "./bird-inventory.js";
export { RUNTIME, normalizeNode, normalizePeer } from "./bird-normalize-common.js";
export { normalizeDefine, normalizePolicyFilter, normalizePolicyFunction } from "./bird-policy-resources.js";
export { normalizeBirdPrefixPattern, parseBirdPrefixEntries } from "./bird-prefix.js";
export { locateStaticRouteDiagnostic, renderBirdConfig, renderBirdConfigBundle } from "./bird-render.js";
export { normalizeRPKI } from "./bird-rpki.js";
export {
  ACTIVE_BIRD_INCLUDE_AWK,
  applyStagedConfig,
  checkIncludeNodeAccess,
  configureManagedSsh,
  inspectNode,
  inspectOspfRuntime,
  inspectProtocolRoutes,
  inspectRoutePath,
  loadSeedNodes,
  rollbackNode,
  runOnNode,
  saveJsonAtomic,
  setProtocolState,
  stageAndValidate,
  startProtocol,
  stopProtocol,
} from "./bird-runtime.js";
export { parseProtocolStatus, parseProtocolStatuses, parseRouteDetails, parseRoutePath } from "./bird-runtime-parser.js";
export { normalizeSession } from "./bird-session.js";
export { normalizeStaticProtocol } from "./bird-static.js";
export {
  normalizeSourcePolicyEgress,
  prepareSourcePolicyEgress,
  renderSourcePolicyEgress,
  sourcePolicyManualPlan,
  sourcePolicyNames,
  sourcePolicyRules,
} from "./bird-source-policy.js";
export { expandIbgpDomain, normalizeIbgpDomain } from "./ibgp-domain.js";
export { normalizeOspfDomain, ospfDomainNodeIds, ospfProtocolName } from "./ospf.js";
