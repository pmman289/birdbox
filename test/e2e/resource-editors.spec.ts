import { expect, test } from "@playwright/test";

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

test("Vue 资源编辑器保留完整功能、错误定位和无重叠布局", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/dashboard**", async (route) => {
    const response = await route.fetch();
    const dashboard = await response.json();
    dashboard.inventory.rpki = [
      {
        id: "e2e_global_roa",
        nodeId: null,
        label: "E2E 全局 ROA",
        name: "e2e_global_roa",
        enabled: true,
        sourceType: "file",
        roa4Table: "E2E_ROA4",
        roa6Table: "E2E_ROA6",
        file4: "/etc/bird/e2e-roa4.conf",
        file6: "/etc/bird/e2e-roa6.conf",
      },
      {
        id: "e2e_global_rtr",
        nodeId: null,
        label: "E2E 全局 RTR",
        name: "e2e_global_rtr",
        enabled: true,
        sourceType: "server",
        roa4Table: "E2E_RTR4",
        roa6Table: null,
        remote: "rpki.example",
        port: 323,
        transport: "tcp",
        authentication: "none",
      },
    ];
    await route.fulfill({ response, json: dashboard });
  });
  await authenticate(page);
  await page.locator("#resourceWorkspaceTab").click();

  await page.locator("#resource-nodes .primary-button").click();
  const rpkiWarning = page.locator("#nodeGlobalRpkiWarning");
  await expect(rpkiWarning).toBeVisible();
  await expect(rpkiWarning).toContainText("E2E 全局 ROA");
  await expect(rpkiWarning).toContainText("/etc/bird/e2e-roa4.conf");
  await expect(rpkiWarning).toContainText("先将 ROA 文件同步到上述路径");
  await expect(rpkiWarning).toContainText("E2E 全局 RTR");
  await expect(rpkiWarning).toContainText("rpki.example:323");
  await expect(rpkiWarning).toContainText("确认新节点可访问该 RPKI-RTR 地址和端口");
  await expect(rpkiWarning).toContainText("把作用域改为指定节点");
  await page.locator("#nodeEditorName").fill("E2E SSH Router");
  await page.locator("#nodeEditorSshHost").fill("192.0.2.10");
  await page.locator("#nodeEditorSshUser").fill("birdbox");
  await page.locator("#nodeEditorRouterId").fill("192.0.2.10");
  await page.getByText("OpenWrt", { exact: true }).click();
  await expect(page.locator("#nodeEditorMainConfigPath")).toHaveValue("/etc/bird.conf");
  await expect(page.locator("#nodeEditorGeneratedConfigPath")).toHaveValue("/etc/birdbox/generated.conf");
  await expect(page.locator("#nodeEditorSocketPath")).toHaveValue("/var/run/bird.ctl");
  await page.locator("#generateNodeSetupButton").click();
  await expect(page.locator("#nodeSetupGuide")).toBeVisible();
  await expect(page.locator("#nodeSetupScript")).toContainText("birdbox");
  await expect(page.locator("#nodeSetupScript")).toContainText("/etc/openwrt_release");
  await page.locator('#nodeDialog [data-close="nodeDialog"]').click();

  await page.getByRole("button", { name: "编辑节点 E2E Router" }).click();
  await expect(page.locator("#nodeDialog")).toBeVisible();
  await expect(page.locator("#nodeEditorRouterId")).toHaveValue("192.0.2.1");
  await page.locator('#nodeDialog [data-close="nodeDialog"]').click();

  await page.locator("#resourcePeersTab").click();
  await page.locator("#managementPeerRows .row-edit-button").click();
  await expect(page.locator("#peerDialog")).toBeVisible();
  await expect(page.locator("#peerEditorAddress")).toHaveValue("192.0.2.2");
  await page.locator('#peerDialog [data-close="peerDialog"]').click();
  await page.locator("#resource-peers .primary-button").click();
  await page.locator("#peerEditorName").fill("");
  await page.locator("#savePeerButton").click();
  await expect(page.locator("#peerEditorName")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#toastRegion")).toContainText("Peer 名称");
  await page.locator('#peerDialog [data-close="peerDialog"]').click();

  await page.locator("#resourceDefinesTab").click();
  await page.locator('#managementDefineRows .row-edit-button[title="编辑 Define"]').click();
  await expect(page.locator("#policyResourceDialog")).toBeVisible();
  await expect(page.locator("#policyResourceSourceLabel")).toContainText("CIDR");
  await expect(page.locator('input[name="policyResourceScopeMode"][value="selected"]')).toBeChecked();
  await expect(page.locator('.policy-scope-node input[value="local"]')).toBeChecked();
  await page.locator('#policyResourceDialog [data-close="policyResourceDialog"]').click();

  await page.locator("#resourceFunctionsTab").click();
  await page.locator("#resource-functions .primary-button").click();
  await expect(page.locator("#policyResourceDialog")).toBeVisible();
  await page.locator("#policyResourceNodeScope .segmented-control label").filter({ hasText: "指定节点" }).click();
  await page.locator("#savePolicyResourceButton").click();
  await expect(page.locator("#policyResourceNodeScope")).toHaveAttribute("aria-invalid", "true");
  await page.locator('.policy-scope-node input[value="local"]').check();
  await expect(page.locator("#policySourceReferences")).toContainText("e2e_peer CIDRs");
  await page.locator('.policy-scope-node input[value="edge"]').check();
  await expect(page.locator("#policySourceReferences")).not.toContainText("e2e_peer CIDRs");
  await expect(page.locator("#policyResourceNodeScope")).toContainText("已选择 2 个节点");
  await page.locator('#policyResourceDialog [data-close="policyResourceDialog"]').click();

  await page.locator("#resourceStaticsTab").click();
  await page.locator("#resource-statics .primary-button").click();
  await expect(page.locator("#staticDialog")).toBeVisible();
  await page.locator("#staticLabel").fill("E2E Static");
  await page.locator("#staticDefineId").selectOption({ index: 1 });
  await expect(page.locator("#staticRouteActionsSection")).toBeVisible();
  await expect(page.locator("#staticRouteActionList .static-route-row")).toHaveCount(1);
  await page.locator(".static-filter-add-controls .secondary-button").click();
  const operationRow = page.locator(".static-filter-operation-row").first();
  await expect(operationRow).toBeVisible();
  const overlaps = await operationRow.evaluate((row) => {
    const fields = [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")];
    const buttons = [...row.querySelectorAll<HTMLButtonElement>(".static-filter-operation-actions button")];
    return fields.some((field) => buttons.some((button) => {
      const a = field.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }));
  });
  expect(overlaps).toBe(false);
  await page.locator('#staticDialog [data-close="staticDialog"]').click();

  await page.locator("#resourceRpkiTab").click();
  await page.locator("#resource-rpki .primary-button").click();
  await expect(page.locator("#rpkiDialog")).toBeVisible();
  await page.locator("#rpkiSourceType").selectOption("server");
  await expect(page.locator("#rpkiServerFields")).toBeVisible();
  await page.locator("#rpkiTransport").selectOption("ssh");
  await expect(page.locator("#rpkiSshFields")).toBeVisible();
  await page.locator('#rpkiDialog [data-close="rpkiDialog"]').click();

  expect(pageErrors).toEqual([]);
});
