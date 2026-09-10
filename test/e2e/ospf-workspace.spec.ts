import { expect, test } from "@playwright/test";

type NodeId = "local" | "edge" | "core" | "backup";

const nodes = [
  { id: "local", kind: "managed-node", name: "E2E Router Alpha", transport: "agent", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "include", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl", routerId: "192.0.2.1", igpAddress: "10.255.23.1", listenPort: 179 },
  { id: "edge", kind: "managed-node", name: "E2E Router Beta", transport: "agent", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "include", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl", routerId: "192.0.2.2", igpAddress: "10.255.23.2", listenPort: 179 },
  { id: "core", kind: "managed-node", name: "E2E Router Gamma", transport: "agent", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "include", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl", routerId: "192.0.2.3", igpAddress: "10.255.34.1", listenPort: 179 },
  { id: "backup", kind: "managed-node", name: "E2E Router Delta", transport: "agent", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "include", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl", routerId: "192.0.2.4", igpAddress: "10.255.34.2", listenPort: 179 },
];

const inventory = {
  version: 28,
  nodes,
  peers: [],
  defines: [
    { id: "define_v4", nodeIds: null, label: "OSPF IPv4 出口", name: "OSPF_V4_EXPORT", type: "cidr4", entries: ["198.18.0.0/24"], enabled: true, entrySource: { kind: "manual" } },
    { id: "define_v6", nodeIds: null, label: "OSPF IPv6 出口", name: "OSPF_V6_EXPORT", type: "cidr6", entries: ["2001:db8:198:18::/64"], enabled: true, entrySource: { kind: "manual" } },
  ],
  functions: [
    { id: "fn_accept", nodeIds: null, label: "接受 OSPF", name: "ospf_accept", source: "function ospf_accept() { return true; }", callable: true, enabled: true },
    { id: "fn_reject", nodeIds: null, label: "拒绝 OSPF", name: "ospf_reject", source: "function ospf_reject() { return false; }", callable: true, enabled: true },
  ],
  filters: [], rpki: [], staticProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [],
  ospfDomains: [], ospfLayout: {},
};

const domain = {
  id: "ospf_e2e",
  name: "E2E OSPF 域",
  nodeConfigs: nodes.map((node, index) => ({
    nodeId: node.id,
    enabled: true,
    versions: index === 3 ? ["ospfv3"] : ["ospfv2", "ospfv3"],
    routerId: node.routerId,
    importPolicies: {
      ospfv2: { mode: "combined", formAction: "all", filterId: null, steps: [{ type: "form" }] },
      ospfv3: { mode: "combined", formAction: "all", filterId: null, steps: [{ type: "form" }] },
    },
    exportPolicies: {
      ospfv2: { mode: "combined", formAction: "cidr", filterId: null, steps: [{ type: "form" }] },
      ospfv3: { mode: "combined", formAction: "cidr", filterId: null, steps: [{ type: "form" }] },
    },
    exportDefineIds: { ospfv2: "define_v4", ospfv3: "define_v6" },
    bfd: false,
    gracefulRestart: true,
    redistributeStatic: false,
    protocolOptions: { rfc1583compat: false, rfc5838: true, instanceId: null, stubRouter: false, tick: null, ecmp: null, ecmpLimit: null, mergeExternal: false, gracefulRestartMode: "aware", gracefulRestartTime: null },
    areaOptions: {},
    virtualLinks: [],
  })),
  links: [
    { id: "link_ab", fromNodeId: "local", toNodeId: "edge", area: "0.0.0.0", localInterface: "bbtest23", remoteInterface: "bbtest23", cost: 10, hello: 10, dead: 40, passive: false, authentication: "none", options: { type: "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [] } },
    { id: "link_bc", fromNodeId: "edge", toNodeId: "core", area: "0.0.0.0", localInterface: "bbtest24", remoteInterface: "bbtest34", cost: 10, hello: 10, dead: 40, passive: false, authentication: "none", options: { type: "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [] } },
  ],
  layout: { local: { x: 800, y: 650, locked: false }, edge: { x: 1100, y: 650, locked: false }, core: { x: 1400, y: 650, locked: false }, backup: { x: 1700, y: 650, locked: false } },
};

const runtime = {
  nodes: nodes.map((node, index) => ({
    nodeId: node.id,
    name: node.name,
    runtime: {
      v2: { state: index === 3 ? null : "Full/PtP", neighbors: index === 3 ? 0 : index === 1 ? 2 : 1, routes: index === 3 ? null : 2 },
      v3: { state: index === 3 ? "Full/PtP" : "Full/PtP", neighbors: 1, routes: 1 },
      neighbors: [
        { version: "ospfv2", routerId: "192.0.2.2", priority: 1, state: "Full/PtP", deadTime: 31.5, interface: "bbtest23", address: "192.0.2.2" },
        { version: "ospfv3", routerId: "192.0.2.3", priority: 1, state: "Full/PtP", deadTime: 30, interface: "bbtest34", address: "fe80::3" },
      ],
      routes: [
        { version: "ospfv2", prefix: "198.18.0.1/32", summary: "unicast [ospf_e2e 00:00:01]", details: "via 10.255.23.1 on bbtest23" },
        { version: "ospfv3", prefix: "2001:db8:198:18::1/128", summary: "unicast [ospf_e2e 00:00:01]", details: "via fe80::2 on bbtest23" },
      ],
      routesTruncated: false,
    },
  })),
};

function dashboardPayload() {
  return {
    inventory,
    selection: { nodeId: "local", peerId: null },
    node: nodes[0], peers: [], cidrDefines: { ipv4: [inventory.defines[0]], ipv6: [inventory.defines[1]] },
    defines: inventory.defines, functions: inventory.functions, filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], selectedPeer: null,
    runtime: { nodeId: "local", reachable: true, bird2: true, version: "2.19.2", protocols: [], error: null },
    health: { status: "ready", totalNodes: nodes.length, onlineNodes: nodes.length, activeSessions: 0, normalSessions: 0, abnormalSessions: 0, nodeStatuses: nodes.map((node) => ({ nodeId: node.id, name: node.name, status: "ready", reachable: true, bird2: true, version: "2.19.2", error: null, activeSessions: 0, normalSessions: 0 })) },
    established: false, config: "", events: [],
  };
}

async function authenticate(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const title = page.locator("#authTitle");
  await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  const password = "playwright-admin-password";
  await page.locator("#authPassword").fill(password);
  if (await title.textContent() === "设置管理密码") await page.locator("#authConfirmation").fill(password);
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#appMain")).toBeVisible();
}

test("OSPF 桌面工作区覆盖拓扑、链路、策略、预览、详情和失败恢复", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await page.route("**/api/dashboard*", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardPayload()) }));
  await page.route("**/api/ospf", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ domains: [domain], layout: domain.layout, inventory }) });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ domain, inventory, deployment: { applied: true, nodeIds: nodes.map((node) => node.id), nodes, sessions: [] }, events: [] }) });
  });
  await page.route("**/api/ospf/*/runtime", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runtime) }));
  await page.route("**/api/ospf/preview", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, domain, configs: nodes.map((node) => ({ nodeId: node.id, config: `protocol ospf v2 ospf_e2e_v2 {\n  router id ${node.routerId};\n}`, validation: { ok: true, stdout: "", stderr: "" } })) }) }));
  await page.route("**/api/ospf/layout", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ layout: domain.layout, inventory }) }));
  await page.route("**/api/nodes/*/interfaces", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) as NodeId;
    const interfaces: Record<NodeId, string[]> = { local: ["bbtest23", "eth0"], edge: ["bbtest23", "bbtest24"], core: ["bbtest34", "eth0"], backup: ["bbtest24"] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ interfaces: interfaces[id] ?? [] }) });
  });
  await authenticate(page);
  await page.locator("#ospfWorkspaceTab").click();
  await expect(page.locator("#ospfWorkspace")).toBeVisible();
  await expect(page.locator(".ospf-topology-node")).toHaveCount(4);
  await expect(page.locator(".ospf-link")).toHaveCount(2);
  await expect(page.locator(".ospf-topology-canvas")).not.toHaveCSS("display", "none");
  if (testInfo.project.name === "mobile") {
    const canvas = page.locator(".ospf-topology-canvas");
    await canvas.scrollIntoViewIfNeeded();
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("OSPF topology canvas is not visible");
    // The large topology intentionally supports panning. On a narrow viewport
    // the first link is initially left of the viewport, so exercise the same
    // blank-canvas pan a user would perform before editing it.
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.8, canvasBox.y + canvasBox.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.8 + 220, canvasBox.y + canvasBox.height * 0.8, { steps: 5 });
    await page.mouse.up();
  }
  await page.screenshot({ path: testInfo.outputPath("ospf-workspace.png"), fullPage: true });

  await page.getByRole("button", { name: /编辑 local 到 edge 的 OSPF 链路/ }).click();
  await expect(page.locator(".ospf-link-editor")).toBeVisible();
  await expect(page.locator(".ospf-link-editor select").first()).toContainText("bbtest23");
  await page.locator('.ospf-link-editor input[type="number"]').first().fill("30");
  await expect(page.locator(".ospf-link-label").first()).toContainText("Cost 30");

  await page.locator(".ospf-node-row").filter({ hasText: "E2E Router Beta" }).click();
  await expect(page.locator(".ospf-editor")).toContainText("E2E Router Beta");
  const policyFunction = page.locator('.policy-block').first().getByLabel("可用 Function");
  await policyFunction.selectOption("fn_accept");
  await page.locator('.policy-block').first().getByRole("button", { name: "添加 Function" }).click();
  await expect(page.locator('.policy-block').first().locator('.function-step.selected').filter({ hasText: "接受 OSPF" })).toHaveCount(1);
  await page.locator(".ospf-node-row").filter({ hasText: "E2E Router Alpha" }).click();
  await expect(page.locator('.policy-block').first().locator('.function-step.selected').filter({ hasText: "接受 OSPF" })).toHaveCount(0);

  await page.getByRole("button", { name: "全屏查看" }).click();
  await expect(page.locator(".ospf-preview-dialog")).toBeVisible();
  await expect(page.locator(".ospf-preview-fullscreen")).toContainText("protocol ospf");
  await page.getByRole("button", { name: "关闭 OSPF 配置预览" }).click();
  await page.getByRole("button", { name: "预检配置" }).click();
  await expect(page.locator("#toastRegion .toast")).toContainText("OSPF 配置预检通过");
  await page.getByRole("button", { name: "关闭 OSPF 配置预览" }).click();

  await page.locator(".runtime-summary-card").nth(0).click();
  await expect(page.locator(".ospf-runtime-dialog")).toBeVisible();
  await expect(page.locator(".ospf-runtime-dialog")).toContainText("192.0.2.2");
  await page.getByRole("button", { name: "关闭 OSPF 运行详情" }).click();
  await page.locator(".runtime-summary-card").nth(1).click();
  await expect(page.locator(".ospf-runtime-dialog")).toContainText("198.18.0.1/32");
  await page.getByRole("button", { name: "关闭 OSPF 运行详情" }).click();

  await page.getByRole("button", { name: "放大拓扑" }).click();
  await expect(page.locator(".ospf-topology-zoom")).toContainText("110%");
  if (testInfo.project.name === "mobile") {
    const canvas = page.locator(".ospf-topology-canvas");
    await canvas.scrollIntoViewIfNeeded();
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("OSPF topology canvas is not visible");
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.8, canvasBox.y + canvasBox.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.8 + 260, canvasBox.y + canvasBox.height * 0.8, { steps: 5 });
    await page.mouse.up();
  }
  const topologyNode = page.locator(".ospf-topology-node").first();
  await topologyNode.scrollIntoViewIfNeeded();
  const nodeBefore = await topologyNode.boundingBox();
  if (!nodeBefore) throw new Error("OSPF node is not visible");
  await page.mouse.move(nodeBefore.x + 20, nodeBefore.y + 20);
  await page.mouse.down();
  await page.mouse.move(nodeBefore.x + 90, nodeBefore.y + 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => requests.filter((item) => item === "PATCH /api/ospf/layout").length).toBe(1);
  await expect(page.locator(".ospf-topology-node").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("OSPF 失败保存后恢复交互并可再次操作", async ({ page }) => {
  let saveAttempts = 0;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/dashboard*", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardPayload()) }));
  await page.route("**/api/ospf", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ domains: [domain], layout: domain.layout, inventory }) });
    saveAttempts += 1;
    return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "OSPF 链路 link_ab 接口不合法", events: [] }) });
  });
  await page.route("**/api/ospf/**", async (route) => {
    if (route.request().method() === "PUT") {
      saveAttempts += 1;
      return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "OSPF 链路 link_ab 接口不合法", events: [] }) });
    }
    return route.continue();
  });
  await page.route("**/api/ospf/*/runtime", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runtime) }));
  await page.route("**/api/nodes/*/interfaces", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ interfaces: ["bbtest23", "bbtest24"] }) }));
  await authenticate(page);
  await page.locator("#ospfWorkspaceTab").click();
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.locator("#toastRegion .toast")).toContainText("OSPF 链路 link_ab 接口不合法");
  await expect(page.getByRole("button", { name: "保存并应用" })).toBeEnabled();
  await page.getByRole("button", { name: "查询路径" }).click();
  await expect(page.locator(".ospf-path-dialog")).toBeVisible();
  expect(saveAttempts).toBe(1);
  expect(pageErrors).toEqual([]);
});

