import { expect, test, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });

async function fixture(page: Page, staticCount = 47) {
 const statics = Array.from({ length: staticCount }, (_, offset) => {
  const i = offset + 1, family = i % 2 ? 'ipv4' : 'ipv6';
  return { id: `list_static_${i}`, nodeId: i <= 30 ? 'local' : 'edge', name: `list_static_${i}`, label: `业务路由 ${String(i).padStart(2, '0')}`, family, defineId: null, action: null, routeActions: {}, routeFilters: {}, import: 'all', export: 'none', raw: '', enabled: i % 3 !== 0, importPolicy: { mode: 'form', formAction: 'all', steps: [], filterId: null }, table: { name: family === 'ipv4' ? 'master4' : 'master6', source: 'existing' }, routes: [{ id: `r${i}`, prefix: family === 'ipv4' ? `198.18.${i}.0/24` : `2001:db8:${i}::/48`, type: 'blackhole', nextHops: [], recursiveVia: null, enabled: true, filter: { operations: [], custom: '' } }] };
 });
 const defines = Array.from({ length: 25 }, (_, offset) => {
  const i = offset + 1; return { id: `list_define_${i}`, name: `LIST_PREFIX_${i}`, label: `前缀 ${String(i).padStart(2, '0')}`, nodeIds: i % 3 === 0 ? null : ['local'], type: 'cidr4', enabled: true, entries: [`203.0.${i}.0/24`], entrySource: { kind: 'manual' }, sync: { status: 'never' } };
 });
 const moves: any[] = [], writes: any[] = [], errors: string[] = [];
 let snapshot: Promise<any> | null = null;
 page.on('pageerror', e => errors.push(e.message));
 await page.route('**/api/nodes/*/interfaces', route => route.fulfill({ json: { interfaces: [] } }));
 await page.route('**/api/dashboard**', async route => {
  snapshot ??= route.fetch().then(response => response.json());
  const data = structuredClone(await snapshot);
  const agents = Array.from({ length: 25 }, (_, i) => ({ ...data.inventory.nodes[0], id: `list_agent_${i + 1}`, name: `Agent ${String(i + 1).padStart(2, '0')}`, transport: 'agent', routerId: `192.0.2.${i + 40}` }));
  data.inventory.nodes.push(...agents); data.inventory.staticProtocols = statics; data.staticProtocols = statics; data.inventory.defines = defines;
  data.health.nodeStatuses = [...(data.health.nodeStatuses ?? []), ...agents.filter((_, i) => i % 3 !== 0).map((node, i) => ({ nodeId: node.id, reachable: i % 2 === 0, bird2: true, status: 'ready' }))];
  await route.fulfill({ json: data });
 });
 await page.route(/\/api\/defines\/[^/]+\/move$/, async route => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2), body = route.request().postDataJSON(); moves.push({ id, ...body });
  const index = defines.findIndex(d => d.id === id), target = index + (body.direction === 'down' ? 1 : -1); [defines[index], defines[target]] = [defines[target]!, defines[index]!];
  await route.fulfill({ json: {} });
 });
 await page.route(/\/api\/statics(?:[/?].*)?$/, async route => {
  const url = new URL(route.request().url()), method = route.request().method();
  if (url.pathname.endsWith('/preview')) { const body = route.request().postDataJSON(); return route.fulfill({ json: { valid: true, previewId: 'list-preview', inventoryRevision: 1, resource: { ...body, id: body.id ?? 'new_static' }, configs: [{ nodeId: 'local', config: `protocol static ${body.name} { ipv4; }`, diff: '+ route', validation: { ok: true, stdout: 'Syntax OK', stderr: '' } }] } }); }
  const id = url.pathname.split('/').at(-1);
  if (method === 'DELETE') { statics.splice(statics.findIndex(s => s.id === id), 1); return route.fulfill({ json: {} }); }
  const body = route.request().postDataJSON(); writes.push(body);
  if (method === 'PUT') { const index = statics.findIndex(s => s.id === id); statics[index] = { ...statics[index], ...body }; }
  else statics.push({ ...body, id: 'new_static' });
  await route.fulfill({ json: { resource: method === 'PUT' ? statics.find(s => s.id === id) : statics.at(-1), deployment: { applied: true, nodeIds: ['local'] } } });
 });
 await page.goto('/'); const title = page.locator('#authTitle'); await expect(title).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
 await page.locator('#authPassword').fill('playwright-admin-password'); if (await title.textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible(); await page.locator('#resourceWorkspaceTab').click();
 return { statics, defines, moves, writes, errors };
}

