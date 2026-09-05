<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import PolicyEditor from "../sessions/PolicyEditor.vue";
import type {
  ChannelPolicy,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
  OspfInterfaceOptions,
  OspfProtocolOptions,
  OspfAreaOptions,
  OspfVirtualLink,
  OspfPasswordOptions,
} from "@birdbox/contracts/inventory";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import type { RoutePathResponse } from "@birdbox/contracts/api";

type OspfVersion = "ospfv2" | "ospfv3";
interface OspfNode {
  id: string;
  name: string;
  routerId: string;
  v2: string;
  v3: string;
  neighbors: number;
  routes: number;
}
interface OspfLink {
  id: string;
  from: string;
  to: string;
  area: string;
  localInterface: string;
  remoteInterface: string;
  cost: number;
  hello: number;
  dead: number;
  mode: "active" | "passive";
  auth: "none" | "simple" | "md5" | "ipsec";
  options?: OspfInterfaceOptions;
}
interface OspfRuntimeSummary {
  v2: string;
  v3: string;
  neighbors: number;
  routes: number;
  neighborDetails: OspfNeighborRuntime[];
  routeDetails: OspfRouteRuntime[];
  routesTruncated: boolean;
}
interface OspfNeighborRuntime {
  version: "ospfv2" | "ospfv3";
  routerId: string;
  priority: number | null;
  state: string;
  deadTime: number | null;
  interface: string;
  address: string;
}
interface OspfRouteRuntime {
  version: "ospfv2" | "ospfv3";
  prefix: string;
  summary: string;
  details: string;
}
interface OspfRuntimeNode {
  nodeId: string;
  name: string;
    runtime: {
      v2: { state: string | null; neighbors: number; routes: number | null };
      v3: { state: string | null; neighbors: number; routes: number | null };
      neighbors: OspfNeighborRuntime[];
      routes: OspfRouteRuntime[];
      routesTruncated: boolean;
    };
}

