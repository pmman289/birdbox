import type { DashboardPeer } from "@birdbox/contracts/api";

export function isEbgpDashboardPeer(peer: DashboardPeer | null | undefined): peer is DashboardPeer {
  return Boolean(
    peer
    && peer.managedBy?.kind !== "ibgp-domain"
    && peer.session?.sessionType !== "ibgp",
  );
}