test('resource list combines filters, pages, sort, reset, refresh and independent tab queries', async ({ page }) => {
 const h = await fixture(page); await page.locator('#resourceStaticsTab').click(); const rows = page.locator('#managementStaticRows > tr');
 await expect(rows).toHaveCount(20); await expect(page.locator('.resource-page-summary')).toContainText('共 47 项');
 await page.locator('#resourcePageSize').selectOption('10'); await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(rows.first()).toHaveAttribute('data-resource-id', 'list_static_11');
 await page.locator('#resourceDefinesTab').click(); await page.locator('#resourcePageSize').selectOption('10'); await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.locator('#managementDefineRows > tr').first().locator('td').nth(3)).toHaveText('11');
 await page.locator('#resourceStaticsTab').click(); await expect(page.locator('#resourcePageSize')).toHaveValue('10'); await expect(rows.first()).toHaveAttribute('data-resource-id', 'list_static_11');
 await page.locator('#resourceStatusFilter').selectOption('disabled'); await page.locator('#resourceFamilyFilter').selectOption('ipv6'); await page.locator('#resourceNodeFilter').selectOption('edge');
 await expect(rows).toHaveCount(2); await expect(page.getByRole('button', { name: '第 1 页', exact: true })).toHaveAttribute('aria-current', 'page');
 await page.locator('#resourceKeyword').fill('198.18.42'); await expect(page.getByTestId('resource-list-empty')).toContainText('未找到匹配'); // IPv6 row cannot match an IPv4 prefix.
 await page.locator('#resourceKeyword').fill('LIST_STATIC_42'); await expect(rows).toHaveCount(1); await expect(rows).toContainText('业务路由 42');
 await page.getByRole('button', { name: '刷新列表', exact: true }).click(); await expect(page.locator('#resourceStatusFilter')).toHaveValue('disabled'); await expect(rows).toContainText('业务路由 42');
 await page.locator('#resourceKeyword').fill('不存在'); await page.getByRole('button', { name: '清除全部筛选', exact: true }).click(); await expect(rows).toHaveCount(10);
 await page.locator('#resourceSort').selectOption('name-desc'); await expect(rows.first()).toHaveAttribute('data-resource-id', 'list_static_47');
 await page.locator('#resourceDefinesTab').click(); await expect(page.locator('#resourcePageSize')).toHaveValue('10'); await expect(page.getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page');
 expect(h.errors).toEqual([]); expect(h.writes).toHaveLength(0);
});

test('last-page edit/delete clamps pagination and a newly created resource is revealed on its page', async ({ page }) => {
 const h = await fixture(page, 21); await page.locator('#resourceStaticsTab').click(); await page.getByRole('button', { name: '下一页', exact: true }).click();
 await page.getByRole('button', { name: '编辑 Static list_static_21', exact: true }).click(); await page.locator('#staticLabel').fill('已编辑的最后一项'); await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过'); await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticDialog')).not.toBeVisible();
 await expect(page.locator('#managementStaticRows > tr')).toHaveCount(1); await expect(page.locator('#managementStaticRows')).toContainText('已编辑的最后一项');
 await page.getByRole('button', { name: '编辑 Static list_static_21', exact: true }).click(); page.once('dialog', d => d.accept()); await page.locator('#deleteStaticButton').click(); await expect(page.locator('#staticDialog')).not.toBeVisible();
 await expect(page.locator('#managementStaticRows > tr')).toHaveCount(20); await expect(page.getByRole('button', { name: '第 1 页', exact: true })).toHaveAttribute('aria-current', 'page');
 await page.getByRole('button', { name: '+ 添加 Static', exact: true }).click(); await page.locator('#staticLabel').fill('新增分页资源'); await page.locator('#staticName').fill('new_list_static'); await page.locator('#addStaticRouteButton').click(); const card = page.getByTestId('static-direct-route'); await card.getByLabel('目标网段', { exact: true }).fill('203.0.113.0/24'); await card.getByLabel('转发方式', { exact: true }).selectOption('blackhole');
 await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticServerPreview')).toContainText('预检通过'); await page.locator('#saveStaticButton').click(); await expect(page.locator('#staticDialog')).not.toBeVisible();
 await expect(page.locator('#managementStaticRows')).toContainText('新增分页资源'); await expect(page.getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page'); expect(h.errors).toEqual([]);
});

