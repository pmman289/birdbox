import { expect, test, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.request.post("/api/auth/logout");
});

async function authenticate(page: Page): Promise<void> {
  await page.goto("/");
  const title = page.locator("#authTitle");
  await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  await page.locator("#authPassword").fill("playwright-admin-password");
  if ((await title.textContent()) === "设置管理密码") {
    await page.locator("#authConfirmation").fill("playwright-admin-password");
  }
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#appMain")).toBeVisible();
}

test("当前项 Filter 代码输入可进入 eBGP 预检且不要求共享 Filter", async ({ page }) => {
  let previewBody: Record<string, any> | undefined;
  await page.route("**/api/sessions/preview", async (route) => {
    previewBody = route.request().postDataJSON() as Record<string, any>;
    await route.fulfill({
      json: {
        valid: true,
        inventoryRevision: previewBody.inventoryRevision ?? 1,
        previewId: "current-filter-preview",
        candidateHash: "current-filter-hash",
        previousConfig: "",
        diff: "+ inline filter",
        config: "protocol bgp e2e_peer { ipv4 { import filter { accept; reject; }; }; }",
        sessionConfig: "protocol bgp e2e_peer {}",
        session: { ...previewBody, id: "session_e2e" },
        events: [],
        validation: { ok: true, stdout: "Syntax OK", stderr: "" },
      },
    });
  });
  // The real fixture contains an unreachable SSH node. Keep the browser flow
  // focused on policy editing instead of waiting on its interface discovery.
  await page.route("**/api/nodes/*/interfaces", (route) =>
    route.fulfill({ json: { nodeId: route.request().url().split("/").at(-2), interfaces: [] } }),
  );

  await authenticate(page);
  await page.locator("#peerSelect").selectOption({ index: 0 });
  const importPolicy = page.locator(".channel-policy-disclosure").first();
  await importPolicy.locator("summary").click();
  await importPolicy.locator("label").filter({ hasText: "自定义" }).click();
  await importPolicy.locator("label").filter({ hasText: "当前项编写" }).click();

  const source = "if net ~ [ 203.0.113.0/24 ] then accept;\nreject;";
  const editor = importPolicy.locator("textarea.policy-source-editor");
  await expect(editor).toBeVisible();
  await editor.fill(source);
  await page.getByRole("button", { name: "预检配置", exact: true }).click();
  await expect(page.locator("body")).toContainText("预检通过");

  expect(previewBody?.channels.ipv4.importPolicy).toMatchObject({
    mode: "custom",
    filterId: null,
    inlineFilterSource: source,
  });
  await expect(importPolicy.locator(".code-input-lines")).toHaveText("1\n2");
});
