import { expect, test } from "@playwright/test";

test("Vue 认证壳完成认证、退出和重新登录", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  const authView = page.locator("#authView");
  await expect(authView).toBeVisible();
  const authTitle = page.locator("#authTitle");
  await expect(authTitle).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  await page.screenshot({ path: testInfo.outputPath("auth-shell.png"), fullPage: true });

  const initialTheme = await page.locator("html").getAttribute("data-theme");
  await page.locator("#authView [data-theme-toggle]").click();
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).not.toBe(initialTheme);

  const password = "playwright-admin-password";
  await page.locator("#authPassword").fill(password);
  if (await authTitle.textContent() === "设置管理密码") {
    await page.locator("#authConfirmation").fill(password);
  }
  await page.locator("#authSubmitButton").click();

  await expect(page.locator("#appHeader")).toBeVisible();
  await expect(page.locator("#appMain")).toBeVisible();
  await expect(authView).toBeHidden();
  await expect(page.locator("#globalState")).not.toHaveText("正在连接");
  await expect(page.locator("#dashboardOverviewApp #topologyTitle")).toHaveText("BGP 会话拓扑");
  await expect(page.locator("#dashboardOverviewApp #nodeSelect")).toContainText("E2E Router");
  await expect(page.locator("#dashboardOverviewApp .peer-card")).toContainText("Documentation Peer");
  await expect(page.locator("#dashboardRuntimeApp .protocol-table-wrap")).toContainText("e2e_peer");
  await expect(page.locator("#sessionEditorApp #protocolName")).toHaveValue("e2e_peer");
  await expect(page.locator('#sessionEditorApp [data-field="localAsn"] input')).toHaveValue("64512");
  const localAddress = page.locator('#sessionEditorApp [data-field="localAddress"] input');
  await localAddress.fill("192.0.2.1");
  await page.waitForTimeout(700);
  await expect(localAddress).toBeFocused();
  await page.locator("#sessionEditorApp .afi-tab").filter({ hasText: "IPv6" }).click();
  await expect(page.locator("#sessionEditorApp .afi-channel-panel.active")).toContainText("IPv6 Channel");
  await page.locator("#sessionEditorApp .afi-channel-panel.active .compact-action-button").first().click();
  await expect(page.locator("#sessionEditorApp .policy-action-dialog")).toBeVisible();
  await page.locator("#sessionEditorApp .policy-action-dialog .secondary-button").click();
  await page.locator("#dashboardRuntimeApp #eventLogTab").click();
  await expect(page.locator("#dashboardRuntimeApp #eventLog")).toHaveClass(/active/);
  await page.locator("#dashboardRuntimeApp #localConfigTab").click();
  await expect(page.locator("#dashboardRuntimeApp #localConfig")).toHaveClass(/active/);
  await page.locator("#resourceWorkspaceTab").click();
  await expect(page.locator("#managementNodeRows")).toContainText("E2E Router");
  await page.locator("#managementNodeRows .row-edit-button").click();
  await expect(page.locator("#nodeDialog")).toBeVisible();
  await page.locator('#nodeDialog [data-close="nodeDialog"]').click();
  await page.locator("#resourceDefinesTab").click();
  await expect(page.locator("#managementDefineRows")).toContainText("e2e_peer CIDRs");
  await page.locator("#sessionWorkspaceTab").click();
  await page.screenshot({ path: testInfo.outputPath("application-shell.png"), fullPage: true });

  await page.locator("#logoutButton").click();
  await expect(authView).toBeVisible();
  await expect(page.locator("#authTitle")).toHaveText("登录 Birdbox");

  await page.locator("#authPassword").fill(password);
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#appHeader")).toBeVisible();
  await expect(authView).toBeHidden();
  expect(pageErrors).toEqual([]);
});
