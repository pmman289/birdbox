import { test, expect } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.request.post('/api/auth/logout'); });
for (const kind of ['directs', 'kernels'] as const) {
 test(`${kind} real HTTP create → preflight → confirm → reopen/edit → disabled runtime → enable → routes → delete`, async ({ page }, info) => {
  const title = kind === 'directs' ? 'Direct' : 'Kernel', collection = kind === 'directs' ? 'directProtocols' : 'kernelProtocols';
  const name = `live_${kind}_${info.project.name}_${Date.now()}`, errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto('/'); await page.locator('#authPassword').fill('demo-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
  await page.locator('#resourceWorkspaceTab').click(); await page.locator(`#resource${title}sTab`).click(); await page.getByRole('button', { name: `+ 添加 ${title}`, exact: true }).click();
  await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled(); await page.locator('#systemProtocolLabel').fill(`${title} 真实 HTTP 验收`); await page.locator('#systemProtocolName').fill(name);
  if (kind === 'directs') await page.getByLabel('手动填写接口或匹配规则').fill('eth1');
  else {
   for (const family of ['ipv4', 'ipv6']) { await page.getByLabel(`${family} BIRD 表来源`, { exact: true }).selectOption('managed'); await page.locator(`#kernelBirdTable-${family}`).fill(`${name}_${family}`); }
   await page.getByText('高级内核设置', { exact: false }).click(); await page.getByLabel('Linux 路由表', { exact: true }).fill(info.project.name === 'desktop' ? '245' : '246');
  }
  const before = (await (await page.request.get('/api/dashboard')).json()).inventory;
  await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#systemProtocolPreview')).toContainText('预检通过');
  expect((await (await page.request.get('/api/dashboard')).json()).inventory[collection]).toEqual(before[collection]);
  await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible();
  const saved = (await (await page.request.get('/api/dashboard')).json()).inventory[collection].find((r: any) => r.name === name); expect(saved).toBeTruthy();
  await page.getByRole('button', { name: `编辑 ${title} ${name}`, exact: true }).click(); await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled();
  if (kind === 'kernels') await expect(page.locator('#kernelBirdTable-ipv6')).toHaveValue(`${name}_ipv6`);
  await page.locator('#systemProtocolLabel').fill('维护停用验收'); await page.locator('label[for=systemProtocolEnabled]').click(); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#systemProtocolPreview')).toContainText('预检通过'); await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible();
  await page.getByRole('button', { name: `查看 ${title} ${name} 运行态`, exact: true }).click(); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText('配置已停用'); await page.getByRole('button', { name: '编辑配置', exact: true }).click();
  await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled(); await page.locator('label[for=systemProtocolEnabled]').click(); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#systemProtocolPreview')).toContainText('预检通过'); await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible();
  await page.getByRole('button', { name: `查看 ${title} ${name} 运行态`, exact: true }).click(); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText('运行中'); await page.getByLabel('协议路由地址族').selectOption('ipv6'); await page.getByRole('button', { name: '查询路由', exact: true }).click(); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText(kind === 'directs' ? 'master6' : `${name}_ipv6`);
  await page.getByRole('button', { name: '编辑配置', exact: true }).click(); await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled(); await page.getByRole('button', { name: '删除资源', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible();
  expect((await (await page.request.get('/api/dashboard')).json()).inventory[collection].some((r: any) => r.id === saved.id)).toBe(false); expect(errors).toEqual([]);
 });
}