const { dashboard } = useDashboardStore();
const runtimeByNode = ref<Record<string, OspfRuntimeSummary>>({});
const runtimeDialog = ref<HTMLDialogElement | null>(null);
const runtimeDetailKind = ref<"neighbors" | "routes" | "areas" | null>(null);
const routePathDialog = ref<HTMLDialogElement | null>(null);
const previewDialog = ref<HTMLDialogElement | null>(null);
const routePathTarget = ref("");
const routePathStartNodeId = ref("");
const routePathPending = ref(false);
const routePathError = ref("");
interface OspfPathStep {
  nodeId: string;
  route: RoutePathResponse["routes"][number];
  nextNodeId: string | null;
  linkId: string | null;
}
const routePathSteps = ref<OspfPathStep[]>([]);
const routePathCanvas = ref<HTMLElement | null>(null);
const routePathScale = ref(1);
const routePathPan = ref({ x: 0, y: 0 });
const routePathDragging = ref<{ pointerId: number; x: number; y: number } | null>(null);
const interfaceOptionsByNode = ref<Record<string, string[]>>({});
const nodes = computed<OspfNode[]>(
  () =>
    dashboard.value?.inventory.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      routerId: node.routerId,
      v2: runtimeByNode.value[node.id]?.v2 ?? "未检查",
      v3: runtimeByNode.value[node.id]?.v3 ?? "未检查",
      neighbors: runtimeByNode.value[node.id]?.neighbors ?? 0,
      routes: runtimeByNode.value[node.id]?.routes ?? 0,
    })) ?? [],
);
const selectedNodeId = ref("");
const enabledVersions = ref<OspfVersion[]>(["ospfv2"]);
const enabled = ref(true);
const routerId = ref("172.20.177.7");
const bfd = ref(false);
const gracefulRestart = ref(false);
const redistributeStatic = ref(false);
const showAdvanced = ref(false);
const protocolOptions = ref<OspfProtocolOptions>({
  rfc1583compat: false,
  rfc5838: true,
  instanceId: null,
  stubRouter: false,
  tick: null,
  ecmp: null,
  ecmpLimit: null,
  mergeExternal: false,
  gracefulRestartMode: "aware",
  gracefulRestartTime: null,
});
const areaOptions = ref<Record<string, OspfAreaOptions>>({});
const virtualLinks = ref<OspfVirtualLink[]>([]);
const configuredAreas = computed(() => [...new Set([...links.value.map((link) => link.area), ...Object.keys(areaOptions.value)])].sort());
function ensureAreaOptions(area: string): OspfAreaOptions {
  if (!areaOptions.value[area]) areaOptions.value = { ...areaOptions.value, [area]: {} };
  return areaOptions.value[area]!;
}
function addVirtualLink(): void {
  const area = configuredAreas.value[0] ?? "0.0.0.0";
  virtualLinks.value = [...virtualLinks.value, { id: "0.0.0.0", area, authentication: "none", passwordOptions: {} }];
}
function ensurePasswordOptions(options: OspfInterfaceOptions): OspfPasswordOptions {
  if (!options.passwordOptions) options.passwordOptions = {};
  return options.passwordOptions;
}
function ensureVirtualPasswordOptions(link: OspfVirtualLink): OspfPasswordOptions {
  if (!link.passwordOptions) link.passwordOptions = {};
  return link.passwordOptions;
}
function areaListText(area: string, key: "networks" | "external" | "stubnets"): string {
  const items = ensureAreaOptions(area)[key] as Array<{ prefix: string }> | undefined;
  return items?.map((item) => item.prefix).join(", ") ?? "";
}
function setAreaListText(area: string, key: "networks" | "external" | "stubnets", value: string): void {
  const prefixes = value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const current = ensureAreaOptions(area);
  const items = prefixes.map((prefix) => ({ prefix }));
  areaOptions.value = { ...areaOptions.value, [area]: { ...current, [key]: items } };
}
function addAreaEntry(area: string, key: "networks" | "external" | "stubnets"): void {
  const current = ensureAreaOptions(area);
  const items = [...((current[key] ?? []) as Array<Record<string, unknown>>), { prefix: "" }];
  areaOptions.value = { ...areaOptions.value, [area]: { ...current, [key]: items } };
}
function removeAreaEntry(area: string, key: "networks" | "external" | "stubnets", index: number): void {
  const current = ensureAreaOptions(area);
  const items = [...((current[key] ?? []) as Array<Record<string, unknown>>)].filter((_, itemIndex) => itemIndex !== index);
  areaOptions.value = { ...areaOptions.value, [area]: { ...current, [key]: items } };
}
function neighborText(link: OspfLink): string {
  return link.options?.neighbors?.map((item) => `${item.address}${item.eligible ? " eligible" : ""}`).join(", ") ?? "";
}
function setNeighborText(link: OspfLink, value: string): void {
  if (!link.options) link.options = { type: "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [], passwordOptions: {} };
  link.options.neighbors = value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => ({ address: item.replace(/\s+eligible$/i, "").trim(), eligible: /\s+eligible$/i.test(item) }));
}
const search = ref("");
// The node API intentionally does not expose every OS interface. Keep a small
// editable catalogue for the prototype and retain the current value when a
// saved link uses an interface that is not in the catalogue.
const knownInterfaces = [
  "lo",
  "eth0",
  "wg-hytronhk",
  "bb02-03",
  "bb02-04",
  "bb03-04",
];
const links = ref<OspfLink[]>([]);
const selectedLinkId = ref<string | null>(null);
const showAddLink = ref(false);
const linkDraftFrom = ref("mrouter");
const linkDraftTo = ref("nbcjp");
const linkDraftLocalInterface = ref("");
const linkDraftRemoteInterface = ref("");
const linkDraftArea = ref("0.0.0.0");
const linkDraftError = ref("");
const defaultImportPolicy = (): ChannelPolicy => ({
  mode: "combined",
  formAction: "all",
  filterId: null,
  steps: [{ type: "form" }],
});
const defaultExportPolicy = (): ChannelPolicy => ({
  mode: "combined",
  formAction: "none",
  filterId: null,
  steps: [{ type: "form" }],
});
const ospfImportPolicies = ref<Record<OspfVersion, ChannelPolicy>>({
  ospfv2: defaultImportPolicy(),
  ospfv3: defaultImportPolicy(),
});
const ospfExportPolicies = ref<Record<OspfVersion, ChannelPolicy>>({
  ospfv2: defaultExportPolicy(),
  ospfv3: defaultExportPolicy(),
});
const ospfExportDefineIds = ref<Record<OspfVersion, string | null>>({
  ospfv2: null,
  ospfv3: null,
});
const policyDefines = ref<PolicyDefine[]>([]);
const policyFunctions = ref<PolicyFunction[]>([]);
const policyFilters = ref<PolicyFilter[]>([]);
interface OspfNodePosition {
  x: number;
  y: number;
  locked?: boolean;
}
const TOPOLOGY_WIDTH = 1600;
const TOPOLOGY_HEIGHT = 1000;
interface OspfNodeConfig {
  nodeId: string;
  enabled: boolean;
  versions: OspfVersion[];
  routerId: string | null;
  importPolicies: Record<OspfVersion, ChannelPolicy>;
  exportPolicies: Record<OspfVersion, ChannelPolicy>;
  exportDefineIds: Record<OspfVersion, string | null>;
  bfd?: boolean;
  gracefulRestart?: boolean;
  redistributeStatic?: boolean;
  protocolOptions?: OspfProtocolOptions;
  areaOptions?: Record<string, OspfAreaOptions>;
  virtualLinks?: OspfVirtualLink[];
}
const nodeConfigs = ref<Record<string, OspfNodeConfig>>({});
const ospfDomainId = ref<string | null>(null);
const selectedLink = computed(
  () =>
    topologyLinks.value.find((link) => link.id === selectedLinkId.value) ??
    null,
);
const nodePosition = ref<Record<string, OspfNodePosition>>({});
const dragging = ref<{ id: string; dx: number; dy: number; moved: boolean; pointerId: number; target: HTMLElement } | null>(null);
const suppressNodeClickId = ref<string | null>(null);
let suppressNodeClickTimer: number | null = null;
const topologyCanvas = ref<HTMLElement | null>(null);
const topologyScale = ref(1);
const topologyPan = ref({ x: TOPOLOGY_WIDTH / 2 - 270, y: TOPOLOGY_HEIGHT / 2 - 165 });
const topologyPanDragging = ref<{ pointerId: number; x: number; y: number } | null>(null);
const layoutSaving = ref(false);
const layoutSaveError = ref("");
let layoutSaveQueue: Promise<void> = Promise.resolve();
let runtimeTimer: number | null = null;
const selectedNode = computed(
  () =>
    nodes.value.find((node) => node.id === selectedNodeId.value) ??
    nodes.value[0],
);
const selectedRuntime = computed(
  () =>
    runtimeByNode.value[selectedNodeId.value] ?? {
      v2: "未检查",
      v3: "未检查",
      neighbors: 0,
      routes: 0,
      neighborDetails: [],
      routeDetails: [],
      routesTruncated: false,
    },
);
// Older controller instances may expose the aggregate counters before the
// detail fields were added. Keep the dialog explicit about that mismatch
// instead of presenting a misleading empty result.
const neighborDetailsUnavailable = computed(
  () => selectedRuntime.value.neighbors > 0 && selectedRuntime.value.neighborDetails.length === 0,
);
const routeDetailsUnavailable = computed(
  () => selectedRuntime.value.routes > 0 && selectedRuntime.value.routeDetails.length === 0,
);
const selectedAreaDetails = computed(() => {
  const areas = [...new Set([
    ...selectedNodeLinks.value.map((link) => link.area),
    ...Object.keys(areaOptions.value),
  ])].sort();
  return areas.map((area) => ({
    area,
    links: selectedNodeLinks.value.filter((link) => link.area === area),
    options: areaOptions.value[area] ?? {},
  }));
});
const runtimeDetailTitle = computed(() => {
  if (runtimeDetailKind.value === "neighbors") return "OSPF 邻居详情";
  if (runtimeDetailKind.value === "routes") return "OSPF 路由详情";
  return "OSPF Area 详情";
});
function openRuntimeDetails(kind: "neighbors" | "routes" | "areas"): void {
  runtimeDetailKind.value = kind;
  if (!runtimeDialog.value?.open) runtimeDialog.value?.showModal();
}
function closeRuntimeDetails(): void {
  runtimeDialog.value?.close();
  runtimeDetailKind.value = null;
}
const routePathNodeIds = computed(() => new Set([
  routePathStartNodeId.value,
  ...routePathSteps.value.flatMap((step) => [step.nodeId, step.nextNodeId ?? ""]),
].filter(Boolean)));
const routePathLinkDirections = computed(() => {
  const directions = new Map<string, "forward" | "reverse">();
  for (const step of routePathSteps.value) {
    if (!step.linkId || !step.nextNodeId) continue;
    const link = topologyLinks.value.find((item) => item.id === step.linkId);
    if (!link) continue;
    directions.set(step.linkId, link.from === step.nodeId ? "forward" : "reverse");
  }
  return directions;
});
function pathLinkForHop(nodeId: string, interfaceName: string | null): OspfLink | null {
  if (!interfaceName) return null;
  return topologyLinks.value.find((link) =>
    (link.from === nodeId && link.localInterface === interfaceName)
      || (link.to === nodeId && link.remoteInterface === interfaceName),
  ) ?? null;
}
function clampRoutePathScale(value: number): number {
  return Math.max(0.65, Math.min(2.5, Number(value.toFixed(2))));
}
function zoomRoutePath(delta: number): void {
  routePathScale.value = clampRoutePathScale(routePathScale.value + delta);
}
function resetRoutePathViewport(): void {
  routePathScale.value = 1;
  routePathPan.value = { x: 0, y: 0 };
}
function handleRoutePathWheel(event: WheelEvent): void {
  zoomRoutePath(event.deltaY < 0 ? 0.1 : -0.1);
}
function startRoutePathPan(event: PointerEvent): void {
  if (event.button !== 0 || (event.target as HTMLElement)?.closest("button, input, select")) return;
  const canvas = routePathCanvas.value;
  if (!canvas) return;
  routePathDragging.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
}
function moveRoutePathPan(event: PointerEvent): void {
  const draggingState = routePathDragging.value;
  if (!draggingState || draggingState.pointerId !== event.pointerId) return;
  routePathPan.value = {
    x: routePathPan.value.x + event.clientX - draggingState.x,
    y: routePathPan.value.y + event.clientY - draggingState.y,
  };
  draggingState.x = event.clientX;
  draggingState.y = event.clientY;
}
function stopRoutePathPan(event?: PointerEvent): void {
  const draggingState = routePathDragging.value;
  if (!draggingState || (event && event.pointerId !== draggingState.pointerId)) return;
  const canvas = routePathCanvas.value;
  if (canvas?.hasPointerCapture(draggingState.pointerId)) canvas.releasePointerCapture(draggingState.pointerId);
  routePathDragging.value = null;
}
function pathArrowPoints(link: OspfLink, direction: "forward" | "reverse"): string {
  const geometry = linkGeometry(link);
  let dx = geometry.x2 - geometry.x1;
  let dy = geometry.y2 - geometry.y1;
  if (direction === "reverse") {
    dx = -dx;
    dy = -dy;
  }
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const midX = (geometry.x1 + geometry.x2) / 2;
  const midY = (geometry.y1 + geometry.y2) / 2;
  const tipX = midX + ux * 9;
  const tipY = midY + uy * 9;
  const baseX = midX - ux * 6;
  const baseY = midY - uy * 6;
  return `${tipX},${tipY} ${baseX + px * 5},${baseY + py * 5} ${baseX - px * 5},${baseY - py * 5}`;
}
async function queryRoutePath(): Promise<void> {
  const target = routePathTarget.value.trim();
  const startNodeId = routePathStartNodeId.value;
  if (!target || !startNodeId || routePathPending.value) return;
  routePathPending.value = true;
  routePathError.value = "";
  routePathSteps.value = [];
  try {
    const steps: OspfPathStep[] = [];
    const visited = new Set<string>();
    let currentNodeId: string | null = startNodeId;
    for (let depth = 0; depth < 16 && currentNodeId; depth += 1) {
      if (visited.has(currentNodeId)) break;
      visited.add(currentNodeId);
      const response: RoutePathResponse = await api<RoutePathResponse>(
        `/api/nodes/${encodeURIComponent(currentNodeId)}/route-path?target=${encodeURIComponent(target)}`,
        { timeoutMs: 30_000 },
      );
      const route: RoutePathResponse["routes"][number] | undefined = response.routes[0];
      if (!route) {
        if (!steps.length && response.error) routePathError.value = response.error;
        break;
      }
      const hop: RoutePathResponse["routes"][number]["nextHops"][number] | undefined = route.nextHops[0];
      const link: OspfLink | null = hop ? pathLinkForHop(currentNodeId, hop.interface) : null;
      const nextNodeId: string | null = hop?.address && link
        ? (link.from === currentNodeId ? link.to : link.from)
        : null;
      steps.push({ nodeId: currentNodeId, route, nextNodeId, linkId: link?.id ?? null });
      if (!nextNodeId || !hop?.address) break;
      currentNodeId = nextNodeId;
    }
    routePathSteps.value = steps;
    if (!steps.length && !routePathError.value) routePathError.value = "没有找到到达该目标 IP 的路径";
  } catch (error) {
    routePathError.value = error instanceof Error ? error.message : "路径查询失败";
  } finally {
    routePathPending.value = false;
  }
}
function openRoutePath(): void {
  const startNodeId = selectedNodeId.value || nodes.value[0]?.id || "";
  if (!startNodeId) return;
  routePathStartNodeId.value = startNodeId;
  routePathTarget.value = "";
  routePathError.value = "";
  routePathSteps.value = [];
  resetRoutePathViewport();
  routePathDialog.value?.showModal();
}
function closeRoutePath(): void {
  routePathDialog.value?.close();
  routePathPending.value = false;
  routePathDragging.value = null;
}
function openOspfPreview(): void {
  previewDialog.value?.showModal();
}
function closeOspfPreview(): void {
  previewDialog.value?.close();
}
const filteredNodes = computed(() =>
  nodes.value.filter((node) =>
    `${node.name} ${node.routerId}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const availableDefines = computed(
  () => dashboard.value?.inventory.defines ?? policyDefines.value,
);
const availableFunctions = computed(
  () => dashboard.value?.inventory.functions ?? policyFunctions.value,
);
const availableFilters = computed(
  () => dashboard.value?.inventory.filters ?? policyFilters.value,
);
function interfacesForNode(nodeId: string, current = ""): string[] {
  const discovered = interfaceOptionsByNode.value[nodeId] ?? [];
  const values = [...new Set([...discovered, ...knownInterfaces])];
  return current && !values.includes(current) ? [current, ...values] : values;
}
const allInterfaces = computed(() => [
  ...new Set([
    ...knownInterfaces,
    ...Object.values(interfaceOptionsByNode.value).flat(),
  ]),
]);
const selectedNodeLinks = computed(() =>
  topologyLinks.value.filter(
    (link) =>
      link.from === selectedNodeId.value || link.to === selectedNodeId.value,
  ),
);
const topologyLinks = computed(() => {
  const nodeIds = new Set(nodes.value.map((node) => node.id));
  return links.value.filter(
    (link) => nodeIds.has(link.from) && nodeIds.has(link.to),
  );
});
function ensureNodePositions(nextNodes: OspfNode[] = nodes.value): void {
  const validIds = new Set(nextNodes.map((node) => node.id));
  const next = Object.fromEntries(
    Object.entries(nodePosition.value).filter(([id]) => validIds.has(id)),
  ) as Record<string, OspfNodePosition>;
  // During bootstrap the inventory and OSPF domain load independently. Keep
  // the server layout until node IDs are available, then prune stale entries.
  if (!nextNodes.length) return;
  nextNodes.forEach((node, index) => {
    if (next[node.id]) return;
    const column = index % 5;
    const row = Math.floor(index / 5);
    next[node.id] = { x: 180 + column * 280, y: 140 + row * 190 };
  });
  nodePosition.value = next;
  centerTopologyView(next);
}
function resetTopologyLayout(): void {
  const next: Record<string, OspfNodePosition> = {};
  nodes.value.forEach((node, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    next[node.id] = { x: 180 + column * 280, y: 140 + row * 190 };
  });
  nodePosition.value = next;
  centerTopologyView(next);
  if (ospfDomainId.value) {
    layoutSaveQueue = layoutSaveQueue.then(() => saveLayout());
  }
}
watch(() => nodes.value.map((node) => node.id).join(","), () => {
  const nextNodes = nodes.value;
  if (!nextNodes.length) {
    selectedNodeId.value = "";
    selectedLinkId.value = null;
    return;
  }
  if (!nextNodes.some((node) => node.id === selectedNodeId.value))
    selectedNodeId.value = nextNodes[0]!.id;
  ensureNodePositions(nextNodes);
});
watch(
  [selectedNodeId, () => nodeConfigs.value[selectedNodeId.value]],
  ([nodeId, config]) => {
    // Always hydrate the editor when the selection changes. Without a saved
    // config, this also replaces stale prototype defaults with the node's
    // actual Router ID and disables the unsaved node until explicitly enabled.
    if (nodeId) loadNodeConfig(nodeId);
  },
);
function nodePairKey(left: string, right: string): string {
  return [left, right].sort().join("::");
}
function parallelLinks(link: OspfLink): OspfLink[] {
  return links.value.filter(
    (item) =>
      nodePairKey(item.from, item.to) === nodePairKey(link.from, link.to),
  );
}
function linkOffset(link: OspfLink): number {
  const siblings = parallelLinks(link);
  const index = siblings.findIndex((item) => item.id === link.id);
  return (index - (siblings.length - 1) / 2) * 12;
}
function linkGeometry(link: OspfLink): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const from = linkPosition(link.from);
  const to = linkPosition(link.to);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = linkOffset(link);
  const ox = (-dy / length) * offset;
  const oy = (dx / length) * offset;
  return { x1: from.x + ox, y1: from.y + oy, x2: to.x + ox, y2: to.y + oy };
}
function linkCostInput(link: OspfLink): number {
  return parallelLinks(link)[0]?.cost ?? link.cost;
}
function setLinkCost(link: OspfLink, value: number): void {
  if (!Number.isFinite(value)) return;
  for (const sibling of parallelLinks(link))
    sibling.cost = Math.max(1, Math.min(65535, Math.round(value)));
}
function interfaceInUse(
  nodeId: string,
  interfaceName: string,
  linkId: string,
): boolean {
  return false;
}
function policyText(
  policy: ChannelPolicy,
  direction: "import" | "export",
  defineId: string | null,
  redistributeStatic = false,
): string {
  if (policy.mode === "custom") {
    const filter = availableFilters.value.find((item) => item.id === policy.filterId);
    return `${direction} filter ${filter?.name ?? policy.filterId ?? "<未选择 Filter>"}`;
  }
  const define = defineId ? availableDefines.value.find((item) => item.id === defineId) : null;
  const hasFunctionStep = policy.mode === "combined" && policy.steps.some((step) => step.type === "function");
  if (!hasFunctionStep) {
    if (direction === "import") return policy.formAction === "all" ? "import all" : "import none";
    if (redistributeStatic) {
      const lines: string[] = [];
      if (policy.formAction === "cidr") {
        lines.push(`    if net ~ ${define?.name ?? defineId ?? "<未选择 CIDR>"} then accept;`);
      }
      // Keep static redistribution immediately before the terminal action so
      // any Function steps above it still run first.
      lines.push("    if source = RTS_STATIC then accept;");
      lines.push(`    ${policy.formAction === "all" ? "accept" : "reject"};`);
      return `export filter {\n${lines.join("\n")}\n  }`;
    }
    return policy.formAction === "all"
      ? "export all"
      : policy.formAction === "cidr"
        ? `export filter { if net ~ ${define?.name ?? defineId ?? "<未选择 CIDR>"} then accept; reject; }`
        : "export none";
  }
  const lines = policy.steps.map((step) => {
    if (step.type === "form") {
      if (direction === "import") return policy.formAction === "all" ? "    accept;" : "    reject;";
      if (policy.formAction === "all") return "    accept;";
      if (policy.formAction === "cidr") return `    if net ~ ${define?.name ?? defineId ?? "<未选择 CIDR>"} then accept;`;
      return "";
    }
    const fn = availableFunctions.value.find((item) => item.id === step.functionId);
    const name = fn?.name ?? step.functionId;
    if (step.action === "execute") return `    ${name}();`;
    return `    if ${name}() then ${step.action};`;
  }).filter(Boolean);
  if (direction === "export" && redistributeStatic) lines.push("    if source = RTS_STATIC then accept;");
  if (direction === "export") lines.push("    reject;");
  return `${direction} filter {\n${lines.join("\n")}\n  }`;
}
function updateImportPolicy(version: OspfVersion, policy: ChannelPolicy): void {
  ospfImportPolicies.value = { ...ospfImportPolicies.value, [version]: policy };
}
function updateExportPolicy(version: OspfVersion, policy: ChannelPolicy): void {
  ospfExportPolicies.value = { ...ospfExportPolicies.value, [version]: policy };
}
function updateExportDefine(
  version: OspfVersion,
  defineId: string | null,
): void {
  ospfExportDefineIds.value = {
    ...ospfExportDefineIds.value,
    [version]: defineId,
  };
}
function copyPolicy(policy: ChannelPolicy): ChannelPolicy {
  return { ...policy, steps: policy.steps.map((step) => ({ ...step })) };
}
function saveSelectedNodeConfig(): void {
  nodeConfigs.value = {
    ...nodeConfigs.value,
    [selectedNodeId.value]: {
      nodeId: selectedNodeId.value,
      enabled: enabled.value,
      versions: [...enabledVersions.value],
      routerId: routerId.value || null,
      importPolicies: {
        ospfv2: copyPolicy(ospfImportPolicies.value.ospfv2),
        ospfv3: copyPolicy(ospfImportPolicies.value.ospfv3),
      },
      exportPolicies: {
        ospfv2: copyPolicy(ospfExportPolicies.value.ospfv2),
        ospfv3: copyPolicy(ospfExportPolicies.value.ospfv3),
      },
      exportDefineIds: { ...ospfExportDefineIds.value },
      bfd: bfd.value,
      gracefulRestart: gracefulRestart.value,
      redistributeStatic: redistributeStatic.value,
      protocolOptions: { ...protocolOptions.value },
      areaOptions: JSON.parse(JSON.stringify(areaOptions.value)) as Record<string, OspfAreaOptions>,
      virtualLinks: JSON.parse(JSON.stringify(virtualLinks.value)) as OspfVirtualLink[],
    },
  };
}
function domainPayload(): Record<string, unknown> {
  saveSelectedNodeConfig();
  const configs = nodes.value.map(
    (node) =>
      nodeConfigs.value[node.id] ?? {
        nodeId: node.id,
        enabled: false,
        versions: ["ospfv2"],
        routerId: node.routerId || null,
        importPolicies: {
          ospfv2: defaultImportPolicy(),
          ospfv3: defaultImportPolicy(),
        },
        exportPolicies: {
          ospfv2: defaultExportPolicy(),
          ospfv3: defaultExportPolicy(),
        },
        exportDefineIds: { ospfv2: null, ospfv3: null },
        bfd: false,
        gracefulRestart: false,
        redistributeStatic: false,
        protocolOptions: {},
        areaOptions: {},
        virtualLinks: [],
      },
  );
  return {
    id: ospfDomainId.value ?? undefined,
    name: "默认 OSPF 域",
    nodeConfigs: configs,
    links: links.value.map((link) => ({
      id: link.id,
      fromNodeId: link.from,
      toNodeId: link.to,
      area: link.area,
      localInterface: link.localInterface,
      remoteInterface: link.remoteInterface,
      cost: link.cost,
      hello: link.hello,
      dead: link.dead,
      passive: link.mode === "passive",
      authentication: link.auth,
      options: link.options,
    })),
    layout: nodePosition.value,
  };
}
async function saveOspf(): Promise<void> {
  const payload = domainPayload();
  const response = await api<{ domain: { id: string } }>(
    ospfDomainId.value ? `/api/ospf/${ospfDomainId.value}` : "/api/ospf",
    {
      method: ospfDomainId.value ? "PUT" : "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    },
  );
  ospfDomainId.value = response.domain.id;
  await refreshOspfRuntime();
}
async function previewOspf(): Promise<void> {
  await api("/api/ospf/preview", {
    method: "POST",
    body: JSON.stringify(domainPayload()),
    headers: { "content-type": "application/json" },
  });
}
function loadNodeConfig(nodeId: string): void {
  const config = nodeConfigs.value[nodeId];
  if (!config) {
    enabled.value = false;
    enabledVersions.value = ["ospfv2"];
    routerId.value = nodes.value.find((node) => node.id === nodeId)?.routerId ?? "";
    bfd.value = false;
    gracefulRestart.value = false;
    redistributeStatic.value = false;
    protocolOptions.value = { rfc1583compat: false, rfc5838: true, instanceId: null, stubRouter: false, tick: null, ecmp: null, ecmpLimit: null, mergeExternal: false, gracefulRestartMode: "aware", gracefulRestartTime: null };
    areaOptions.value = {};
    virtualLinks.value = [];
    return;
  }
  enabled.value = config.enabled;
  enabledVersions.value = [...config.versions];
  routerId.value = config.routerId ?? "";
  bfd.value = config.bfd === true;
  gracefulRestart.value = config.gracefulRestart === true;
  redistributeStatic.value = config.redistributeStatic === true;
  protocolOptions.value = { ...protocolOptions.value, ...(config.protocolOptions ?? {}) };
  areaOptions.value = JSON.parse(JSON.stringify(config.areaOptions ?? {})) as Record<string, OspfAreaOptions>;
  virtualLinks.value = JSON.parse(JSON.stringify(config.virtualLinks ?? [])) as OspfVirtualLink[];
  ospfImportPolicies.value = {
    ospfv2: copyPolicy(config.importPolicies.ospfv2),
    ospfv3: copyPolicy(config.importPolicies.ospfv3),
  };
  ospfExportPolicies.value = {
    ospfv2: copyPolicy(config.exportPolicies.ospfv2),
    ospfv3: copyPolicy(config.exportPolicies.ospfv3),
  };
  ospfExportDefineIds.value = { ...config.exportDefineIds };
}
function toggleVersion(version: OspfVersion, checked: boolean): void {
  const current = enabledVersions.value;
  if (!checked && current.length === 1) return;
  enabledVersions.value = checked
    ? current.includes(version)
      ? current
      : [...current, version]
    : current.filter((item) => item !== version);
}
function interfacePreviewClause(link: OspfLink, peerName: string): string {
  const options = link.options ?? {};
  const directives: string[] = [];
  const birdString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (options.instanceId != null) directives.push(`instance ${options.instanceId};`);
  directives.push(`cost ${linkCostInput(link)};`, `hello ${link.hello};`);
  if (options.poll != null) directives.push(`poll ${options.poll};`);
  if (options.retransmit != null) directives.push(`retransmit ${options.retransmit};`);
  if (options.transmitDelay != null) directives.push(`transmit delay ${options.transmitDelay};`);
  if (options.priority != null) directives.push(`priority ${options.priority};`);
  if (options.wait != null) directives.push(`wait ${options.wait};`);
  directives.push(options.deadMode === "seconds"
    ? `dead ${link.dead};`
    : `dead count ${Math.max(1, Math.floor(link.dead / Math.max(1, link.hello)))};`);
  if (link.mode === "passive" || options.stub) directives.push("stub yes;");
  if (options.rxBuffer != null) directives.push(`rx buffer ${options.rxBuffer};`);
  if (options.txLength != null) directives.push(`tx length ${options.txLength};`);
  directives.push(`type ${options.type ?? "ptp"};`);
  if (options.linkLsaSuppression) directives.push("link lsa suppression yes;");
  if (options.strictNonbroadcast) directives.push("strict nonbroadcast yes;");
  if (options.realBroadcast) directives.push("real broadcast yes;");
  if (options.ptpNetmask) directives.push("ptp netmask yes;");
  if (options.ptpAddress) directives.push("ptp address yes;");
  if (options.secondary) directives.push("secondary yes;");
  if (options.checkLink === false) directives.push("check link no;");
  if (options.bfd ?? bfd.value) directives.push("bfd yes;");
  if (options.ecmpWeight != null) directives.push(`ecmp weight ${options.ecmpWeight};`);
  if (options.ttlSecurity === "on") directives.push("ttl security yes;");
  else if (options.ttlSecurity === "tx-only") directives.push("ttl security tx only;");
  if (options.txClass != null) directives.push(`tx class ${options.txClass};`);
  if (options.txDscp != null) directives.push(`tx dscp ${options.txDscp};`);
  if (options.txPriority != null) directives.push(`tx priority ${options.txPriority};`);
  if (link.auth !== "none") {
    directives.push(`authentication ${link.auth === "simple" ? "simple" : "cryptographic"};`);
  }
  if (options.password) {
    let password = `password ${birdString(options.password)}`;
    const passwordOptions = options.passwordOptions ?? {};
    const passwordEntries: string[] = [];
    if (passwordOptions.id != null) passwordEntries.push(`id ${passwordOptions.id};`);
    for (const [key, directive] of [["generateFrom", "generate from"], ["generateTo", "generate to"], ["acceptFrom", "accept from"], ["acceptTo", "accept to"], ["from", "from"], ["to", "to"]] as const) {
      if (passwordOptions[key]) passwordEntries.push(`${directive} ${birdString(String(passwordOptions[key]))};`);
    }
    if (passwordOptions.algorithm) passwordEntries.push(`algorithm ${passwordOptions.algorithm.replace("-", " ")};`);
    password += passwordEntries.length ? ` { ${passwordEntries.join(" ")} }` : "";
    directives.push(`${password};`);
  }
  const neighbors = options.neighbors?.filter((item) => item.address).map((item) => `${item.address}${item.eligible ? " eligible" : ""};`) ?? [];
  if (neighbors.length) directives.push(`neighbors { ${neighbors.join(" ")} };`);
  return `    interface "${link.localInterface || "<未选择>"}" { ${directives.join(" ")} }; # ${peerName}`;
}
const configPreview = computed(() =>
  enabledVersions.value
    .map((ospfVersion) => {
      const importPolicy = policyText(
        ospfImportPolicies.value[ospfVersion],
        "import",
        null,
      );
      const exportPolicy = policyText(
        ospfExportPolicies.value[ospfVersion],
        "export",
        ospfExportDefineIds.value[ospfVersion],
        redistributeStatic.value,
      );
      const nodeLinks = selectedNodeLinks.value;
      const areas = new Map<string, string[]>();
      for (const link of nodeLinks) {
        const interfaceName =
          link.from === selectedNodeId.value
            ? link.localInterface
            : link.remoteInterface;
        const peerId = link.from === selectedNodeId.value ? link.to : link.from;
        const peerName =
          nodes.value.find((node) => node.id === peerId)?.name ?? peerId;
        const clause = interfacePreviewClause({ ...link, localInterface: interfaceName }, peerName);
        areas.set(link.area, [...(areas.get(link.area) ?? []), clause]);
      }
      const areaConfig = [...areas.entries()]
        .map(
          ([area, clauses]) => `  area ${area} {\n${clauses.join("\n")}\n  };`,
        )
        .join("\n");
      const channel = ospfVersion === "ospfv2" ? "ipv4" : "ipv6";
      const p = protocolOptions.value;
      const advanced = [
        p.rfc1583compat ? "  rfc1583compat yes;" : "",
        ospfVersion === "ospfv3" && p.rfc5838 === false ? "  rfc5838 no;" : "",
        p.instanceId != null ? `  instance id ${p.instanceId};` : "",
        p.stubRouter ? "  stub router yes;" : "",
        p.tick != null ? `  tick ${p.tick};` : "",
        p.ecmp != null ? `  ecmp ${p.ecmp ? "yes" : "no"}${p.ecmpLimit != null ? ` limit ${p.ecmpLimit}` : ""};` : "",
        p.mergeExternal ? "  merge external yes;" : "",
        p.gracefulRestartMode && p.gracefulRestartMode !== "aware" ? `  graceful restart ${p.gracefulRestartMode};` : "",
        p.gracefulRestartTime != null ? `  graceful restart time ${p.gracefulRestartTime};` : "",
      ].filter(Boolean).join("\n");
      return `protocol ospf ${ospfVersion === "ospfv2" ? "v2 birdbox_ospf_v2" : "v3 birdbox_ospf_v3"} {\n  router id ${routerId.value || "<自动>"};\n${advanced ? `${advanced}\n` : ""}  ${channel} {\n    ${importPolicy};\n    ${exportPolicy};\n  };\n${areaConfig}\n${gracefulRestart.value ? "  graceful restart on;\n" : ""}}`;
    })
    .join("\n\n"),
);

function selectNode(node: OspfNode): void {
  if (node.id === selectedNodeId.value) {
    if (nodeConfigs.value[node.id]) loadNodeConfig(node.id);
    return;
  }
  saveSelectedNodeConfig();
  selectedNodeId.value = node.id;
  routerId.value = node.routerId;
  loadNodeConfig(node.id);
}
function linkPosition(id: string): { x: number; y: number } {
  return nodePosition.value[id] ?? { x: 0, y: 0 };
}

function clampTopologyScale(value: number): number {
  return Math.max(0.6, Math.min(1.8, Number(value.toFixed(2))));
}
function zoomTopology(delta: number): void {
  topologyScale.value = clampTopologyScale(topologyScale.value + delta);
}
function resetTopologyZoom(): void {
  topologyScale.value = 1;
  centerTopologyView(nodePosition.value);
}
function handleTopologyWheel(event: WheelEvent): void {
  zoomTopology(event.deltaY < 0 ? 0.1 : -0.1);
}
function centerTopologyView(positions: Record<string, OspfNodePosition>): void {
  const points = Object.values(positions);
  if (!points.length) return;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  topologyPan.value = {
    x: TOPOLOGY_WIDTH / 2 - (minX + maxX) / 2,
    y: TOPOLOGY_HEIGHT / 2 - (minY + maxY) / 2,
  };
}
function startTopologyPan(event: PointerEvent): void {
  if (event.button !== 0 || dragging.value) return;
  const target = event.target as HTMLElement;
  if (target.closest("button, input, select, .ospf-link-hit, .ospf-link-label")) return;
  const canvas = topologyCanvas.value;
  if (!canvas) return;
  topologyPanDragging.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
}
function moveTopologyPan(event: PointerEvent): void {
  const panDragging = topologyPanDragging.value;
  if (!panDragging || panDragging.pointerId !== event.pointerId) return;
  topologyPan.value = {
    x: topologyPan.value.x + event.clientX - panDragging.x,
    y: topologyPan.value.y + event.clientY - panDragging.y,
  };
  panDragging.x = event.clientX;
  panDragging.y = event.clientY;
}
function stopTopologyPan(event?: PointerEvent): void {
  const panDragging = topologyPanDragging.value;
  if (!panDragging || (event && event.pointerId !== panDragging.pointerId)) return;
  const canvas = topologyCanvas.value;
  if (canvas?.hasPointerCapture(panDragging.pointerId)) canvas.releasePointerCapture(panDragging.pointerId);
  topologyPanDragging.value = null;
}
function topologyCanvasPoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const canvas = topologyCanvas.value;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scale = topologyScale.value;
  return {
    x: ((clientX - rect.left - rect.width / 2 - topologyPan.value.x) / scale) + TOPOLOGY_WIDTH / 2,
    y: ((clientY - rect.top - rect.height / 2 - topologyPan.value.y) / scale) + TOPOLOGY_HEIGHT / 2,
  };
}
function selectLink(link: OspfLink): void {
  if (!link.options) link.options = { type: "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [] };
  else if (!link.options.type) link.options.type = "ptp";
  selectedLinkId.value = link.id;
}
const linkDraftLocalOptions = computed(() =>
  interfacesForNode(linkDraftFrom.value),
);
const linkDraftRemoteOptions = computed(() =>
  interfacesForNode(linkDraftTo.value),
);
function resetLinkDraft(): void {
  linkDraftError.value = "";
  linkDraftLocalInterface.value = "";
  linkDraftRemoteInterface.value = "";
}
function openAddLink(): void {
  const first = nodes.value[0]?.id ?? "";
  const second = nodes.value.find((node) => node.id !== first)?.id ?? first;
  if (!nodes.value.some((node) => node.id === linkDraftFrom.value)) linkDraftFrom.value = first;
  if (!nodes.value.some((node) => node.id === linkDraftTo.value) || linkDraftTo.value === linkDraftFrom.value) linkDraftTo.value = second;
  showAddLink.value = true;
  resetLinkDraft();
}
function closeAddLink(): void {
  showAddLink.value = false;
  linkDraftError.value = "";
}
function addLink(): void {
  const from = linkDraftFrom.value;
  const to = linkDraftTo.value;
  const localInterface = linkDraftLocalInterface.value;
  const remoteInterface = linkDraftRemoteInterface.value;
  if (from === to) {
    linkDraftError.value = "本端和对端必须是不同节点";
    return;
  }
  if (!localInterface || !remoteInterface) {
    linkDraftError.value = "请选择两端接口";
    return;
  }
  const sharedInterface = links.value.some(
    (link) =>
      (link.from === from && link.localInterface === localInterface) ||
      (link.to === from && link.remoteInterface === localInterface) ||
      (link.from === to && link.localInterface === remoteInterface) ||
      (link.to === to && link.remoteInterface === remoteInterface),
  );
  const siblings = links.value.filter(
    (link) => nodePairKey(link.from, link.to) === nodePairKey(from, to),
  );
  const inheritedCost = siblings[0]?.cost ?? 10;
  const id = `ospf_link_${Date.now()}_${links.value.length + 1}`;
  links.value.push({
    id,
    from,
    to,
    area: linkDraftArea.value.trim() || "0.0.0.0",
    localInterface,
    remoteInterface,
    cost: inheritedCost,
    hello: 10,
    dead: 40,
    mode: "active",
    auth: "none",
    options: { type: sharedInterface ? "nbma" : "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [], passwordOptions: {} },
  });
  if (sharedInterface) {
    for (const existing of links.value) {
      if (
        (existing.from === from && existing.localInterface === localInterface) ||
        (existing.to === from && existing.remoteInterface === localInterface) ||
        (existing.from === to && existing.localInterface === remoteInterface) ||
        (existing.to === to && existing.remoteInterface === remoteInterface)
      ) existing.options = { ...(existing.options ?? {}), type: "nbma" };
    }
  }
  selectedLinkId.value = id;
  closeAddLink();
}
function startNodeDrag(event: PointerEvent, node: OspfNode): void {
  const target = event.currentTarget as HTMLElement;
  event.preventDefault();
  const pointAtPointer = topologyCanvasPoint(event.clientX, event.clientY);
  if (!pointAtPointer) return;
  const point = linkPosition(node.id);
  dragging.value = {
    id: node.id,
    dx: pointAtPointer.x - point.x,
    dy: pointAtPointer.y - point.y,
    moved: false,
    pointerId: event.pointerId,
    target,
  };
  target.setPointerCapture(event.pointerId);
}
function dragNode(event: PointerEvent): void {
  if (!dragging.value) return;
  const point = topologyCanvasPoint(event.clientX, event.clientY);
  if (!point) return;
  const currentDragging = dragging.value;
  if (!currentDragging) return;
  const nextX = point.x - currentDragging.dx;
  const nextY = point.y - currentDragging.dy;
  if (Math.abs(nextX - linkPosition(currentDragging.id).x) > 1 || Math.abs(nextY - linkPosition(currentDragging.id).y) > 1) {
    currentDragging.moved = true;
  }
  const x = Math.max(
    70,
    Math.min(
      TOPOLOGY_WIDTH - 70,
      nextX,
    ),
  );
  const y = Math.max(
    45,
    Math.min(
      TOPOLOGY_HEIGHT - 45,
      nextY,
    ),
  );
  nodePosition.value = { ...nodePosition.value, [currentDragging.id]: { x, y } };
}
function handleNodeClick(node: OspfNode): void {
  if (suppressNodeClickId.value === node.id) {
    suppressNodeClickId.value = null;
    return;
  }
  selectNode(node);
}
function stopNodeDrag(event?: PointerEvent): void {
  const dragged = dragging.value;
  if (dragged && event && event.pointerId !== dragged.pointerId) return;
  dragging.value = null;
  if (!dragged) return;
  if (dragged.target.hasPointerCapture(dragged.pointerId)) {
    dragged.target.releasePointerCapture(dragged.pointerId);
  }
  if (event?.type !== "pointercancel") {
    suppressNodeClickId.value = dragged.id;
    if (suppressNodeClickTimer !== null) window.clearTimeout(suppressNodeClickTimer);
    suppressNodeClickTimer = window.setTimeout(() => {
      suppressNodeClickId.value = null;
      suppressNodeClickTimer = null;
    }, 200);
    if (!dragged.moved) {
      const node = nodes.value.find((item) => item.id === dragged.id);
      if (node) selectNode(node);
    }
  }
  if (dragged.moved && ospfDomainId.value) {
    layoutSaveQueue = layoutSaveQueue.then(() => saveLayout());
  }
}
async function saveLayout(): Promise<void> {
  if (!ospfDomainId.value) return;
  layoutSaving.value = true;
  layoutSaveError.value = "";
  try {
    const domainNodeIds = new Set(Object.keys(nodeConfigs.value));
    // The domain API rejects coordinates for nodes outside its nodeConfigs.
    // Skip a transient save while the domain is still being hydrated instead
    // of replacing a valid layout with an empty object.
    if (!domainNodeIds.size) return;
    const layout = Object.fromEntries(
      Object.entries(nodePosition.value)
        .filter(([id]) => domainNodeIds.has(id))
        .map(([id, position]) => [
          id,
          {
            x: position.x,
            y: position.y,
            ...(position.locked === undefined ? {} : { locked: position.locked }),
          },
        ]),
    );
    await api(`/api/ospf/${encodeURIComponent(ospfDomainId.value)}/layout`, {
      method: "PATCH",
      // Layout persistence is a lightweight UI-state write. Do not open the
      // global mutation modal or alter page focus while the user is dragging.
      mutationWait: false,
      body: JSON.stringify({ layout }),
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    layoutSaveError.value = error instanceof Error ? error.message : "布局保存失败";
  } finally {
    layoutSaving.value = false;
  }
}
onMounted(() => {
  window.addEventListener("pointermove", dragNode);
  window.addEventListener("pointerup", stopNodeDrag);
  window.addEventListener("pointercancel", stopNodeDrag);
});
async function loadNodeInterfaces(): Promise<void> {
  const currentNodes = dashboard.value?.inventory.nodes ?? [];
  const entries = await Promise.all(
    currentNodes.map(async (node) => {
      try {
        const response = await api<{ interfaces: string[] }>(
          `/api/nodes/${encodeURIComponent(node.id)}/interfaces`,
        );
        return [node.id, response.interfaces] as const;
      } catch {
        return [node.id, []] as const;
      }
    }),
  );
  interfaceOptionsByNode.value = Object.fromEntries(entries);
}
async function refreshOspfRuntime(): Promise<void> {
  if (!ospfDomainId.value) {
    runtimeByNode.value = {};
    return;
  }
  try {
    const response = await api<{ nodes: OspfRuntimeNode[] }>(
      `/api/ospf/${encodeURIComponent(ospfDomainId.value)}/runtime`,
    );
    runtimeByNode.value = Object.fromEntries(
      response.nodes.map((item) => [
        item.nodeId,
        {
          v2: item.runtime.v2.state ?? "未配置",
          v3: item.runtime.v3.state ?? "未配置",
          neighbors: Math.max(
            item.runtime.v2.neighbors,
            item.runtime.v3.neighbors,
          ),
          routes: (item.runtime.v2.routes ?? 0) + (item.runtime.v3.routes ?? 0),
          neighborDetails: item.runtime.neighbors ?? [],
          routeDetails: item.runtime.routes ?? [],
          routesTruncated: item.runtime.routesTruncated === true,
        },
      ]),
    );
  } catch {
    runtimeByNode.value = {};
  }
}
async function loadOspfDomains(): Promise<void> {
  try {
    const response = await api<{
      domains: Array<{
        id: string;
        nodeConfigs: OspfNodeConfig[];
        links: OspfLink[];
        layout: Record<string, { x: number; y: number }>;
      }>;
    }>("/api/ospf");
    const domain = response.domains[0];
    if (!domain) {
      await loadNodeInterfaces();
      return;
    }
    ospfDomainId.value = domain.id;
    links.value = domain.links.map(
      (link) =>
        ({
          ...link,
          from:
            (link as unknown as { from?: string }).from ??
            (link as unknown as { fromNodeId: string }).fromNodeId,
          to:
            (link as unknown as { to?: string }).to ??
            (link as unknown as { toNodeId: string }).toNodeId,
          mode: (link as unknown as { passive?: boolean }).passive
            ? "passive"
            : "active",
          auth: (() => {
            const value = (link as unknown as { authentication?: string }).authentication;
            return value === "simple" || value === "md5" || value === "ipsec" ? value : "none";
          })(),
        }) as OspfLink,
    );
    nodeConfigs.value = Object.fromEntries(
      domain.nodeConfigs.map((config) => [config.nodeId, config]),
    );
    nodePosition.value = domain.layout;
    ensureNodePositions();
    // Dashboard data and the domain request resolve independently. Select a
    // valid node before loading its saved config, otherwise the editor falls
    // back to the disabled defaults and policy controls remain locked.
    if (!selectedNodeId.value || !nodes.value.some((node) => node.id === selectedNodeId.value)) {
      selectedNodeId.value = nodes.value[0]?.id ?? "";
    }
    if (selectedNodeId.value) loadNodeConfig(selectedNodeId.value);
    await Promise.all([loadNodeInterfaces(), refreshOspfRuntime()]);
  } catch {
    // Keep the prototype defaults when the API is unavailable during bootstrap.
  }
}
function handleAuthenticated(): void {
  void loadOspfDomains();
}
watch(
  () => dashboard.value?.inventory.nodes.map((node) => node.id).join(",") ?? "",
  () => {
    if (!dashboard.value?.inventory.nodes.length) return;
    if (ospfDomainId.value) {
      if (!selectedNodeId.value || !nodes.value.some((node) => node.id === selectedNodeId.value)) {
        selectedNodeId.value = nodes.value[0]?.id ?? "";
      }
      if (selectedNodeId.value && nodeConfigs.value[selectedNodeId.value]) loadNodeConfig(selectedNodeId.value);
      return;
    }
    void loadOspfDomains();
  },
  { immediate: true },
);
onMounted(() => {
  window.addEventListener("birdbox:authenticated", handleAuthenticated);
  if (dashboard.value) void loadOspfDomains();
});
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:authenticated", handleAuthenticated);
});
onMounted(() => {
  runtimeTimer = window.setInterval(() => void refreshOspfRuntime(), 15_000);
});
onBeforeUnmount(() => {
  saveSelectedNodeConfig();
  if (runtimeTimer !== null) window.clearInterval(runtimeTimer);
  window.removeEventListener("pointermove", dragNode);
  window.removeEventListener("pointerup", stopNodeDrag);
  window.removeEventListener("pointercancel", stopNodeDrag);
  if (suppressNodeClickTimer !== null) window.clearTimeout(suppressNodeClickTimer);
});
</script>

<template>
  <section class="ospf-workspace" aria-labelledby="ospfTitle">
    <div class="section-heading">
      <div>
        <p class="eyebrow">INTERIOR GATEWAY PROTOCOL</p>
        <h2 id="ospfTitle">OSPF 管理</h2>
        <p class="section-note">
          在拓扑中建立链路并配置双方接口，拖动节点布局，拖动空白区域平移画布；按节点管理 OSPFv2/OSPFv3 实例。
        </p>
      </div>
      <div class="ospf-actions">
        <button class="secondary-button" type="button" @click="previewOspf">
          预检配置</button
        ><button class="primary-button" type="button" @click="saveOspf">
          保存并应用
        </button>
      </div>
    </div>
    <section class="ospf-topology-panel">
      <div class="panel-head">
        <div>
          <h3>OSPF 拓扑</h3>
          <small
            >拖动节点调整位置，拖动空白区域平移大型画布，点击线路编辑两端接口和链路参数；同一对节点的 Cost
            保持一致</small
          >
        </div>
        <div class="ospf-topology-actions">
          <span class="status-dot-label"
            ><i />{{ topologyLinks.length }} 条链路</span
          ><span v-if="layoutSaving" class="ospf-layout-status">位置保存中…</span
          ><span v-else-if="layoutSaveError" class="ospf-layout-status error" role="status" :title="layoutSaveError">布局保存失败</span
          ><span v-else-if="ospfDomainId" class="ospf-layout-status">位置已保存</span
          ><button
            class="secondary-button compact-button"
            type="button"
            @click="resetTopologyLayout"
            :disabled="!nodes.length"
          >
            重置拓扑
          </button
          ><button
            class="secondary-button compact-button"
            type="button"
            @click="openRoutePath"
            :disabled="!selectedNodeId"
          >
            查询路径
          </button
          ><button
            class="secondary-button compact-button"
            type="button"
            @click="openAddLink"
            :disabled="nodes.length < 2"
          >
            ＋ 添加链路
          </button>
        </div>
      </div>
      <div
        ref="topologyCanvas"
        class="ospf-topology-canvas"
        @wheel.prevent="handleTopologyWheel"
        @pointerdown="startTopologyPan"
        @pointermove="moveTopologyPan"
        @pointerup="stopTopologyPan"
        @pointercancel="stopTopologyPan"
      >
        <div
          class="ospf-topology-world"
          :style="{ transform: `translate(${topologyPan.x}px, ${topologyPan.y}px) scale(${topologyScale})` }"
        >
          <svg :viewBox="`0 0 ${TOPOLOGY_WIDTH} ${TOPOLOGY_HEIGHT}`" role="img" aria-label="OSPF 节点拓扑">
          <g v-for="link in topologyLinks" :key="link.id">
            <line
              v-bind="{
                x1: linkGeometry(link).x1,
                y1: linkGeometry(link).y1,
                x2: linkGeometry(link).x2,
                y2: linkGeometry(link).y2,
              }"
              :class="['ospf-link', { selected: selectedLinkId === link.id }]"
            />
            <line
              v-bind="{
                x1: linkGeometry(link).x1,
                y1: linkGeometry(link).y1,
                x2: linkGeometry(link).x2,
                y2: linkGeometry(link).y2,
              }"
              class="ospf-link-hit"
              @click.stop="selectLink(link)"
            />
          </g>
          <g
            v-for="link in topologyLinks"
            :key="`${link.id}-label`"
            class="ospf-link-label"
            :transform="`translate(${(linkGeometry(link).x1 + linkGeometry(link).x2) / 2},${(linkGeometry(link).y1 + linkGeometry(link).y2) / 2})`"
          >
            <rect
              x="-24"
              y="-8"
              width="48"
              height="16"
              rx="3"
              @click.stop="selectLink(link)"
            />
            <text text-anchor="middle" y="3" @click.stop="selectLink(link)">
              Cost {{ linkCostInput(link) }}
            </text>
          </g></svg
          ><button
          v-for="link in topologyLinks"
          :key="`${link.id}-hit-button`"
          type="button"
          class="ospf-link-hit-button"
          :aria-label="`编辑 ${link.from} 到 ${link.to} 的 OSPF 链路`"
          :style="{
            left: `${((linkGeometry(link).x1 + linkGeometry(link).x2) / 2 / TOPOLOGY_WIDTH) * 100}%`,
            top: `${((linkGeometry(link).y1 + linkGeometry(link).y2) / 2 / TOPOLOGY_HEIGHT) * 100}%`,
          }"
          @click="selectLink(link)"
        />
        <button
          v-for="node in nodes"
          :key="node.id"
          type="button"
          class="ospf-topology-node"
          :draggable="false"
          :class="{ selected: selectedNodeId === node.id, dragging: dragging?.id === node.id }"
          :style="{
            left: `${(linkPosition(node.id).x / TOPOLOGY_WIDTH) * 100}%`,
            top: `${(linkPosition(node.id).y / TOPOLOGY_HEIGHT) * 100}%`,
          }"
          @pointerdown.stop="startNodeDrag($event, node)"
          @pointerup.stop.prevent="stopNodeDrag"
          @pointercancel.stop.prevent="stopNodeDrag"
          @dragstart.prevent
          @click.stop.prevent="handleNodeClick(node)"
        >
          <span class="ospf-node-status" /><strong>{{ node.name }}</strong
          ><small>{{ node.routerId }}</small
          ><em>{{ node.neighbors }} 邻居 · {{ node.routes }} 路由</em>
        </button>
      </div>
        <div class="ospf-topology-zoom" role="group" aria-label="拓扑缩放">
          <button type="button" class="icon-button" aria-label="放大拓扑" @click="zoomTopology(0.1)">＋</button>
          <span>{{ Math.round(topologyScale * 100) }}%</span>
          <button type="button" class="icon-button" aria-label="缩小拓扑" @click="zoomTopology(-0.1)">−</button>
          <button type="button" class="secondary-button compact-button" @click="resetTopologyZoom">重置</button>
        </div>
      </div>
      <div v-if="showAddLink" class="ospf-add-link">
        <div class="ospf-add-link-head">
          <strong>添加 OSPF 链路</strong
          ><button
            class="icon-button"
            type="button"
            title="关闭"
            @click="closeAddLink"
          >
            ×
          </button>
        </div>
        <div class="ospf-add-link-grid">
          <div class="field">
            <label>本端节点</label
            ><select v-model="linkDraftFrom" @change="resetLinkDraft">
              <option v-for="node in nodes" :key="node.id" :value="node.id">
                {{ node.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <label>本端接口</label
            ><input
              v-model.trim="linkDraftLocalInterface"
              list="ospf-interface-names"
              placeholder="例如 bb02-03"
            />
          </div>
          <div class="field">
            <label>对端节点</label
            ><select v-model="linkDraftTo" @change="resetLinkDraft">
              <option v-for="node in nodes" :key="node.id" :value="node.id">
                {{ node.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <label>对端接口</label
            ><input
              v-model.trim="linkDraftRemoteInterface"
              list="ospf-interface-names"
              placeholder="例如 bb02-03"
            />
          </div>
          <div class="field">
            <label>Area</label
            ><input v-model="linkDraftArea" placeholder="0.0.0.0" />
          </div>
        </div>
        <datalist id="ospf-interface-names">
          <option v-for="item in allInterfaces" :key="item" :value="item" />
        </datalist>
        <p v-if="linkDraftError" class="ospf-form-error" role="alert">
          {{ linkDraftError }}
        </p>
        <div class="ospf-add-link-actions">
          <button class="secondary-button" type="button" @click="closeAddLink">
            取消</button
          ><button class="primary-button" type="button" @click="addLink">
            创建链路
          </button>
        </div>
      </div>
      <div v-if="selectedLink" class="ospf-link-editor">
        <div class="ospf-link-endpoints">
          <div>
            <small
              >{{
                nodes.find((node) => node.id === selectedLink?.from)?.name
              }}
              · 接口</small
            ><select v-model="selectedLink.localInterface">
              <option value="">请选择接口</option>
              <option
                v-for="item in interfacesForNode(
                  selectedLink.from,
                  selectedLink.localInterface,
                )"
                :key="item"
                :value="item"
                :disabled="
                  interfaceInUse(selectedLink.from, item, selectedLink.id)
                "
              >
                {{ item
                }}{{
                  interfaceInUse(selectedLink.from, item, selectedLink.id)
                    ? "（已占用）"
                    : ""
                }}
              </option>
            </select>
          </div>
          <span>↔</span>
          <div>
            <small
              >{{ nodes.find((node) => node.id === selectedLink?.to)?.name }} ·
              接口</small
            ><select v-model="selectedLink.remoteInterface">
              <option value="">请选择接口</option>
              <option
                v-for="item in interfacesForNode(
                  selectedLink.to,
                  selectedLink.remoteInterface,
                )"
                :key="item"
                :value="item"
                :disabled="
                  interfaceInUse(selectedLink.to, item, selectedLink.id)
                "
              >
                {{ item
                }}{{
                  interfaceInUse(selectedLink.to, item, selectedLink.id)
                    ? "（已占用）"
                    : ""
                }}
              </option>
            </select>
          </div>
        </div>
        <span class="field"
          ><label>Area</label
          ><input
            v-model="selectedLink.area"
            placeholder="0.0.0.0"
            pattern="(?:0|[1-9][0-9]{0,2})\\.(?:0|[1-9][0-9]{0,2})\\.(?:0|[1-9][0-9]{0,2})\\.(?:0|[1-9][0-9]{0,2})" /></span
        ><span class="field"
          ><label>节点对 Cost</label
          ><input
            :value="linkCostInput(selectedLink)"
            @input="
              setLinkCost(
                selectedLink,
                Number(($event.currentTarget as HTMLInputElement).value),
              )
            "
            type="number"
            min="1"
            max="65535" /></span
        ><span class="field"
          ><label>Hello</label
          ><input
            v-model.number="selectedLink.hello"
            type="number"
            min="1"
            max="65535" /></span
        ><span class="field"
          ><label>Dead</label
          ><input
            v-model.number="selectedLink.dead"
            type="number"
            min="1"
            max="65535" /></span
        ><span class="field"
          ><label>认证</label
          ><select v-model="selectedLink.auth">
            <option value="none">无</option>
            <option value="simple">简单密码</option>
            <option value="md5">MD5</option>
            <option value="ipsec">IPsec</option>
          </select></span
        ><label class="checkbox-inline ospf-checkbox"
          ><input
            v-model="selectedLink.mode"
            type="checkbox"
            true-value="passive"
            false-value="active"
          /><span>Passive</span></label
        ><details class="ospf-link-advanced">
          <summary>接口高级选项</summary>
          <div class="ospf-advanced-grid">
            <label class="field">网络类型<select v-model="selectedLink.options!.type"><option :value="undefined">自动</option><option value="broadcast">Broadcast</option><option value="ptp">Point-to-point</option><option value="nbma">NBMA</option><option value="ptmp">Point-to-multipoint</option></select></label>
            <label class="field">Instance ID<input v-model.number="selectedLink.options!.instanceId" type="number" min="0" max="255" /></label>
            <label class="field">Poll（秒）<input v-model.number="selectedLink.options!.poll" type="number" min="1" /></label>
            <label class="field">Retransmit（秒）<input v-model.number="selectedLink.options!.retransmit" type="number" min="1" /></label>
            <label class="field">Transmit Delay（秒）<input v-model.number="selectedLink.options!.transmitDelay" type="number" min="1" /></label>
            <label class="field">Priority<input v-model.number="selectedLink.options!.priority" type="number" min="0" max="255" /></label>
            <label class="field">Wait（秒）<input v-model.number="selectedLink.options!.wait" type="number" min="1" /></label>
            <label class="field">Dead 计时方式<select v-model="selectedLink.options!.deadMode"><option value="count">倍数（默认）</option><option value="seconds">固定秒数</option></select></label>
            <label class="field">接收缓冲<select v-model="selectedLink.options!.rxBuffer"><option :value="null">动态</option><option value="normal">Normal</option><option value="large">Large</option></select></label>
            <label class="field">发送包长度<input v-model.number="selectedLink.options!.txLength" type="number" min="256" /></label>
            <label class="field">ECMP 权重<input v-model.number="selectedLink.options!.ecmpWeight" type="number" min="1" max="256" /></label>
            <label class="field">TTL 安全<select v-model="selectedLink.options!.ttlSecurity"><option value="off">关闭</option><option value="on">收发启用</option><option value="tx-only">仅发送</option></select></label>
            <label class="field">TX DSCP/Class<input v-model.number="selectedLink.options!.txClass" type="number" min="0" max="255" /></label>
            <label class="field">TX DSCP<input v-model.number="selectedLink.options!.txDscp" type="number" min="0" max="255" /></label>
            <label class="field">TX Priority<input v-model.number="selectedLink.options!.txPriority" type="number" min="0" max="255" /></label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.linkLsaSuppression" type="checkbox" /> 抑制 Link-LSA（OSPFv3）</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.strictNonbroadcast" type="checkbox" /> Strict Nonbroadcast</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.realBroadcast" type="checkbox" /> 使用真实广播</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.ptpNetmask" type="checkbox" /> PTP Netmask</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.ptpAddress" type="checkbox" /> PTP Address</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.secondary" type="checkbox" /> Secondary 地址</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.checkLink" type="checkbox" /> 检查物理链路</label>
            <label class="checkbox-inline"><input v-model="selectedLink.options!.bfd" type="checkbox" /> 接口 BFD（覆盖节点设置）</label>
            <label class="field">认证密码<input v-model="selectedLink.options!.password" type="password" autocomplete="new-password" /></label>
            <label class="field">认证 Key ID<input v-model.number="ensurePasswordOptions(selectedLink.options!).id" type="number" min="0" /></label>
            <label class="field">认证算法<select v-model="ensurePasswordOptions(selectedLink.options!).algorithm"><option :value="undefined">默认</option><option value="keyed-md5">Keyed MD5</option><option value="keyed-sha1">Keyed SHA1</option><option value="hmac-sha1">HMAC SHA1</option><option value="hmac-sha256">HMAC SHA256</option><option value="hmac-sha384">HMAC SHA384</option><option value="hmac-sha512">HMAC SHA512</option></select></label>
            <details class="ospf-password-timing area-wide"><summary>认证密钥生效时间</summary><div class="ospf-advanced-grid"><label class="field">Generate From<input v-model="ensurePasswordOptions(selectedLink.options!).generateFrom" placeholder="YYYY-MM-DD HH:mm:ss" /></label><label class="field">Generate To<input v-model="ensurePasswordOptions(selectedLink.options!).generateTo" placeholder="YYYY-MM-DD HH:mm:ss" /></label><label class="field">Accept From<input v-model="ensurePasswordOptions(selectedLink.options!).acceptFrom" placeholder="YYYY-MM-DD HH:mm:ss" /></label><label class="field">Accept To<input v-model="ensurePasswordOptions(selectedLink.options!).acceptTo" placeholder="YYYY-MM-DD HH:mm:ss" /></label><label class="field">有效 From<input v-model="ensurePasswordOptions(selectedLink.options!).from" placeholder="YYYY-MM-DD HH:mm:ss" /></label><label class="field">有效 To<input v-model="ensurePasswordOptions(selectedLink.options!).to" placeholder="YYYY-MM-DD HH:mm:ss" /></label></div></details>
            <label class="field area-wide">NBMA/PtMP 邻居（逗号分隔，可加 eligible）<input :value="neighborText(selectedLink)" @input="setNeighborText(selectedLink, ($event.currentTarget as HTMLInputElement).value)" placeholder="192.0.2.2 eligible, 192.0.2.3" /></label>
          </div>
          <p class="field-hint">未填写的项目使用 BIRD 默认值。NBMA/PtMP 邻居地址可在高级配置数据中配置。</p>
        </details>
          ><button
          class="icon-button"
          type="button"
          title="关闭编辑"
          @click="selectedLinkId = null"
        >
          ×
          </button>
        </div>
    </section>
    <div class="ospf-layout">
      <aside class="ospf-node-panel">
        <div class="panel-head">
          <div>
            <h3>受管节点</h3>
            <small>{{ nodes.length }} 个节点</small>
          </div>
          <span class="status-dot-label"><i />实时</span>
        </div>
        <input
          v-model="search"
          class="ospf-search"
          type="search"
          placeholder="搜索节点名称或 Router ID"
        />
        <div class="ospf-node-list">
          <button
            v-for="node in filteredNodes"
            :key="node.id"
            type="button"
            class="ospf-node-row"
            :class="{ selected: node.id === selectedNodeId }"
            @click="selectNode(node)"
          >
            <span class="ospf-node-main"
              ><strong>{{ node.name }}</strong
              ><small>{{ node.routerId }}</small></span
            ><span class="ospf-node-stats"
              ><em
                :class="
                  node.v2 === '已建立' ? 'up' : node.v2 === 'Idle' ? 'warn' : ''
                "
                >v2 {{ node.v2 }}</em
              ><em
                :class="
                  node.v3 === '已建立' ? 'up' : node.v3 === 'Idle' ? 'warn' : ''
                "
                >v3 {{ node.v3 }}</em
              ><small
                >{{ node.neighbors }} 邻居 · {{ node.routes }} 路由</small
              ></span
            >
          </button>
        </div>
      </aside>
      <section class="ospf-editor">
        <div class="ospf-editor-head">
          <div>
            <p class="eyebrow">NODE CONFIGURATION</p>
            <h3>{{ selectedNode?.name }}</h3>
            <span>{{ selectedNode?.routerId }}</span>
          </div>
          <label class="switch-label"
            ><input v-model="enabled" type="checkbox" /><span
              >启用 OSPF</span
            ></label
          >
        </div>
        <div class="ospf-form-grid">
          <div class="field">
            <label>协议版本（可多选）</label>
            <div class="ospf-version-checks">
              <label
                ><input
                  type="checkbox"
                  :checked="enabledVersions.includes('ospfv2')"
                  @change="
                    toggleVersion(
                      'ospfv2',
                      ($event.currentTarget as HTMLInputElement).checked,
                    )
                  "
                /><span>OSPFv2 · IPv4</span></label
              ><label
                ><input
                  type="checkbox"
                  :checked="enabledVersions.includes('ospfv3')"
                  @change="
                    toggleVersion(
                      'ospfv3',
                      ($event.currentTarget as HTMLInputElement).checked,
                    )
                  "
                /><span>OSPFv3 · IPv6</span></label
              >
            </div>
          </div>
          <div class="field">
            <label>Router ID</label
            ><input v-model="routerId" placeholder="留空自动选择" />
          </div>
        </div>
        <p class="ospf-link-config-hint">
          接口、Area、Cost
          和邻接参数统一在线路上配置。点击拓扑中的线路即可编辑双方。
        </p>
        <div
          v-for="ospfVersion in enabledVersions"
          :key="ospfVersion"
          class="ospf-version-policy"
        >
          <div class="ospf-version-heading">
            <strong>{{
              ospfVersion === "ospfv2" ? "OSPFv2 / IPv4" : "OSPFv3 / IPv6"
            }}</strong
            ><small>独立的导入与导出策略</small>
          </div>
          <div class="ospf-policy-grid">
            <PolicyEditor
              :family="ospfVersion === 'ospfv2' ? 'ipv4' : 'ipv6'"
              direction="import"
              :policy="ospfImportPolicies[ospfVersion]"
              :export-define-id="ospfExportDefineIds[ospfVersion]"
              :functions="availableFunctions"
              :filters="availableFilters"
              :defines="availableDefines"
              :disabled="!enabled"
              :show-policy-action="false"
              @update:policy="updateImportPolicy(ospfVersion, $event)"
            /><PolicyEditor
              :family="ospfVersion === 'ospfv2' ? 'ipv4' : 'ipv6'"
              direction="export"
              :policy="ospfExportPolicies[ospfVersion]"
              :export-define-id="ospfExportDefineIds[ospfVersion]"
              :functions="availableFunctions"
              :filters="availableFilters"
              :defines="availableDefines"
              :disabled="!enabled"
              :show-policy-action="false"
              @update:policy="updateExportPolicy(ospfVersion, $event)"
              @update:export-define-id="updateExportDefine(ospfVersion, $event)"
            />
          </div>
        </div>
        <div class="ospf-options">
          <label><input v-model="bfd" type="checkbox" /> BFD 快速检测</label
          ><label><input v-model="gracefulRestart" type="checkbox" /> Graceful Restart</label
          ><label><input v-model="redistributeStatic" type="checkbox" /> 重分发静态路由</label>
        </div>
        <details class="ospf-advanced">
          <summary>高级协议选项</summary>
          <div class="ospf-advanced-grid">
            <label class="checkbox-inline"><input v-model="protocolOptions.rfc1583compat" type="checkbox" /> RFC 1583 兼容</label>
            <label class="checkbox-inline"><input v-model="protocolOptions.rfc5838" type="checkbox" /> RFC 5838 地址族扩展</label>
            <label class="checkbox-inline"><input v-model="protocolOptions.stubRouter" type="checkbox" /> Stub Router</label>
            <label class="checkbox-inline"><input v-model="protocolOptions.mergeExternal" type="checkbox" /> 合并外部路由</label>
            <label class="field">Instance ID<input v-model.number="protocolOptions.instanceId" type="number" min="0" max="255" placeholder="默认" /></label>
            <label class="field">Tick（秒）<input v-model.number="protocolOptions.tick" type="number" min="1" placeholder="1" /></label>
            <label class="field">ECMP<select v-model="protocolOptions.ecmp"><option :value="null">默认</option><option :value="true">启用</option><option :value="false">禁用</option></select></label>
            <label class="field">ECMP 最大下一跳<input v-model.number="protocolOptions.ecmpLimit" type="number" min="1" placeholder="16" /></label>
            <label class="field">Graceful Restart<select v-model="protocolOptions.gracefulRestartMode"><option value="aware">仅辅助（默认）</option><option value="on">启用</option><option value="off">禁用</option></select></label>
            <label class="field">重启等待（秒）<input v-model.number="protocolOptions.gracefulRestartTime" type="number" min="1" placeholder="120" /></label>
          </div>
          <div v-if="configuredAreas.length" class="ospf-area-advanced">
            <h4>Area 高级属性</h4>
            <div v-for="area in configuredAreas" :key="area" class="ospf-area-card">
              <strong>Area {{ area }}</strong>
              <label class="checkbox-inline"><input v-model="ensureAreaOptions(area).stub" type="checkbox" /> Stub</label>
              <label class="checkbox-inline"><input v-model="ensureAreaOptions(area).nssa" type="checkbox" /> NSSA</label>
              <label class="checkbox-inline"><input v-model="ensureAreaOptions(area).translator" type="checkbox" /> Translator</label>
              <label class="checkbox-inline"><input v-model="ensureAreaOptions(area).defaultNssa" type="checkbox" /> Default NSSA</label>
              <label class="field">Summary<select v-model="ensureAreaOptions(area).summary"><option :value="null">默认</option><option :value="true">启用</option><option :value="false">禁用</option></select></label>
              <label class="field">Default Cost<input v-model.number="ensureAreaOptions(area).defaultCost" type="number" min="1" /></label>
              <label class="field">Default Cost2<input v-model.number="ensureAreaOptions(area).defaultCost2" type="number" min="1" /></label>
              <label class="field">Translator Stability<input v-model.number="ensureAreaOptions(area).translatorStability" type="number" min="1" /></label>
              <div class="ospf-area-entry-groups">
                <div class="ospf-area-entry-group"><div class="ospf-subheading"><strong>Networks</strong><button class="secondary-button compact-button" type="button" @click="addAreaEntry(area, 'networks')">＋ 添加</button></div><div v-for="(item, index) in ensureAreaOptions(area).networks ?? []" :key="`network-${index}`" class="ospf-area-entry-row"><input v-model="item.prefix" placeholder="192.0.2.0/24" /><label class="checkbox-inline"><input v-model="item.hidden" type="checkbox" /> Hidden</label><button class="icon-button" type="button" title="删除" @click="removeAreaEntry(area, 'networks', index)">×</button></div></div>
                <div class="ospf-area-entry-group"><div class="ospf-subheading"><strong>External</strong><button class="secondary-button compact-button" type="button" @click="addAreaEntry(area, 'external')">＋ 添加</button></div><div v-for="(item, index) in ensureAreaOptions(area).external ?? []" :key="`external-${index}`" class="ospf-area-entry-row"><input v-model="item.prefix" placeholder="198.51.100.0/24" /><label class="checkbox-inline"><input v-model="item.hidden" type="checkbox" /> Hidden</label><input v-model.number="item.tag" type="number" min="0" max="4294967295" placeholder="Tag" /><button class="icon-button" type="button" title="删除" @click="removeAreaEntry(area, 'external', index)">×</button></div></div>
                <div class="ospf-area-entry-group"><div class="ospf-subheading"><strong>Stubnet</strong><button class="secondary-button compact-button" type="button" @click="addAreaEntry(area, 'stubnets')">＋ 添加</button></div><div v-for="(item, index) in ensureAreaOptions(area).stubnets ?? []" :key="`stubnet-${index}`" class="ospf-area-entry-row"><input v-model="item.prefix" placeholder="203.0.113.0/24" /><label class="checkbox-inline"><input v-model="item.hidden" type="checkbox" /> Hidden</label><label class="checkbox-inline"><input v-model="item.summary" type="checkbox" /> Summary</label><input v-model.number="item.cost" type="number" min="1" max="16777215" placeholder="Cost" /><button class="icon-button" type="button" title="删除" @click="removeAreaEntry(area, 'stubnets', index)">×</button></div></div>
              </div>
            </div>
          </div>
          <div class="ospf-virtual-links">
            <div class="ospf-subheading"><h4>Virtual Link</h4><button class="secondary-button compact-button" type="button" @click="addVirtualLink">＋ 添加</button></div>
            <div v-for="(item, index) in virtualLinks" :key="index" class="ospf-virtual-link-row">
              <input v-model="item.id" placeholder="对端 Router ID" />
              <input v-model="item.area" placeholder="传输 Area" />
              <input v-model.number="item.hello" type="number" min="1" placeholder="Hello" />
              <input v-model.number="item.retransmit" type="number" min="1" placeholder="Retransmit" />
              <input v-model.number="item.wait" type="number" min="1" placeholder="Wait" />
              <input v-model.number="item.dead" type="number" min="1" placeholder="Dead" />
              <input v-model.number="item.instanceId" type="number" min="0" max="255" placeholder="Instance ID" />
              <select v-model="item.authentication"><option value="none">无认证</option><option value="simple">Simple</option><option value="cryptographic">Cryptographic</option></select>
              <input v-model="item.password" type="password" placeholder="Password" />
              <input v-model.number="ensureVirtualPasswordOptions(item).id" type="number" min="0" placeholder="Key ID" />
              <select v-model="ensureVirtualPasswordOptions(item).algorithm"><option :value="undefined">默认算法</option><option value="keyed-md5">Keyed MD5</option><option value="hmac-sha256">HMAC SHA256</option><option value="hmac-sha512">HMAC SHA512</option></select>
              <input v-model="ensureVirtualPasswordOptions(item).generateFrom" placeholder="Generate From" />
              <input v-model="ensureVirtualPasswordOptions(item).generateTo" placeholder="Generate To" />
              <input v-model="ensureVirtualPasswordOptions(item).acceptFrom" placeholder="Accept From" />
              <input v-model="ensureVirtualPasswordOptions(item).acceptTo" placeholder="Accept To" />
              <button class="icon-button" type="button" title="删除" @click="virtualLinks.splice(index, 1)">×</button>
            </div>
          </div>
          <p class="field-hint">未填写的项目使用 BIRD 默认值。Area 高级属性可通过配置接口扩展。</p>
        </details>
      </section>
      <aside class="ospf-runtime">
        <div class="panel-head">
          <div>
            <p class="eyebrow">RUNTIME</p>
            <h3>运行详情</h3>
          </div>
          <span class="runtime-refresh">刚刚更新</span>
        </div>
        <div class="runtime-summary">
          <button type="button" class="runtime-summary-card" @click="openRuntimeDetails('neighbors')">
            <strong>{{ selectedRuntime.neighbors }}</strong
            ><span>邻居</span>
          </button>
          <button type="button" class="runtime-summary-card" @click="openRuntimeDetails('routes')">
            <strong>{{ selectedRuntime.routes }}</strong
            ><span>OSPF 路由</span>
          </button>
          <button type="button" class="runtime-summary-card" @click="openRuntimeDetails('areas')"><strong>{{ selectedAreaDetails.length }}</strong><span>Area</span></button>
        </div>
        <h4>邻居状态</h4>
        <div class="neighbor-row">
          <span><i :class="selectedRuntime.v2.startsWith('Full') ? 'up-dot' : 'warn-dot'" />OSPFv2</span><em>{{ selectedRuntime.v2 }}</em>
        </div>
        <div class="neighbor-row">
          <span><i :class="selectedRuntime.v3.startsWith('Full') ? 'up-dot' : 'warn-dot'" />OSPFv3</span><em>{{ selectedRuntime.v3 }}</em>
        </div>
        <div class="ospf-preview-heading"><h4>配置预览</h4><button class="secondary-button compact-button" type="button" :disabled="!configPreview" @click="openOspfPreview">全屏查看</button></div>
        <pre class="ospf-preview">{{ configPreview }}</pre>
      </aside>
    </div>
    <dialog ref="runtimeDialog" class="route-dialog ospf-runtime-dialog" aria-labelledby="ospfRuntimeDialogTitle" @cancel.prevent="closeRuntimeDetails">
      <div class="route-dialog-shell">
        <header class="route-dialog-head">
          <div>
            <p class="eyebrow">OSPF RUNTIME</p>
            <h2 id="ospfRuntimeDialogTitle">{{ runtimeDetailTitle }}</h2>
            <span>{{ selectedNode?.name }} · {{ selectedNode?.routerId }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭 OSPF 运行详情" @click="closeRuntimeDetails">×</button>
        </header>
        <div v-if="runtimeDetailKind === 'neighbors'" class="ospf-runtime-detail-body">
          <div v-if="selectedRuntime.neighborDetails.length === 0" class="route-dialog-state">
            {{ neighborDetailsUnavailable ? `运行状态显示 ${selectedRuntime.neighbors} 个邻居，但当前实例未返回明细，请刷新服务后重试` : "当前没有邻居信息" }}
          </div>
          <div v-else class="ospf-runtime-table-wrap">
            <table class="ospf-runtime-table"><thead><tr><th>协议</th><th>Router ID</th><th>状态</th><th>接口</th><th>邻居地址</th><th>Dead</th></tr></thead><tbody><tr v-for="(neighbor, index) in selectedRuntime.neighborDetails" :key="`${neighbor.version}-${neighbor.routerId}-${neighbor.address}-${index}`"><td>{{ neighbor.version === 'ospfv2' ? 'OSPFv2' : 'OSPFv3' }}</td><td>{{ neighbor.routerId }}</td><td><span :class="neighbor.state.toLowerCase().startsWith('full') ? 'runtime-state-up' : 'runtime-state-warn'">{{ neighbor.state }}</span></td><td>{{ neighbor.interface }}</td><td>{{ neighbor.address }}</td><td>{{ neighbor.deadTime ?? '-' }}</td></tr></tbody></table>
          </div>
        </div>
        <div v-else-if="runtimeDetailKind === 'routes'" class="ospf-runtime-detail-body">
          <div v-if="selectedRuntime.routeDetails.length === 0" class="route-dialog-state">
            {{ routeDetailsUnavailable ? `运行状态显示 ${selectedRuntime.routes} 条 OSPF 路由，但当前实例未返回明细，请刷新服务后重试` : "当前没有已导入的 OSPF 路由" }}
          </div>
          <div v-else class="ospf-runtime-route-list"><article v-for="(route, index) in selectedRuntime.routeDetails" :key="`${route.version}-${route.prefix}-${index}`"><header><strong>{{ route.prefix }}</strong><span>{{ route.version === 'ospfv2' ? 'OSPFv2 / IPv4' : 'OSPFv3 / IPv6' }}</span></header><p>{{ route.summary }}</p><pre v-if="route.details">{{ route.details }}</pre></article><p v-if="selectedRuntime.routesTruncated" class="field-hint">路由数量较多，仅显示前 200 条。</p></div>
        </div>
        <div v-else class="ospf-runtime-detail-body">
          <div v-if="selectedAreaDetails.length === 0" class="route-dialog-state">当前节点未配置 Area</div>
          <div v-else class="ospf-area-detail-list"><article v-for="item in selectedAreaDetails" :key="item.area"><header><strong>Area {{ item.area }}</strong><span>{{ item.links.length }} 条链路</span></header><div v-for="link in item.links" :key="link.id" class="ospf-area-detail-link"><span>{{ link.localInterface }} ↔ {{ link.remoteInterface }}</span><span>Cost {{ link.cost }} · Hello {{ link.hello }} · Dead {{ link.dead }}</span><span>类型：{{ link.options?.type ?? 'ptp' }}</span></div><p v-if="item.options.stub || item.options.nssa || item.options.networks?.length || item.options.external?.length || item.options.stubnets?.length" class="field-hint">{{ item.options.stub ? 'Stub ' : '' }}{{ item.options.nssa ? 'NSSA ' : '' }}{{ item.options.networks?.length ? `Networks ${item.options.networks.length} ` : '' }}{{ item.options.external?.length ? `External ${item.options.external.length} ` : '' }}{{ item.options.stubnets?.length ? `Stubnet ${item.options.stubnets.length}` : '' }}</p></article></div>
        </div>
      </div>
    </dialog>
    <dialog ref="previewDialog" class="route-dialog ospf-preview-dialog" aria-labelledby="ospfPreviewDialogTitle" @cancel.prevent="closeOspfPreview">
      <div class="route-dialog-shell">
        <header class="route-dialog-head">
          <div><p class="eyebrow">GENERATED CONFIGURATION</p><h2 id="ospfPreviewDialogTitle">OSPF 配置预览</h2><span>{{ selectedNode?.name ?? "当前节点" }} · 实时生成配置</span></div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭 OSPF 配置预览" @click="closeOspfPreview">×</button>
        </header>
        <pre class="ospf-preview-fullscreen">{{ configPreview }}</pre>
      </div>
    </dialog>
    <dialog ref="routePathDialog" class="route-dialog ospf-path-dialog" aria-labelledby="ospfPathDialogTitle" @cancel.prevent="closeRoutePath">
      <div class="route-dialog-shell">
        <header class="route-dialog-head">
          <div><p class="eyebrow">OSPF PATH</p><h2 id="ospfPathDialogTitle">OSPF 路径查询</h2><span>{{ nodes.find((node) => node.id === routePathStartNodeId)?.name ?? "未选择开始节点" }} · 拓扑位置继承自 OSPF 拓扑</span></div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭 OSPF 路径查询" @click="closeRoutePath">×</button>
        </header>
        <form class="route-path-form" @submit.prevent="queryRoutePath">
          <div class="route-path-fields">
            <label class="field"><span class="field-label">开始节点</span><select v-model="routePathStartNodeId" required><option value="" disabled>请选择节点</option><option v-for="node in nodes" :key="`path-start-${node.id}`" :value="node.id">{{ node.name }} · {{ node.routerId }}</option></select><span class="field-hint">从所选节点的 BIRD 路由表开始递归查询</span></label>
            <label class="field"><span class="field-label">目标 IP</span><input v-model="routePathTarget" type="text" inputmode="url" placeholder="例如 198.18.0.3 或 2001:db8::1" autocomplete="off" required /><span class="field-hint">支持 IPv4 和 IPv6 地址</span></label>
          </div>
          <button class="primary-button" type="submit" :disabled="routePathPending || !routePathTarget.trim()">{{ routePathPending ? "正在查询" : "查询路径" }}</button>
        </form>
        <div v-if="routePathError" class="route-dialog-state error ospf-path-error">{{ routePathError }}</div>
        <div v-else-if="routePathPending" class="route-dialog-state"><div class="route-loading-copy"><i aria-hidden="true"></i><span>正在查询经过的节点</span></div></div>
        <div v-else-if="routePathSteps.length === 0" class="route-dialog-state">输入目标 IP 后查看路径拓扑</div>
        <div v-else class="ospf-path-topology" aria-label="OSPF 路径拓扑">
          <div class="ospf-path-viewport-tools" role="toolbar" aria-label="路径拓扑视口控制"><button class="icon-button" type="button" title="放大" aria-label="放大路径拓扑" @click="zoomRoutePath(.1)">＋</button><button class="icon-button" type="button" title="缩小" aria-label="缩小路径拓扑" @click="zoomRoutePath(-.1)">－</button><button class="icon-button" type="button" title="重置视口" aria-label="重置路径拓扑视口" @click="resetRoutePathViewport">⟳</button><span>{{ Math.round(routePathScale * 100) }}%</span></div>
          <div ref="routePathCanvas" class="ospf-path-viewport" :class="{ dragging: routePathDragging }" @wheel.prevent="handleRoutePathWheel" @pointerdown="startRoutePathPan" @pointermove="moveRoutePathPan" @pointerup="stopRoutePathPan" @pointercancel="stopRoutePathPan">
            <div class="ospf-path-world" :style="{ transform: `translate(${routePathPan.x}px, ${routePathPan.y}px) scale(${routePathScale})` }">
              <svg viewBox="0 0 540 330" role="img" aria-label="OSPF 路径拓扑">
                <line v-for="link in topologyLinks" :key="`path-${link.id}`" v-bind="{ x1: linkGeometry(link).x1, y1: linkGeometry(link).y1, x2: linkGeometry(link).x2, y2: linkGeometry(link).y2 }" :class="['ospf-path-link', { active: routePathLinkDirections.has(link.id), dim: !routePathLinkDirections.has(link.id) }]" />
                <polygon v-for="link in topologyLinks.filter((item) => routePathLinkDirections.has(item.id))" :key="`path-arrow-${link.id}`" :points="pathArrowPoints(link, routePathLinkDirections.get(link.id)!)" class="ospf-path-arrow" />
              </svg>
              <div v-for="node in nodes" :key="`path-node-${node.id}`" class="ospf-path-node" :class="{ active: routePathNodeIds.has(node.id), dim: !routePathNodeIds.has(node.id) }" :style="{ left: `${linkPosition(node.id).x}px`, top: `${linkPosition(node.id).y}px` }" @pointerdown.stop><strong>{{ node.name }}</strong><small>{{ node.routerId }}</small></div>
            </div>
            <div class="ospf-path-legend"><span><i class="active" />经过路径</span><span><i class="dim" />未经过节点/链路</span><span><i class="arrow" />下一跳方向</span></div>
          </div>
        </div>
        <ol v-if="routePathSteps.length" class="ospf-path-step-list"><li v-for="(step, index) in routePathSteps" :key="`${step.nodeId}-${index}`"><strong>{{ index + 1 }}. {{ nodes.find((item) => item.id === step.nodeId)?.name ?? step.nodeId }}</strong><span>{{ step.route.prefix }} · {{ step.route.summary }}</span><span v-if="step.nextNodeId">→ {{ nodes.find((item) => item.id === step.nextNodeId)?.name ?? step.nextNodeId }}</span><span v-else>到达直连接口或未能映射下一跳</span></li></ol>
      </div>
    </dialog>
  </section>
</template>
