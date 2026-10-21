import { expect, test } from '@playwright/test';

test('Static demo adds routes over HTTP, previews, applies, reopens, edits and deletes', async ({ page }, info) => {
 const protocol = `http_static_${info.project.name}_${Date.now()}`;
 const errors: string[] = [];
 page.on('pageerror', error => errors.push(error.message));
 page.on('dialog', dialog => dialog.accept());
 const read = async () => (await (await page.request.get('/api/dashboard')).json()).inventory;
 try {
  await page.goto('/'); await page.locator('#authPassword').fill('demo-admin-password'); await page.locator('#authSubmitButton').click();
  await expect(page.locator('#appMain')).toBeVisible();
  await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceStaticsTab').click();
  await page.locator('#resourceKeyword').fill(protocol);
  await page.getByRole('button', { name: '+ 添加 Static', exact: true }).click();
  const dialog = page.locator('#staticDialog');
  await page.locator('#staticLabel').fill(protocol); await page.locator('#staticName').fill(protocol);
  await page.locator('#addStaticRouteButton').click();
  const routes = page.getByTestId('static-direct-route'); const first = routes.nth(0), second = routes.nth(1);
  await expect(routes).toHaveCount(1);
  await first.getByLabel('目标网段', { exact: true }).fill('198.18.120.0/24');
  await first.getByLabel('下一跳地址', { exact: true }).fill('10.10.0.12');
  await page.locator('#addStaticRouteButton').click(); await expect(routes).toHaveCount(2);
  await second.getByLabel('目标网段', { exact: true }).fill('198.18.121.0/24');
  await second.getByLabel('转发方式', { exact: true }).selectOption('blackhole');
  const before = await read();
  await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过');
  expect((await read()).staticProtocols).toEqual(before.staticProtocols);
  await page.locator('#saveStaticButton').click(); await expect(dialog).not.toBeVisible();
  const saved = (await read()).staticProtocols.find((resource: any) => resource.name === protocol);
  expect(saved.routes.map((route: any) => route.prefix)).toEqual(['198.18.120.0/24', '198.18.121.0/24']);
  expect(new Set(saved.routes.map((route: any) => route.id)).size).toBe(2);
  await page.getByRole('button', { name: `编辑 Static ${protocol}`, exact: true }).click();
  await expect(first.getByLabel('下一跳地址', { exact: true })).toHaveValue('10.10.0.12');
  await second.locator('.static-route-summary').click();
  await expect(second.getByLabel('目标网段', { exact: true })).toHaveValue('198.18.121.0/24');
  await second.getByLabel('目标网段', { exact: true }).fill('198.18.122.0/24');
  await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过');
  await page.locator('#saveStaticButton').click(); await expect(dialog).not.toBeVisible();
  const updated = (await read()).staticProtocols.find((resource: any) => resource.name === protocol);
  expect(updated.routes.map((route: any) => route.prefix)).toEqual(['198.18.120.0/24', '198.18.122.0/24']);
  await page.getByRole('button', { name: `查看 Static ${protocol} 运行态`, exact: true }).click();
  const runtime = page.locator('#staticRuntimeDialog'); await expect(runtime).toContainText('198.18.122.0/24');
  await runtime.getByRole('button', { name: '编辑配置', exact: true }).click();
  await page.locator('#deleteStaticButton').click(); await expect(dialog).not.toBeVisible();
  expect((await read()).staticProtocols.some((resource: any) => resource.name === protocol)).toBe(false);
  expect(errors).toEqual([]);
 } finally {
  const inventory = await read();
  for (const resource of inventory.staticProtocols.filter((item: any) => item.name === protocol)) {
   const response = await page.request.delete(`/api/statics/${resource.id}`); expect(response.ok()).toBe(true);
  }
  await page.request.post('/api/auth/logout');
 }
});