test("OSPF 20 节点 100 链路拓扑保持可交互", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const largeNodes = Array.from({ length: 20 }, (_, index) => ({
    ...nodes[index % nodes.length],
    id: `large_${index + 1}`,
    name: `Large Router ${String(index + 1).padStart(2, "0")}`,
    routerId: `192.0.2.${index + 1}`,
    igpAddress: `10.255.${Math.floor(index / 4) + 40}.${(index % 4) + 1}`,
  }));
  const largeLayout = Object.fromEntries(largeNodes.map((node, index) => [node.id, { x: 500 + (index % 5) * 330, y: 400 + Math.floor(index / 5) * 260, locked: false }]));
  const largeLinks = Array.from({ length: 100 }, (_, index) => {
    const from = index % largeNodes.length;
    const to = (from + 1 + Math.floor(index / largeNodes.length)) % largeNodes.length;
    return {
      id: `large_link_${index + 1}`,
      fromNodeId: largeNodes[from].id,
      toNodeId: largeNodes[to].id,
      area: "0.0.0.0",
      localInterface: `large${from}_${index}`,
      remoteInterface: `large${to}_${index}`,
      cost: 10 + (index % 5),
      hello: 10,
      dead: 40,
      passive: false,
      authentication: "none",
      options: { type: "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [] },
    };
  });
  const largeDomain = {
    ...domain,
    id: "ospf_large",
    name: "Large OSPF Domain",
    nodeConfigs: largeNodes.map((node) => ({ ...domain.nodeConfigs[0], nodeId: node.id, routerId: node.routerId })),
    links: largeLinks,
    layout: largeLayout,
  };
  const largeInventory = { ...inventory, nodes: largeNodes, ospfDomains: [largeDomain] };
  const baseDashboard = dashboardPayload();
  const largeDashboard = { ...baseDashboard, inventory: largeInventory, node: largeNodes[0], health: { ...baseDashboard.health, totalNodes: 20, onlineNodes: 20, nodeStatuses: largeNodes.map((node) => ({ nodeId: node.id, name: node.name, status: "ready", reachable: true, bird2: true, version: "2.19.2", error: null, activeSessions: 0, normalSessions: 0 })) } };
  const largeRuntime = { nodes: largeNodes.map((node) => ({ nodeId: node.id, name: node.name, runtime: { v2: { state: "Full/PtP", neighbors: 5, routes: 10 }, v3: { state: "Full/PtP", neighbors: 5, routes: 10 }, neighbors: [], routes: [], routesTruncated: false } })) };
  await page.route("**/api/dashboard*", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(largeDashboard) }));
  await page.route("**/api/ospf", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ domains: [largeDomain], layout: largeLayout, inventory: largeInventory }) }));
  await page.route("**/api/ospf/*/runtime", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(largeRuntime) }));
  await page.route("**/api/nodes/*/interfaces", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ interfaces: ["eth0", "large0"] }) }));
  await authenticate(page);
  const started = Date.now();
  await page.locator("#ospfWorkspaceTab").click();
  await expect(page.locator("#ospfWorkspace")).toBeVisible();
  await expect(page.locator(".ospf-topology-node")).toHaveCount(20);
  await expect(page.locator(".ospf-link")).toHaveCount(100);
  await page.getByRole("button", { name: "放大拓扑" }).click();
  await page.getByRole("button", { name: "缩小拓扑" }).click();
  await expect(page.locator(".ospf-topology-zoom")).toContainText("100%");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("ospf-large-topology.png"), fullPage: true });
});

