import { expect, test, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });
async function fixture(page: Page, withDefines = false) {
 let statics: any[] = [], fail = false; const writes: any[] = [];
 await page.route('**/api/dashboard**', async route => { const response = await route.fetch(); const data = await response.json(); data.inventory.staticProtocols = statics; data.staticProtocols = statics;
  if (withDefines) data.inventory.defines.push({ id: 'unified_prefixes', name: 'unified_prefixes', label: '业务网段', type: 'cidr4', enabled: true, nodeIds: ['local'], entries: ['203.0.113.0/24', '203.0.114.0/24'], entrySource: { kind: 'manual' } });
  await route.fulfill({ response, json: data }); });
 await page.route(/\/api\/statics(?:[/?].*)?$/, async route => {
  const url = new URL(route.request().url()), method = route.request().method();
  if (url.pathname.endsWith('/preview')) { const body = route.request().postDataJSON(); return route.fulfill({ json: { valid: true, previewId: 'preview', inventoryRevision: 1, resource: { ...body, id: body.id ?? 'saved_static' }, configs: [{ nodeId: 'local', config: `protocol static ${body.name} { ipv4; }`, diff: `+ route ${body.routes[0]?.prefix} blackhole;`, validation: { ok: true, stdout: 'Syntax OK', stderr: '' } }] } }); }
  if (url.pathname.endsWith('/runtime')) return route.fulfill({ json: { state: 'up', table: 'business4', imported: 1, lastCheckedAt: new Date().toISOString(), raw: 'Static up' } });
  if (url.pathname.endsWith('/routes')) return route.fulfill({ json: { table: 'business4', routes: [{ prefix: '198.51.100.0/24', summary: 'blackhole [test_static] * (200)', details: 'Type: static univ' }], truncated: false } });
  if (method === 'DELETE') { statics = []; return route.fulfill({ json: {} }); }
  const body = route.request().postDataJSON(); writes.push(body);
  if (fail) return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化，请重新预检' } });
  statics = [{ ...body, id: 'saved_static' }]; return route.fulfill({ json: { resource: statics[0], deployment: { applied: true, nodeIds: ['local'] } } });
 });
 await page.goto('/'); const title = page.locator('#authTitle'); await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/); await page.locator('#authPassword').fill('playwright-admin-password'); if (await title.textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceStaticsTab').click();
 return { writes, fail(value: boolean) { fail = value; } };
}
async function create(page: Page) {
 await page.getByRole('button', { name: '+ 添加 Static', exact: true }).click();
 await page.locator('#staticLabel').fill('业务静态路由'); await page.locator('#staticName').fill('test_static');
 await page.locator('#addStaticRouteButton').click(); const card = page.getByTestId('static-direct-route').first();
 await card.getByLabel('目标网段', { exact: true }).fill('198.51.100.0/24'); await card.getByLabel('下一跳地址', { exact: true }).fill('192.0.2.1');
 return card;
}
test('Static direct routes, independent ECMP next hops, preflight/apply confirmation, conflict recovery, edit/runtime/delete', async ({ page }) => {
 const h = await fixture(page); const card = await create(page); const dialog = page.locator('#staticDialog');
 await expect(card.locator('.static-next-hop details[open], .static-route-attributes[open]')).toHaveCount(0);
 await card.getByRole('button', { name: '添加下一跳（ECMP）' }).click(); await card.getByLabel('下一跳地址', { exact: true }).nth(1).fill('192.0.2.2');
 await card.locator('.static-next-hop summary').first().click(); await card.getByLabel('下一跳权重').first().fill('2');
 await page.locator('#staticTableSource').selectOption('managed'); await page.locator('#staticTable').fill('business4');
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过'); expect(h.writes).toHaveLength(0);
 const afterPreview = await dialog.evaluate(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, header: e.querySelector('.dialog-head')!.getBoundingClientRect().top, footer: e.querySelector('.dialog-actions')!.getBoundingClientRect().bottom })); expect(afterPreview.header).toBeGreaterThanOrEqual(afterPreview.top); expect(Math.abs(afterPreview.bottom - afterPreview.footer)).toBeLessThan(3);
 h.fail(true); await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticLabel')).toHaveValue('业务静态路由'); await expect(page.locator('#staticServerPreview')).toHaveCount(0);
 h.fail(false); await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toBeVisible(); await page.locator('#saveStaticButton').click(); await expect(dialog).not.toBeVisible();
 expect(h.writes.at(-1).routes[0].nextHops.map((hop: any) => hop.address)).toEqual(['192.0.2.1', '192.0.2.2']); expect(h.writes.at(-1).routes[0].nextHops[0].weight).toBe(2);
 await page.getByRole('button', { name: '查看 Static test_static 运行态', exact: true }).click(); const runtime = page.locator('#staticRuntimeDialog'); await expect(runtime).toContainText('运行中'); await expect(runtime).toContainText('198.51.100.0/24'); await runtime.getByRole('button', { name: '编辑配置' }).click(); await expect(dialog).toBeVisible();
 await expect(dialog.getByLabel('下一跳地址', { exact: true }).first()).toBeVisible();
 await expect(dialog.getByLabel('下一跳地址', { exact: true }).nth(1)).toHaveValue('192.0.2.2'); page.once('dialog', d => d.accept()); await page.locator('#deleteStaticButton').click(); await expect(dialog).not.toBeVisible();
 await expect(page.locator('#managementStaticRows')).toContainText('尚无 Static');
});
test('Static adds independent routes without secure-context randomUUID and preserves them after save/reopen', async ({ page }) => {
 await page.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }); });
 const h = await fixture(page); const first = await create(page);
 expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
 await page.locator('#addStaticRouteButton').click(); const second = page.getByTestId('static-direct-route').nth(1);
 await expect(page.getByTestId('static-direct-route')).toHaveCount(2);
 await second.getByLabel('目标网段', { exact: true }).fill('203.0.113.0/24');
 await second.getByLabel('转发方式', { exact: true }).selectOption('blackhole');
 const ids = await page.getByTestId('static-direct-route').evaluateAll(cards => cards.map(card => card.getAttribute('data-static-route-id')));
 expect(new Set(ids).size).toBe(2); expect(ids.every(id => /^route_[0-9a-f]{32}$/.test(id ?? ''))).toBe(true);
 await first.locator('.static-route-summary').click(); await expect(first.getByLabel('下一跳地址', { exact: true })).toHaveValue('192.0.2.1');
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过'); expect(h.writes).toHaveLength(0);
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticDialog')).not.toBeVisible();
 expect(h.writes.at(-1).routes.map((r: any) => r.id)).toEqual(ids);
 await page.getByRole('button', { name: '编辑 Static test_static', exact: true }).click();
 await expect(first.getByLabel('目标网段', { exact: true })).toHaveValue('198.51.100.0/24');
 await second.locator('.static-route-summary').click(); await expect(second.getByLabel('目标网段', { exact: true })).toHaveValue('203.0.113.0/24');
 await expect(second.getByLabel('转发方式', { exact: true })).toHaveValue('blackhole');
 await expect(page.getByTestId('static-direct-route')).toHaveCount(2);
});
for (const width of [375, 390, 430]) test(`Static advanced form and sticky actions fit ${width}px`, async ({ page }) => {
 await page.setViewportSize({ width, height: 844 }); await fixture(page); const card = await create(page); await card.locator('.static-next-hop summary').first().click(); await card.getByLabel('出口接口', { exact: true }).fill('eth0');
 const dialog = page.locator('#staticDialog'); const bounds = await dialog.evaluate(e => ({ width: e.clientWidth, scroll: e.scrollWidth })); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1); await expect(page.locator('#saveStaticButton')).toBeInViewport();
 const layout = await dialog.evaluate(e => ({ bottom: e.getBoundingClientRect().bottom, actions: e.querySelector('.dialog-actions')!.getBoundingClientRect().bottom, content: e.querySelector('.static-content')!.clientHeight })); expect(Math.abs(layout.bottom - layout.actions)).toBeLessThan(3); expect(layout.content).toBeGreaterThan(160);
 page.once('dialog', d => d.dismiss()); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toBeVisible(); await expect(page.locator('#staticLabel')).toHaveValue('业务静态路由');
 page.once('dialog', d => d.accept()); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).not.toBeVisible();
});
test('Static ignores a preview response for an older draft', async ({ page }) => {
 await fixture(page); await create(page); let release!: () => void; const barrier = new Promise<void>(r => release = r);
 await page.route('**/api/statics/preview', async route => { await barrier; await route.fulfill({ json: { valid: true, configs: [{ config: 'STALE' }] } }); });
 try { const request = page.waitForRequest(r => r.url().endsWith('/api/statics/preview')); await page.locator('#staticDialog').getByRole('button', { name: '预检并查看变更', exact: true }).click(); await request; await page.locator('#staticLabel').fill('新草稿'); release(); await expect(page.locator('#staticServerPreview')).toHaveCount(0); await expect(page.locator('#staticLabel')).toHaveValue('新草稿'); }
 finally { release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});

test('Static route summaries preserve drafts and reveal invalid collapsed routes', async ({ page }) => {
 const h = await fixture(page); const first = await create(page);
 await page.locator('#addStaticRouteButton').click(); const second = page.getByTestId('static-direct-route').nth(1);
 await expect(first.getByLabel('目标网段', { exact: true })).not.toBeVisible();
 await second.getByLabel('下一跳地址', { exact: true }).fill('192.0.2.2');
 await first.locator('.static-route-summary').click(); await expect(first.getByLabel('目标网段', { exact: true })).toHaveValue('198.51.100.0/24');
 await page.locator('#saveStaticButton').click();
 await expect(second.getByLabel('目标网段', { exact: true })).toBeVisible();
 await second.getByLabel('目标网段', { exact: true }).fill('203.0.113.0/24');
 await second.locator('.static-next-hop summary').click();
 const checkbox = second.getByRole('checkbox', { name: '使用 BFD 检测下一跳' });
 const box = await checkbox.boundingBox(); expect(box!.width).toBeLessThanOrEqual(20); expect(box!.height).toBeLessThanOrEqual(20);
 await checkbox.check(); await expect(checkbox).toBeChecked();
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过');
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticDialog')).not.toBeVisible();
 expect(h.writes.at(-1).routes.map((r: any) => r.prefix)).toEqual(['198.51.100.0/24', '203.0.113.0/24']);
 await page.getByRole('button', { name: '查看 Static test_static 运行态', exact: true }).click();
 const runtime = page.locator('#staticRuntimeDialog'); await expect(runtime.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
 await runtime.getByRole('button', { name: '查询路由', exact: true }).click(); await expect(runtime).toContainText('198.51.100.0/24');
});

test('Define and manual routes share forwarding controls, preserve source drafts, and save/reopen independent settings', async ({ page }) => {
 const h = await fixture(page, true); await create(page);
 await page.locator('#staticDefineId').selectOption('unified_prefixes');
 const linked = page.getByTestId('static-define-route'); const first = linked.nth(0), second = linked.nth(1);
 await expect(linked).toHaveCount(2); await expect(first.getByLabel('目标网段', { exact: true })).toHaveAttribute('readonly', '');
 await first.getByLabel('转发方式', { exact: true }).selectOption('via');
 await first.getByLabel('下一跳地址', { exact: true }).fill('192.0.2.2');
 await first.getByRole('button', { name: '添加下一跳（ECMP）' }).click(); await first.getByLabel('下一跳地址', { exact: true }).nth(1).fill('192.0.2.3');
 await first.locator('.static-next-hop summary').first().click(); await first.getByLabel('下一跳权重').first().fill('2'); await first.getByRole('checkbox', { name: '使用 BFD 检测下一跳' }).first().check();
 await first.locator('.static-route-attributes > summary').click(); await first.getByRole('button', { name: '设置属性', exact: true }).click();
 await first.locator('textarea').fill('ospf_metric1 = 25;');
 await page.locator('#staticDefineId').selectOption({ label: '不关联，仅直接添加路由' });
 await expect(linked).toHaveCount(0); await expect(page.getByTestId('static-direct-route').getByLabel('下一跳地址', { exact: true })).toHaveValue('192.0.2.1');
 await page.locator('#staticDefineId').selectOption('unified_prefixes'); await expect(first.getByLabel('下一跳地址', { exact: true }).nth(1)).toHaveValue('192.0.2.3');
 await second.locator('.static-route-summary').click(); await second.getByRole('button', { name: '停用此路由', exact: true }).click();
 await first.locator('.static-route-summary').click(); await page.locator('.static-batch-actions > summary').click();
 page.once('dialog', d => d.accept()); await page.locator('#applyStaticBulkActionButton').click();
 await second.locator('.static-route-summary').click(); await expect(second.getByRole('button', { name: '启用此路由', exact: true })).toBeVisible();
 await second.getByLabel('转发方式', { exact: true }).selectOption('recursive'); await second.getByLabel('递归下一跳地址').fill('192.0.2.9');
 await first.locator('.static-route-summary').click(); await first.getByLabel('下一跳地址', { exact: true }).first().fill('192.0.2.8');
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过'); expect(h.writes).toHaveLength(0);
 await first.getByLabel('下一跳地址', { exact: true }).first().fill('192.0.2.10'); await expect(page.locator('#staticServerPreview')).toHaveCount(0);
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过'); await page.locator('#saveStaticButton').click();
 await expect(page.locator('#staticDialog')).not.toBeVisible(); const saved = h.writes.at(-1);
 expect(saved.routes.map((r: any) => r.prefix)).toEqual(['198.51.100.0/24']);
 expect(saved.routeActions['203.0.113.0/24'].nextHops.map((n: any) => n.address)).toEqual(['192.0.2.10', '192.0.2.3']);
 expect(saved.routeActions['203.0.113.0/24'].nextHops[0].bfd).toBe(true);
 expect(saved.routeActions['203.0.114.0/24']).toMatchObject({ type: 'recursive', recursiveVia: '192.0.2.9', enabled: false });
 expect(saved.action.nextHops[0].address).toBe('192.0.2.2'); expect(saved.action.enabled).toBe(true);
 expect(saved.routes[0].nextHops[0].address).toBe('192.0.2.2'); expect(saved.routeFilters['203.0.113.0/24'].custom).toBe('ospf_metric1 = 25;');
 await page.getByRole('button', { name: '查看 Static test_static 运行态', exact: true }).click(); await page.locator('#staticRuntimeDialog').getByRole('button', { name: '编辑配置', exact: true }).click();
 await expect(first.getByLabel('下一跳地址', { exact: true }).first()).toHaveValue('192.0.2.10');
 await second.locator('.static-route-summary').click(); await expect(second.getByLabel('递归下一跳地址')).toHaveValue('192.0.2.9'); await expect(second.getByRole('button', { name: '启用此路由', exact: true })).toBeVisible();
});

for (const width of [375, 390, 430]) test(`Unified route sources and ECMP fit ${width}px`, async ({ page }) => {
 await page.setViewportSize({ width, height: 844 }); await fixture(page, true); await create(page); await page.locator('#staticDefineId').selectOption('unified_prefixes');
 const first = page.getByTestId('static-define-route').first(); await first.getByLabel('转发方式', { exact: true }).selectOption('via'); await first.getByLabel('下一跳地址', { exact: true }).fill('192.0.2.2');
 await first.getByRole('button', { name: '添加下一跳（ECMP）' }).click(); await first.getByLabel('下一跳地址', { exact: true }).nth(1).fill('192.0.2.3');
 await first.locator('.static-next-hop summary').first().click(); await first.locator('.static-route-attributes > summary').click(); await first.getByRole('button', { name: '添加 Community 操作', exact: true }).click();
 const overflow = await page.locator('#staticDialog').evaluate(el => [...el.querySelectorAll<HTMLElement>('.static-route-card, .static-route-body, .static-content, .static-filter-operation-row')].filter(e => e.getBoundingClientRect().height > 0).map(e => ({ width: e.clientWidth, scroll: e.scrollWidth })));
 expect(overflow.every(e => e.scroll <= e.width + 1)).toBe(true); await expect(page.locator('#saveStaticButton')).toBeInViewport();
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过');
});
