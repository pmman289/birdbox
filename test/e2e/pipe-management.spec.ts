import { expect, test, type Page } from "@playwright/test";
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });
import type { PipeProtocol } from "../../packages/contracts/src/inventory";
async function authenticate(page: Page) {
  await page.goto("/"); const title = page.locator("#authTitle"); await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  await page.locator("#authPassword").fill("playwright-admin-password");
  if (await title.textContent() === "设置管理密码") await page.locator("#authConfirmation").fill("playwright-admin-password");
  await page.locator("#authSubmitButton").click(); await expect(page.locator("#appMain")).toBeVisible();
}
async function fixture(page: Page) {
  let pipes: PipeProtocol[] = [], fail = false; const writes: Array<{ method: string; body: any }> = [];
  await page.route("**/api/dashboard**", async route => { const response = await route.fetch(); const data = await response.json(); data.inventory.pipeProtocols = pipes; data.pipeProtocols = pipes; await route.fulfill({ response, json: data }); });
  await page.route(/\/api\/pipes(?:[/?].*)?$/, async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname.endsWith("/tables")) return route.fulfill({ json: { tables: ["local", "edge"].flatMap(nodeId => [{ nodeId, name: "master4", family: "ipv4" }, { nodeId, name: "master6", family: "ipv6" }]) } });
    if (url.pathname.endsWith("/preview")) { const body = route.request().postDataJSON(); return route.fulfill({ json: { valid: true, resource: body, configs: [{ nodeId: "local", config: `protocol pipe ${body.name} { table ${body.table.name}; peer table ${body.peerTable.name}; }`, validation: { ok: true, stdout: "Syntax OK", stderr: "" } }] } }); }
    if (url.pathname.endsWith("/runtime")) return route.fulfill({ json: { resourceId: "saved_pipe", lastCheckedAt: new Date().toISOString(), nodes: [{ nodeId: "local", ok: true, state: "up", primary: { table: "master4", imported: 0, exported: 1 }, peer: { table: "peer4", imported: null, exported: null }, raw: "Pipe up" }, { nodeId: "edge", ok: false, state: "error", error: "Agent offline", primary: { imported: null, exported: null }, peer: {} }] } });
    if (url.pathname.endsWith("/routes")) return route.fulfill({ json: { resourceId: "saved_pipe", nodeId: url.searchParams.get("nodeId"), side: url.searchParams.get("side"), family: "ipv4", table: url.searchParams.get("side") === "peer" ? "peer4" : "master4", routes: [{ prefix: "198.51.100.0/24", summary: "blackhole [original_static 00:00] * (200)", details: "Type: static univ\nBGP.local_pref: 177" }], truncated: true, limit: 200 } });
    if (method === "DELETE") { pipes = []; writes.push({ method, body: null }); return route.fulfill({ json: { inventory: { pipeProtocols: [] } } }); }
    const body = route.request().postDataJSON(); writes.push({ method, body });
    if (fail) return route.fulfill({ status: 422, json: { error: "节点预检失败，未应用" } });
    pipes = [{ ...body, id: "saved_pipe" }]; return route.fulfill({ json: { resource: pipes[0] } });
  });
  await authenticate(page); await page.locator("#resourceWorkspaceTab").click(); await page.locator("#resourcePipesTab").click();
  return { writes, setFail(value: boolean) { fail = value; } };
}
test("Pipe CRUD, independent direction policies, preflight failure retains draft, runtime routes", async ({ page }) => {
  const h = await fixture(page);
  await page.getByRole("button", { name: "+ 添加 Pipe", exact: true }).click(); const dialog = page.locator("#pipeDialog");
  await expect(dialog).toBeVisible(); await expect(page.locator("#pipeTable")).toHaveValue("master4"); await expect(dialog.locator('input[value="local"]')).toBeChecked();
  await page.locator("#pipeLabel").fill("测试传递"); await page.locator("#pipePeerTable").fill("peer4");
  await expect(dialog.locator("details[open]")).toHaveCount(0);
  const imports = dialog.locator(".pipe-policy").nth(1); await imports.locator("summary").click();
  await imports.locator(".policy-form-fields select").selectOption("all");
  const exports = dialog.locator(".pipe-policy").nth(0); await exports.locator("summary").click(); await exports.locator(".policy-form-fields select").selectOption("none");
  await dialog.getByRole("button", { name: "预检配置", exact: true }).click(); await expect(page.locator("#pipePreview")).toContainText("预检通过");
  await page.locator("#pipeName").fill("test_pipe"); await expect(page.locator("#pipePreview")).toHaveCount(0);
  h.setFail(true); await dialog.getByRole("button", { name: "保存并应用", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("节点预检失败"); await expect(page.locator("#pipeLabel")).toHaveValue("测试传递");
  h.setFail(false); await dialog.getByRole("button", { name: "保存并应用", exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(h.writes.at(-1)?.body.exportPolicy.formAction).toBe("none"); expect(h.writes.at(-1)?.body.importPolicy.formAction).toBe("all");
  await page.getByRole("button", { name: "查看 Pipe test_pipe 运行态" }).click();
  const runtime = page.locator("#pipeRuntimeDialog"); await expect(runtime).toContainText("运行中"); await expect(runtime).toContainText("Agent offline");
  await expect(runtime).toContainText("original_static"); await runtime.getByLabel("路由表侧").selectOption("peer"); await expect(runtime).toContainText("peer4 · 1 条（已截断");
  await runtime.getByText("198.51.100.0/24", { exact: true }).click(); await expect(runtime).toContainText("BGP.local_pref: 177");
  await runtime.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "编辑 Pipe test_pipe", exact: true }).click(); await expect(page.locator("#pipeLabel")).toHaveValue("测试传递");
  await page.locator("#pipeFamily").selectOption("ipv6"); await expect(page.locator("#pipeTable")).toHaveValue("master6");
  page.once("dialog", d => d.accept()); await dialog.getByRole("button", { name: "删除 Pipe", exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(page.locator("#managementPipeRows")).toContainText("尚无 Pipe");
  // New after edit must not retain the old editing ID in preview payload.
  await page.getByRole("button", { name: "+ 添加 Pipe", exact: true }).click(); await page.locator("#pipeLabel").fill("新资源"); await page.locator("#pipePeerTable").fill("new_peer");
  const request = page.waitForRequest(r => r.url().endsWith("/api/pipes/preview")); await dialog.getByRole("button", { name: "预检配置", exact: true }).click(); expect((await request).postDataJSON().id).toBeUndefined();
});
for (const width of [375, 390, 430]) test(`Pipe editor and expanded policies fit ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await fixture(page); await page.getByRole("button", { name: "+ 添加 Pipe", exact: true }).click();
  const dialog = page.locator("#pipeDialog"); await dialog.locator(".pipe-policy summary").first().click();
  await expect(dialog).toBeVisible();
  const overflow = await dialog.evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth })); expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
  await expect(dialog.getByRole("button", { name: "保存并应用" })).toBeInViewport();
});
test("Pipe preview responses cannot overwrite changed drafts", async ({ page }) => {
  await fixture(page); let release!: () => void; const barrier = new Promise<void>(resolve => release = resolve);
  await page.route("**/api/pipes/preview", async route => { await barrier; await route.fulfill({ json: { valid: true, configs: [{ nodeId: "local", config: "STALE_CONFIG", validation: { ok: true } }] } }); });
  try {
    await page.getByRole("button", { name: "+ 添加 Pipe", exact: true }).click(); await page.locator("#pipeLabel").fill("预览草稿"); await page.locator("#pipePeerTable").fill("peer4");
    const request = page.waitForRequest(r => r.url().endsWith("/api/pipes/preview")); await page.locator("#pipeDialog").getByRole("button", { name: "预检配置", exact: true }).click(); await request;
    await page.locator("#pipePeerTable").fill("changed_peer"); release(); await expect(page.locator("#pipePreview")).toHaveCount(0); await expect(page.locator("#pipePeerTable")).toHaveValue("changed_peer");
  } finally { release(); await page.unrouteAll({ behavior: "ignoreErrors" }); }
});

test("Pipe route errors and stale data stay isolated when switching nodes and tables", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "+ 添加 Pipe", exact: true }).click();
  await page.locator("#pipeLabel").fill("路由隔离"); await page.locator("#pipePeerTable").fill("peer4");
  await page.locator("#pipeScope").selectOption({ label: "所有节点（含后续新增）" });
  await page.locator("#pipeDialog").getByRole("button", { name: "保存并应用", exact: true }).click(); await expect(page.locator("#pipeDialog")).not.toBeVisible();
  let release!: () => void; const barrier = new Promise<void>(resolve => release = resolve);
  await page.route("**/api/pipes/*/routes?**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("side") === "primary" && url.searchParams.get("nodeId") === "local") {
      await barrier; await route.fulfill({ json: { table: "master4", routes: [{ prefix: "192.0.2.0/24", summary: "STALE_ROUTE", details: "" }], truncated: false } });
    } else if (url.searchParams.get("nodeId") === "edge") {
      await route.fulfill({ status: 502, json: { error: "该节点暂时离线" } });
    } else { await route.fulfill({ json: { table: "peer4", routes: [{ prefix: "198.51.100.0/24", summary: "CURRENT_ROUTE", details: "" }], truncated: false } }); }
  });
  try {
    const request = page.waitForRequest(r => r.url().includes("/routes?"));
    await page.getByRole("button", { name: "查看 Pipe birdbox_pipe 运行态" }).click(); await request;
    const runtime = page.locator("#pipeRuntimeDialog");
    await runtime.getByLabel("路由表侧").selectOption("peer"); await expect(runtime).toContainText("CURRENT_ROUTE"); release();
    await expect(runtime).not.toContainText("STALE_ROUTE");
    await runtime.getByLabel("路由节点").selectOption("edge"); await expect(runtime).toContainText("该节点暂时离线"); await expect(runtime).not.toContainText("CURRENT_ROUTE");
    await runtime.getByLabel("路由节点").selectOption("local"); await expect(runtime).toContainText("CURRENT_ROUTE"); await expect(runtime).not.toContainText("该节点暂时离线");
  } finally { release(); await page.unrouteAll({ behavior: "ignoreErrors" }); }
});