test("OSPF 节点运行态错误在高缩放下仍可见且页面可继续操作", async ({ page }) => {
  const runtimeWithError = {
    nodes: nodes.map((node, index) => ({
      nodeId: node.id,
      name: node.name,
      runtime: index === 1
        ? { error: "节点 OSPF 运行态检查超时", v2: { state: null, neighbors: 0, routes: null }, v3: { state: null, neighbors: 0, routes: null }, neighbors: [], routes: [], routesTruncated: false }
        : { error: null, v2: { state: "Full/PtP", neighbors: 1, routes: 1 }, v3: { state: null, neighbors: 0, routes: null }, neighbors: [], routes: [], routesTruncated: false },
    })),
  };
  await page.route("**/api/dashboard*", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardPayload()) }));
  await page.route("**/api/ospf", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ domains: [domain], layout: domain.layout, inventory }) }));
  await page.route("**/api/ospf/*/runtime", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runtimeWithError) }));
  await page.route("**/api/nodes/*/interfaces", async (route) => await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ interfaces: ["bbtest23", "bbtest24"] }) }));
  // A narrow CSS viewport models 200% browser zoom without the non-standard
  // `style.zoom` transform, which otherwise reports the transformed canvas as
  // document overflow even though a real browser reflows it.
  await page.setViewportSize({ width: 640, height: 900 });
  await authenticate(page);
  await page.locator("#ospfWorkspaceTab").click();
  await expect(page.locator("#ospfWorkspace")).toBeVisible();
  await page.locator(".ospf-node-row").filter({ hasText: "E2E Router Beta" }).click();
  await expect(page.locator(".ospf-runtime")).toContainText("节点 OSPF 运行态检查超时");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "预检配置" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
