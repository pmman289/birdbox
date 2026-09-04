import { expect, test } from "@playwright/test";

import { defaultBgpOptions, defaultChannel } from "../../apps/web/src/sessions/session-draft";

async function authenticate(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/");
  const title = page.locator("#authTitle");
  await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  const password = "playwright-admin-password";
  await page.locator("#authPassword").fill(password);
  if ((await title.textContent()) === "设置管理密码")
    await page.locator("#authConfirmation").fill(password);
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#appMain")).toBeVisible();
}

test("iBGP 工作区提供顶部画布、搜索连接、双端配置和实时预览", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const existingDomain = {
    id: "ibgp_existing",
    name: "Existing Core",
    asn: 64512,
    members: [
      { nodeId: "local", address: "192.0.2.1" },
      { nodeId: "edge", address: "192.0.2.22" },
    ],
    adjacencies: [{
      id: "ibgp_existing_pair",
      leftNodeId: "local",
      rightNodeId: "edge",
      enabled: true,
      leftSessionId: "ibgp_existing_left",
      rightSessionId: "ibgp_existing_right",
    }],
    layout: {
      local: { x: 36, y: 40, locked: false },
      edge: { x: 226, y: 40, locked: false },
    },
  };
  const existingSessions = [
    { id: "ibgp_existing_left", nodeId: "local", peerId: "ibgp_existing_pair_peer_left", protocolName: "preserved_left", localAddress: "192.0.2.1", localAsn: 64512 },
    { id: "ibgp_existing_right", nodeId: "edge", peerId: "ibgp_existing_pair_peer_right", protocolName: "preserved_right", localAddress: "192.0.2.22", localAsn: 64512 },
  ].map((session) => ({
    ...session,
    localPort: 1179,
    bgp: { ...defaultBgpOptions(), connectionMode: "multihop" as const },
    channels: {
      ipv4: { ...defaultChannel(), exportPolicy: { ...defaultChannel().exportPolicy, formAction: "all" as const } },
      ipv6: defaultChannel(),
    },
    enabled: true,
    sessionType: "ibgp" as const,
    managedBy: { kind: "ibgp-domain" as const, domainId: existingDomain.id, adjacencyId: existingDomain.adjacencies[0].id },
  }));
  await page.route("**/api/ibgp-domains", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        domains: [existingDomain],
        inventory: {
          version: 25,
          nodes: [
            { id: "local", kind: "managed-node", name: "E2E Router", transport: "local", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "legacy", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/tmp/local.conf", socketPath: "/tmp/local.ctl", routerId: "198.51.100.1", igpAddress: "10.0.0.1", listenPort: 179 },
            { id: "edge", kind: "managed-node", name: "E2E Edge", transport: "ssh", sshHost: "192.0.2.22", sshPort: 22, sshUser: "birdbox", sshIdentity: "default", deploymentMode: "legacy", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/tmp/edge.conf", socketPath: "/tmp/edge.ctl", routerId: "198.51.100.2", igpAddress: "10.0.0.2", listenPort: 179 },
          ],
          peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [],
          sessions: existingSessions,
          ibgpDomains: [existingDomain],
        },
      }),
    });
  });
  await page.route("**/api/ibgp-domains/preview", async (route) => {
    const body = route.request().postDataJSON() as Record<string, any>;
    const domain = { ...body, id: body.id || "ibgp_preview" };
    delete domain.sessionUpdates;
    const sessions = (body.sessionUpdates ?? []).map(
      (session: Record<string, any>) => ({
        ...session,
        managedBy: { ...session.managedBy, domainId: domain.id },
      }),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        domain,
        sessions,
        sides: sessions.map((session: Record<string, any>, index: number) => ({
          side: index === 0 ? "left" : "right",
          nodeId: session.nodeId,
          nodeName: index === 0 ? "E2E Router" : "E2E Edge",
          session,
          config: `protocol bgp ${session.protocolName} {\n  local as 64512;\n  neighbor 192.0.2.${index + 1} as 64512;\n}`,
          validation: { ok: true, stdout: "", stderr: "", code: 0 },
        })),
      }),
    });
  });
  await authenticate(page);
  await expect(page.locator(".workspace-tabs .workspace-tab")).toHaveText([
    "eBGP 管理",
    "iBGP 管理",
    "OSPF 管理",
    "资源管理",
  ]);
  await page.locator("#ibgpWorkspaceTab").click();
  await expect(page.locator("#ibgpWorkspace")).toBeVisible();
  await expect(page.locator(".ibgp-side-editor")).toHaveCount(2);
  await expect(page.locator('.ibgp-side-editor input[type="number"]').first()).toHaveValue("1179");
  await expect(page.locator('.ibgp-side-editor input[pattern="[A-Za-z_][A-Za-z0-9_]*"]').first()).toHaveValue("preserved_left");
  await page.getByRole("button", { name: "新建域" }).click();
  await expect(page.locator("#ibgpName")).toHaveValue("新 iBGP 域");
  await expect(page.locator("#ibgpAsn")).toHaveValue("64512");
  await expect(page.locator(".ibgp-canvas .ibgp-node")).toHaveCount(2);
  await expect(page.locator(".ibgp-workspace")).not.toContainText("拓扑模式");
  await expect(page.locator(".ibgp-workspace")).not.toContainText("节点角色");
  await expect(page.locator(".ibgp-workspace")).not.toContainText("地址族");
  await page
    .locator(".ibgp-canvas .ibgp-node")
    .filter({ hasText: "E2E Router" })
    .click();
  await expect(page.locator(".ibgp-transport-field input")).toHaveValue("10.0.0.1");
  await page.locator("#ibgpConnectionSearch").fill("Edge");
  await expect(page.locator(".quick-node")).toHaveCount(1);
  await page.locator(".quick-node").click();
  await expect(page.locator(".ibgp-session-grid .ibgp-side-editor")).toHaveCount(2);
  await expect(
    page.locator(".ibgp-side-editor").first().getByLabel("本端 RR Cluster ID"),
  ).toBeEnabled();
  const protocolInputs = page.locator('.ibgp-side-editor input[pattern="[A-Za-z_][A-Za-z0-9_]*"]').first();
  await expect(protocolInputs).toHaveValue(/^ibgp_/);
  const protocolName = await protocolInputs.inputValue();
  expect(protocolName.length).toBeLessThanOrEqual(48);
  expect(protocolName).not.toContain("ibgp_adj_");
  const sessionColumns = await page.locator(".ibgp-session-grid").evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(sessionColumns).toBe(testInfo.project.name === "desktop" ? 2 : 1);
  await page
    .locator(".ibgp-side-editor .advanced-settings > summary")
    .first()
    .click();
  await expect(page.locator(".ibgp-side-editor").first()).toContainText(
    "Graceful Restart",
  );
  await expect(page.locator(".ibgp-channel-editors").first()).toContainText("导入策略");
  await expect(page.locator(".ibgp-preview-panels")).toHaveCount(2);
  await expect(page.locator(".ibgp-preview-panels pre").first()).toContainText(
    "protocol bgp",
  );
  await protocolInputs.fill("ibgp_left_custom");
  await expect(page.locator(".ibgp-preview-panels pre").first()).toContainText(
    "protocol bgp ibgp_left_custom",
  );
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  expect(pageErrors).toEqual([]);
});