test('declaration positions and moves stay global across pages and are protected in filtered views', async ({ page }) => {
 const h = await fixture(page); await page.locator('#resourceDefinesTab').click(); await page.locator('#resourcePageSize').selectOption('10'); await page.getByRole('button', { name: '下一页', exact: true }).click();
 const first = page.locator('#managementDefineRows > tr').first(); await expect(first.locator('td').nth(3)).toHaveText('11'); await expect(first.getByRole('button', { name: '上移 Define LIST_PREFIX_11', exact: true })).toBeEnabled();
 await first.getByRole('button', { name: '上移 Define LIST_PREFIX_11', exact: true }).click(); await expect(page.locator('#managementDefineRows > tr').first()).toHaveAttribute('data-resource-id', 'list_define_10'); expect(h.moves).toEqual([{ id: 'list_define_11', direction: 'up' }]);
 await page.locator('#resourceKeyword').fill('LIST_PREFIX_11'); await expect(page.locator('#managementDefineRows > tr')).toHaveCount(1); await expect(page.locator('#managementDefineRows td').nth(3)).toHaveText('10'); await expect(page.getByRole('button', { name: '上移 Define LIST_PREFIX_11', exact: true })).toBeDisabled();
 await page.getByRole('button', { name: '重置筛选', exact: true }).click(); await page.locator('#resourceSort').selectOption('name-desc'); await expect(page.locator('#managementDefineRows [data-move-resource]:enabled')).toHaveCount(0); expect(h.errors).toEqual([]);
});

test('node selections distinguish this page and all filtered Agents, retain hidden selections and can be cleared', async ({ page }) => {
 const h = await fixture(page); await page.getByRole('checkbox', { name: '选择本页 Agent', exact: true }).check(); await expect(page.locator('.selection-count')).toContainText('已选 18 个');
 await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.locator('#managementNodeRows input[type=checkbox]').first().check(); await expect(page.locator('.selection-count')).toContainText('已选 19 个'); await expect(page.locator('.selection-count')).toContainText('18 个不在本页');
 await page.locator('#resourceTypeFilter').selectOption('agent'); await page.getByRole('button', { name: '选择全部筛选结果（25 个 Agent）', exact: true }).click(); await expect(page.locator('.selection-count')).toContainText('已选 25 个');
 await page.locator('#resourceTypeFilter').selectOption('ssh'); await expect(page.locator('#managementNodeRows > tr')).toHaveCount(1); await expect(page.getByRole('checkbox', { name: '选择本页 Agent', exact: true })).toBeDisabled(); await expect(page.locator('.selection-count')).toContainText('25 个不在本页');
 await page.getByRole('button', { name: '清除选择', exact: true }).click(); await expect(page.getByRole('button', { name: '批量升级 Agent', exact: true })).toBeDisabled(); expect(h.errors).toEqual([]);
});

for (const width of [375, 390, 430]) test(`resource filters, long tables and pagination fit ${width}px`, async ({ page }) => {
 await page.setViewportSize({ width, height: 844 }); const h = await fixture(page); await page.locator('#resourceStaticsTab').click(); await expect(page.locator('#managementStaticRows > tr')).toHaveCount(20); await page.locator('#resourcePageSize').selectOption('10'); await page.locator('#resourcePageJump').fill('5'); await page.getByRole('button', { name: '前往', exact: true }).click(); await expect(page.locator('#managementStaticRows > tr')).toHaveCount(7);
 const overflow = await page.locator('#resourceWorkspaceApp').evaluate(el => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, controls: [...el.querySelectorAll<HTMLElement>('.resource-list-filters, .resource-pagination, .resource-results-toolbar')].map(e => ({ width: e.clientWidth, scroll: e.scrollWidth })) })); expect(overflow.page).toBeLessThanOrEqual(overflow.viewport + 1); expect(overflow.controls.every(e => e.scroll <= e.width + 1)).toBe(true);
 await page.locator('#resourceFamilyFilter').selectOption('ipv6'); await expect(page.getByRole('button', { name: '第 1 页', exact: true })).toHaveAttribute('aria-current', 'page'); await page.locator('#resourceKeyword').fill('不匹配'); await expect(page.getByTestId('resource-list-empty')).toBeVisible(); await page.getByRole('button', { name: '清除全部筛选', exact: true }).click(); await expect(page.locator('#managementStaticRows > tr')).toHaveCount(10);
 expect(h.errors).toEqual([]);
});
