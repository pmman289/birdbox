import type { StaticRoute, StaticRouteAction, StaticRouteFilter, StaticRouteForwarding } from '@birdbox/contracts/inventory';
import { cloneReactive } from './clone-reactive';

/** Expand older action strings into the same forwarding model used by direct routes. */
export function defineRoute(prefix: string, defineId: string, action: StaticRouteAction, filter: StaticRouteFilter): StaticRoute {
  const forwarding: StaticRouteForwarding = typeof action === 'string'
    ? action.startsWith('via ')
      ? { type: 'via', nextHops: [{ address: action.slice(4).trim(), interface: null, weight: 1, bfd: false, onlink: false }], recursiveVia: null, enabled: true }
      : { type: (action === 'reject' ? 'unreachable' : action) as StaticRoute['type'], nextHops: [], recursiveVia: null, enabled: true }
    : cloneReactive(action);
  return { id: `define:${defineId}:${prefix}`, prefix, ...forwarding, filter: cloneReactive(filter) };
}

export function routeForwarding(route: StaticRoute): StaticRouteForwarding {
  return cloneReactive({ type: route.type, nextHops: route.nextHops, recursiveVia: route.recursiveVia, enabled: route.enabled });
}
