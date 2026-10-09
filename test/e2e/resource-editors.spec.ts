import { expect, test } from "@playwright/test";
import type { SourcePolicyManualPlan } from "../../packages/contracts/src/api";
import type { SourcePolicyEgress } from "../../packages/contracts/src/inventory";

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

test("源地址出口保存后继续编辑保留分配，删除结果不被旧预览覆盖", async ({ page }) => {
  test.setTimeout(75_000);
  let resource: SourcePolicyEgress | null = null;
  const writes: Array<{ method: string; path: string; body: Record<string, any> }> = [];
  let holdPreview = false;
  let heldPreviews = 0;
  let releasePreview!: () => void;
  const previewBarrier = new Promise<void>((resolve) => { releasePreview = resolve; });
  const plan = (birdConfig: string): SourcePolicyManualPlan => ({
    operation: "reconcile", resourceId: "e2e_saved_source_policy", resourceLabel: "E2E 出口",
    nodeId: "local", nodeName: "E2E Router", platform: "linux", birdConfig,
    rules: [], removeRules: [], gatewayRules: [], removeGatewayRules: [],
    managedRules: [], removeManagedRules: [], applyScript: null, cleanupScript: birdConfig,
    systemdUnit: null, systemdInstallScript: null, instructions: [],
    management: "manual", upgradeRequired: false, warning: null,
  });
  await page.route("**/api/dashboard**", async (route) => {
    const response = await route.fetch();
    const dashboard = await response.json();
    dashboard.inventory.sourcePolicies = resource ? [resource] : [];
    await route.fulfill({ response, json: dashboard });
  });
  await page.route(/\/api\/source-policies(?:\/[^?]*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith("/preview")) {
      if (holdPreview) {
        heldPreviews += 1;
        await previewBarrier;
      }
      await route.fulfill({ json: { manualPlans: [plan("旧草稿预览")] } });
      return;
    }
    const body = method === "DELETE" ? {} : route.request().postDataJSON();
    writes.push({ method, path, body });
    if (method === "DELETE") {
      resource = null;
      await route.fulfill({ json: { manualPlans: [plan("已删除后的规则清理")] } });
      return;
    }
    resource = {
      ...body, id: "e2e_saved_source_policy", rulePriorityBase: 10000,
      groups: body.groups.map((group: Record<string, unknown>) => ({
        ...group, id: "e2e_saved_gateway", kernelTable: 50001, ruleSlot: 0,
      })),
    } as SourcePolicyEgress;
    await route.fulfill({ json: { resource, manualPlans: [plan("已保存的配置")] } });
  });
  try {
    await authenticate(page);
    await page.locator("#resourceWorkspaceTab").click();
    await page.locator("#resourceSourcePoliciesTab").click();
    await page.locator("#resource-sourcePolicies .primary-button").click();
    const dialog = page.locator("#sourcePolicyDialog");
    await page.locator("#sourcePolicyLabel").fill("E2E 出口");
    await page.locator("#sourcePolicyGroup0").fill("172.20.177.36");
    await page.locator("#sourcePolicySource0_0").fill("198.51.100.10/32");
    await page.locator('label[for="sourcePolicyCopyInternal"]').click();
    await expect(page.locator("#sourcePolicyCopyInternal")).not.toBeChecked();
    await expect(dialog).toContainText("旧草稿预览");
    const save = dialog.getByRole("button", { name: "预检、保存并下发 BIRD" });
    await save.click();
    await expect(page.locator("#sourcePolicyDialogTitle")).toHaveText("编辑源地址出口映射");
    await expect(page.locator("#sourcePolicyKernelTable0")).toHaveValue("50001");
    await expect(save).toBeEnabled();
    await page.locator("#sourcePolicyLabel").fill("E2E 更新出口");
    await save.click();
    await expect(save).toBeEnabled();
    expect(writes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/api/source-policies" },
      { method: "PUT", path: "/api/source-policies/e2e_saved_source_policy" },
    ]);
    expect(writes[1]?.body.groups[0]).toMatchObject({ id: "e2e_saved_gateway", kernelTable: 50001 });

    holdPreview = true;
    await page.locator("#sourcePolicyLabel").fill("等待预览时删除");
    await expect.poll(() => heldPreviews).toBeGreaterThan(0);
    page.once("dialog", (confirmation) => confirmation.accept());
    await dialog.getByRole("button", { name: "删除映射集" }).click();
    await expect(page.locator("#sourcePolicyDialogTitle")).toHaveText("系统规则清理");
    releasePreview();
    await expect(dialog).toContainText("已删除后的规则清理");
    await expect(dialog).not.toContainText("旧草稿预览");
  } finally {
    releasePreview();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("Vue 资源编辑器保留完整功能、错误定位和无重叠布局", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/dashboard**", async (route) => {
    const response = await route.fetch();
    const dashboard = await response.json();
    dashboard.inventory.rpki = [
      {
        id: "e2e_global_roa",
        nodeIds: null,
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
        nodeIds: null,
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
    dashboard.inventory.sourcePolicies = [{
      id: "e2e_global_source_policy",
      nodeIds: null,
      label: "E2E 全局出口",
      enabled: true,
      groups: [{ id: "gateway", egressAddress: "172.20.177.36", sources: ["198.51.100.1/32"], kernelTable: 200, ruleSlot: 0 }],
      rulePriorityBase: 10000,
      copyInternalRoutes: false,
      internalDefineIds: [],
    }];
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
  await expect(page.locator("#nodeGlobalSourcePolicyWarning")).toContainText("E2E 全局出口");
  await expect(page.locator("#nodeGlobalSourcePolicyWarning")).toContainText("自动下发这些 BIRD 映射和系统 ip rule");
  await expect(page.locator("#nodeGlobalSourcePolicyWarning")).toContainText("请先升级该节点为 Agent");
  await expect(page.locator("#nodeGlobalSourcePolicyWarning")).toContainText("旧节点不会被自动执行规则");
  await page.locator("#nodeEditorName").fill("E2E Agent Router");
  await expect(page.locator("#nodeEditorSshHost")).toHaveCount(0);
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

  await page.getByRole("button", { name: "编辑节点 E2E Edge" }).click();
  await expect(page.locator("#nodeEditorSshHost")).toBeEnabled();
  await expect(page.locator("#nodeEditorSshPort")).toBeEnabled();
  await expect(page.locator("#sshHostField")).toContainText("可修改为公网地址");
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
  await expect(page.locator('#policyResourceNodeScope input[value="selected"]')).toBeChecked();
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

  await page.locator("#resourceFiltersTab").click();
  await page.locator("#resource-filters .primary-button").click();
  await expect(page.locator("#policyResourceDialog")).toBeVisible();
  await page.locator("#policyResourceNodeScope .segmented-control label").filter({ hasText: "指定节点" }).click();
  await page.locator('.policy-scope-node input[value="local"]').check();
  await page.locator('.policy-scope-node input[value="edge"]').check();
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
  await page.locator("#rpkiNodeScope .segmented-control label").filter({ hasText: "指定节点" }).click();
  await page.locator('#rpkiNodeScope .policy-scope-node input[value="local"]').check();
  await page.locator('#rpkiNodeScope .policy-scope-node input[value="edge"]').check();
  await expect(page.locator("#rpkiNodeScope")).toContainText("已选择 2 个节点");
  await page.locator("#rpkiSourceType").selectOption("server");
  await expect(page.locator("#rpkiServerFields")).toBeVisible();
  await page.locator("#rpkiTransport").selectOption("ssh");
  await expect(page.locator("#rpkiSshFields")).toBeVisible();
  await page.locator('#rpkiDialog [data-close="rpkiDialog"]').click();

  await page.locator("#resourceSourcePoliciesTab").click();
  await page.locator("#resource-sourcePolicies .primary-button").click();
  await expect(page.locator("#sourcePolicyDialog")).toBeVisible();
  await page.locator("#sourcePolicyLabel").fill("E2E 源地址出口");
  await page.locator(".source-policy-import summary").click();
  await page.locator(".source-policy-import textarea").fill(JSON.stringify({
    "172.20.177.36": ["162.141.136.139/32", "162.141.136.138/32"],
    "172.20.177.38": ["82.47.33.189/32"],
  }, null, 2));
  await page.getByRole("button", { name: "解析并替换出口组" }).click();
  await expect(page.locator(".source-policy-group")).toHaveCount(2);
  await expect(page.locator(".source-policy-source-row")).toHaveCount(3);
  await expect(page.locator(".source-policy-group").first()).toContainText("2 条");
  await page.locator("#sourcePolicyKernelTable0").fill("50000");
  await expect(page.locator("#sourcePolicyKernelTable0")).toHaveValue("50000");
  await expect(page.locator("#sourcePolicyDialog")).toContainText("kernel table 50000");
  await expect(page.locator("#sourcePolicyDialog")).toContainText("本机自动下发");
  await expect(page.locator("#sourcePolicyDialog")).toContainText("BIRD 配置片段");
  const sourcePolicyOverflow = await page.locator("#sourcePolicyDialog").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(sourcePolicyOverflow).toBe(false);
  await page.locator("#sourcePolicyDialog").getByRole("button", { name: "关闭" }).click();

  expect(pageErrors).toEqual([]);
});
