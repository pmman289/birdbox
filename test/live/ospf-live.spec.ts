import { expect, test } from '@playwright/test';

test('OSPF real HTTP topology, independent endpoints, draft reload, reviewed apply, runtime and cleanup', async ({ page }, info) => {
 const errors: string[] = [];
 page.on('pageerror', error => errors.push(error.message));
 page.on('dialog', dialog => dialog.accept());
 const name = `OSPF验收_${info.project.name}_${Date.now()}`;
 let domainId: string | undefined;
 await page.goto('/');
 await page.locator('#authPassword').fill('demo-admin-password');
 await page.locator('#authSubmitButton').click();
 await expect(page.locator('#appMain')).toBeVisible();
 const openWorkspace = async () => {
  await page.locator('#ospfWorkspaceTab').click();
  if (await page.locator('#ospfWarningDialog').isVisible()) await page.getByRole('button', { name: '我已了解风险，继续' }).click();
  await expect(page.getByRole('button', { name: '新建域', exact: true })).toBeEnabled();
 };
 const read = async () => (await page.request.get('/api/ospf')).json();
 const preflight = async () => {
  await page.getByRole('button', { name: '预检配置', exact: true }).click();
  await expect(page.locator('.ospf-preview-dialog')).toBeVisible();
  await expect(page.locator('.ospf-preview-diff-row')).toHaveCount(2);
  await page.getByRole('button', { name: '关闭 OSPF 配置预览', exact: true }).click();
 };
 const apply = async () => {
  await page.getByRole('button', { name: '保存并应用', exact: true }).click();
  const dialog = page.locator('.ospf-apply-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(dialog.locator('.status-success')).toHaveCount(2);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
 };
 try {
  await openWorkspace();
  await page.getByRole('button', { name: '新建域', exact: true }).click();
  await page.getByRole('textbox', { name: 'OSPF 域名称' }).fill(name);
  await page.getByRole('button', { name: '＋ 添加链路', exact: true }).click();
  await page.locator('.ospf-topology-node').filter({ hasText: 'Core Router A' }).click();
  await page.locator('.ospf-topology-node').filter({ hasText: 'Core Router B' }).click();
  const add = page.locator('.ospf-add-link');
  for (const endpoint of ['本端接口', '对端接口']) {
   const select = add.locator('.field').filter({ hasText: endpoint }).locator('select');
   await expect(select).toBeVisible(); await select.selectOption('eth1');
  }
  await add.getByRole('button', { name: '创建链路', exact: true }).click();
  const advanced = page.locator('.ospf-link-advanced');
  await advanced.locator(':scope > summary').click();
  await advanced.getByLabel('Priority', { exact: true }).fill('41');
  await page.getByRole('button', { name: '编辑对端参数', exact: true }).click();
  await advanced.getByLabel('Priority', { exact: true }).fill('52');
  for (const node of ['Core Router A', 'Core Router B']) {
   await page.locator('.ospf-topology-node').filter({ hasText: node }).click();
   await page.getByLabel('OSPFv3 · IPv6', { exact: true }).check();
  }
  const before = await read();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => (await read()).domains.some((d: any) => d.name === name)).toBe(true);
  let stored = await read();
  domainId = stored.domains.find((d: any) => d.name === name).id;
  expect(stored.inventory.ospfDomains).toEqual(before.inventory.ospfDomains);
  expect(stored.inventoryRevision).toBe(before.inventoryRevision);
  await page.reload(); await openWorkspace();
  await page.locator('.ospf-domain-picker select').selectOption(domainId!);
  await expect(page.getByRole('textbox', { name: 'OSPF 域名称' })).toHaveValue(name);
  await preflight();
  stored = await read(); expect(stored.inventory.ospfDomains).toEqual(before.inventory.ospfDomains);
  await apply();
  stored = await read();
  const applied = stored.inventory.ospfDomains.find((d: any) => d.id === domainId);
  expect(applied.nodeConfigs.every((c: any) => c.versions.includes('ospfv3'))).toBe(true);
  expect(applied.links[0].localOptions.priority).toBe(41);
  expect(applied.links[0].remoteOptions.priority).toBe(52);
  await page.locator('.ospf-topology-node').filter({ hasText: 'Core Router A' }).click();
  const cards = page.locator('.ospf-inspector-runtime-summary .runtime-summary-card');
  await expect(cards.nth(2)).toContainText('1'); await cards.nth(2).click();
  const runtime = page.locator('.ospf-runtime-dialog');
  await expect(runtime).toContainText('OSPFv2 协议 · 运行中');
  await expect(runtime).toContainText('OSPFv3 协议 · 运行中');
  await expect(runtime).toContainText('Area 0.0.0.0');
  await runtime.getByRole('button', { name: '关闭 OSPF 运行详情' }).click();
  await cards.nth(0).click(); await expect(runtime).toContainText('Full/PtP');
  await runtime.getByRole('button', { name: '关闭 OSPF 运行详情' }).click();
  await cards.nth(1).click(); await expect(runtime).toContainText('2001:db8:10::/48');
  await runtime.getByRole('button', { name: '关闭 OSPF 运行详情' }).click();
  for (const enabled of [false, true]) {
   await page.getByLabel('启用 OSPF', { exact: true }).setChecked(enabled);
   await preflight(); await apply();
   const current = (await read()).inventory.ospfDomains.find((d: any) => d.id === domainId);
   expect(current.nodeConfigs.find((c: any) => c.nodeId === 'core_a').enabled).toBe(enabled);
   const r = await (await page.request.get(`/api/ospf/${domainId}/runtime`)).json();
   expect(r.nodes.find((n: any) => n.nodeId === 'core_a').runtime.v2.protocol.state).toBe(enabled ? 'up' : 'not_configured');
   await page.locator('.ospf-topology-node').filter({ hasText: 'Core Router A' }).click();
  }
  await page.getByRole('button', { name: '删除域', exact: true }).click();
  await expect.poll(async () => (await read()).domains.some((d: any) => d.id === domainId)).toBe(false);
  expect(errors).toEqual([]);
 } finally {
  const leftover = domainId ?? (await read()).domains.find((d: any) => d.name === name)?.id;
  if (leftover) {
   const current = await read();
   if (current.domains.some((d: any) => d.id === leftover)) {
    const response = await page.request.delete(`/api/ospf/${leftover}`, { data: { inventoryRevision: current.inventoryRevision } });
    expect(response.ok()).toBe(true);
   }
  }
  await page.request.post('/api/auth/logout');
 }
});
