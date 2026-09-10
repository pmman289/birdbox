import { expect, test } from "@playwright/test";

// Long-running topology pressure harness.  It authenticates once and keeps a
// single browser session alive so the auth rate limiter cannot mask rendering
// results.  The API responses are deterministic fixtures; this test measures
// DOM/layout interaction and browser stability rather than network latency.
const nodes = Array.from({ length: 20 }, (_, i) => ({
  id: `pressure_${i + 1}`,
  kind: "managed-node",
  name: `Pressure Router ${String(i + 1).padStart(2, "0")}`,
  transport: "agent",
  sshHost: null,
  sshPort: null,
  sshUser: null,
  sshIdentity: "default",
  deploymentMode: "include",
  mainConfigPath: "/etc/bird/bird.conf",
  generatedConfigPath: "/var/lib/birdbox/generated.conf",
  socketPath: "/run/bird/bird.ctl",
  routerId: `192.0.2.${i + 1}`,
  igpAddress: null,
  listenPort: 179,
}));
const links = Array.from({ length: 100 }, (_, i) => {
  const from = i % nodes.length;
  const to = (from + 1 + Math.floor(i / nodes.length)) % nodes.length;
  return {
    id: `pressure_link_${i + 1}`,
    fromNodeId: nodes[from]!.id,
    toNodeId: nodes[to]!.id,
    area: "0.0.0.0",
    localInterface: `pressure${from}_${i}`,
    remoteInterface: `pressure${to}_${i}`,
    cost: 10 + (i % 5),
    hello: 10,
    dead: 40,
    passive: false,
    authentication: "none",
    options: { type: "ptp", deadMode: "count", checkLink: true, ttlSecurity: "off", neighbors: [] },
  };
});
const nodeConfigs = nodes.map((node) => ({
  nodeId: node.id,
  enabled: true,
  versions: ["ospfv2", "ospfv3"],
  routerId: node.routerId,
  importPolicies: { ospfv2: { mode: "form", formAction: "all" }, ospfv3: { mode: "form", formAction: "all" } },
  exportPolicies: { ospfv2: { mode: "form", formAction: "none" }, ospfv3: { mode: "form", formAction: "none" } },
  exportDefineIds: { ospfv2: null, ospfv3: null },
  bfd: false,
  gracefulRestart: true,
  redistributeStatic: false,
  protocolOptions: { gracefulRestartMode: "aware" },
  areaOptions: { "0.0.0.0": {} },
  virtualLinks: [],
}));
const layout = Object.fromEntries(nodes.map((node, i) => [node.id, { x: 450 + (i % 5) * 300, y: 350 + Math.floor(i / 5) * 250, locked: false }]));
const domain = { id: "ospf_pressure", name: "OSPF Topology Pressure", nodeConfigs, links, layout };
const inventory = { version: 28, nodes, peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [domain], ospfLayout: {} };
const dashboard = {
  inventory,
  selection: { nodeId: nodes[0]!.id, peerId: null },
  node: nodes[0], peers: [], cidrDefines: { ipv4: [], ipv6: [] }, defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], selectedPeer: null,
  runtime: { nodeId: nodes[0]!.id, reachable: true, bird2: true, version: "2.19.2", protocols: [], error: null },
  health: { status: "ready", totalNodes: nodes.length, onlineNodes: nodes.length, activeSessions: 0, normalSessions: 0, abnormalSessions: 0, nodeStatuses: nodes.map((node) => ({ nodeId: node.id, name: node.name, status: "ready", reachable: true, bird2: true, version: "2.19.2", error: null, activeSessions: 0, normalSessions: 0 })) },
  established: false, config: "", events: [],
};

test("OSPF 拓扑单会话一小时压力循环", async ({ page }, testInfo) => {
  // The loop intentionally runs for one hour; override Playwright's 45s default.
  test.setTimeout(4_000_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/dashboard*", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboard) }));
  await page.route("**/api/ospf", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ domains: [domain], layout, inventory }) }));
  await page.route("**/api/ospf/*/runtime", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ nodes: nodes.map((node) => ({ nodeId: node.id, name: node.name, runtime: { reachable: true, error: null, v2: { state: "Full/PtP", neighbors: 5, routes: 10 }, v3: { state: "Full/PtP", neighbors: 5, routes: 10 }, neighbors: [], routes: [], routesTruncated: false, interfaces: [] } })) }) }));
  await page.route("**/api/nodes/*/interfaces", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ interfaces: ["eth0", "pressure0"] }) }));
  await page.route("**/api/ospf/layout", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ layout, inventory }) }));
  await page.goto("/");
  const title = page.locator("#authTitle");
  await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  const password = "playwright-pressure-password";
  await page.locator("#authPassword").fill(password);
  if ((await title.textContent()) === "设置管理密码") await page.locator("#authConfirmation").fill(password);
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#appMain")).toBeVisible();
  await page.locator("#ospfWorkspaceTab").click();
  await expect(page.locator("#ospfWorkspace")).toBeVisible();
  await expect(page.locator(".ospf-topology-node")).toHaveCount(20);
  await expect(page.locator(".ospf-link")).toHaveCount(100);
  const canvas = page.locator(".ospf-topology-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("topology canvas is not visible");
  const started = Date.now();
  const rounds = 360;
  for (let round = 0; round < rounds; round += 1) {
    await page.getByRole("button", { name: "放大拓扑" }).click();
    await page.getByRole("button", { name: "缩小拓扑" }).click();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8 + (round % 2 ? 40 : -40), box.y + box.height * 0.8, { steps: 2 });
    await page.mouse.up();
    if (round % 10 === 0) {
      await expect(page.locator(".ospf-topology-node")).toHaveCount(20);
      await expect(page.locator(".ospf-link")).toHaveCount(100);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  await page.screenshot({ path: testInfo.outputPath("ospf-topology-pressure-final.png"), fullPage: true });
  expect(Date.now() - started).toBeGreaterThanOrEqual(3_590_000);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
