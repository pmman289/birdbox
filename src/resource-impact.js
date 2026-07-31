function scopeNodeIds(state, resource) {
  if (!resource || resource.nodeId === null) return (state.nodes ?? []).map((node) => node.id);
  return [resource.nodeId];
}

export function uniqueNodeIds(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

export function resourceNodeIds(state, resource) {
  return scopeNodeIds(state, resource);
}

export function resourceChangeNodeIds(state, previous, updated = previous) {
  return uniqueNodeIds(scopeNodeIds(state, previous), scopeNodeIds(state, updated));
}

export function resourceChangeSessions(state, nodeIds) {
  const ids = new Set(uniqueNodeIds(nodeIds));
  return (state.sessions ?? []).filter((session) => ids.has(session.nodeId));
}
