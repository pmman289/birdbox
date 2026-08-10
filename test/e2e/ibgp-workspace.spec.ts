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

test("iBGP 工作区提供节点画布、域参数和双向配置入口", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await authenticate(page);
  await page.locator("#ibgpWorkspaceTab").click();
  await expect(page.locator("#ibgpWorkspace")).toBeVisible();
  await page.getByRole("button", { name: "新建域" }).click();
  await expect(page.locator("#ibgpName")).toHaveValue("新 iBGP 域");
  await expect(page.locator("#ibgpAsn")).toHaveValue("64512");
  await expect(page.locator(".ibgp-canvas .ibgp-node")).toHaveCount(1);
  await expect(page.locator(".ibgp-canvas .ibgp-node")).toContainText("E2E Router");
  await page.locator(".ibgp-editor-panel select").filter({ has: page.locator('option[value="route-reflector"]') }).selectOption("route-reflector");
  await page.locator(".ibgp-subsection select").first().selectOption("reflector");
  await expect(page.locator(".ibgp-canvas .ibgp-node")).toContainText("reflector");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  expect(pageErrors).toEqual([]);
});
