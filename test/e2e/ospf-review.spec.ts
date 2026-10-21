import { expect, test, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });
async function fixture(page: Page, draftOnly = false, runtime: any = { nodes: [] }) {
 const policy = (formAction: string) => ({ mode: 'form', formAction, steps: [{ type: 'form' }], filterId: null });
 const initial = { id: 'review', name: 'Reviewed OSPF', nodeConfigs: ['local', 'edge'].map(nodeId => ({ nodeId, enabled: true, versions: ['ospfv2', 'ospfv3'], routerId: nodeId === 'local' ? '192.0.2.1' : '192.0.2.2', importPolicies: { ospfv2: policy('all'), ospfv3: policy('all') }, exportPolicies: { ospfv2: policy('none'), ospfv3: policy('none') }, exportDefineIds: { ospfv2: null, ospfv3: null }, areaOptions: {}, virtualLinks: [] })), links: [{ id: 'pair', fromNodeId: 'local', toNodeId: 'edge', localInterface: 'eth0', remoteInterface: 'eth0', area: '0.0.0.0', cost: 10, hello: 10, dead: 40 }], layout: {} };
 let active: any = draftOnly ? null : structuredClone(initial), draft: any = draftOnly ? { domain: structuredClone(initial), inventoryRevision: 1 } : null;
 let revision = 1, failPreview = false, failApply = false, conflict = false;
 const writes: any[] = [], errors: string[] = [];
 page.on('pageerror', e => errors.push(e.message));
 await page.route('**/api/ospf', async route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { domains: active ? [active] : draft ? [draft.domain] : [], drafts: draft ? { review: draft } : {}, inventory: { ospfDomains: active ? [active] : [] }, inventoryRevision: revision, layout: {} } });
  return mutate(route);
 });
 const mutate = async (route: import('@playwright/test').Route) => {
  const body = route.request().postDataJSON(); writes.push({ method: route.request().method(), body });
  if (body.mode === 'draft') { draft = { domain: body, inventoryRevision: revision }; return route.fulfill({ json: { domain: body, inventoryRevision: revision } }); }
  if (conflict) { conflict = false; revision++; active.name = 'Remote OSPF'; return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化' } }); }
  if (failApply) { failApply = false; return route.fulfill({ status: 500, json: { error: '第二节点应用失败，已回滚', deployment: { applied: false, nodeResults: [{ nodeId: 'local', status: 'rolled_back' }, { nodeId: 'edge', status: 'unknown', error: '节点失联，回滚待确认' }], rollback: { attempted: true, succeeded: false } } } }); }
  active = body; draft = null; revision++; return route.fulfill({ json: { domain: active, inventoryRevision: revision, deployment: { applied: true, nodeResults: ['local', 'edge'].map(nodeId => ({ nodeId, status: 'success' })) } } });
 };
 await page.route('**/api/ospf/review', mutate);
 await page.route('**/api/ospf/render', route => route.fulfill({ json: { configs: [{ nodeId: 'local', config: 'server generated draft' }] } }));
 await page.route('**/api/ospf/preview', route => {
  const body = route.request().postDataJSON();
  if (body.inventoryRevision !== revision) return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化' } });
  return route.fulfill({ json: { valid: !failPreview, inventoryRevision: revision, previewId: 'ticket', candidateHash: 'hash', configs: ['local', 'edge'].map(nodeId => ({ nodeId, config: `candidate ${nodeId}`, diff: { changed: true, added: 2, removed: 1, unified: '+ candidate' }, validation: { ok: !failPreview || nodeId === 'local', stderr: failPreview && nodeId === 'edge' ? '远端节点预检超时' : '' } })) } });
 });
 await page.route('**/api/ospf/*/runtime', route => route.fulfill({ json: runtime }));
 await page.route('**/api/ospf/layout', route => route.fulfill({ json: { layout: {} } }));
 await page.route('**/api/nodes/*/interfaces', route => route.fulfill({ json: { interfaces: ['eth0', 'eth1'] } }));
 await page.goto('/'); await page.locator('#authPassword').fill('playwright-admin-password'); if (await page.locator('#authTitle').textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#ospfWorkspaceTab').click(); if (await page.locator('#ospfWarningDialog').isVisible()) await page.getByRole('button', { name: '我已了解风险，继续' }).click();
 await expect(page.locator('.ospf-topology-node')).toHaveCount(2);
 await expect(page.getByRole('textbox', { name: 'OSPF 域名称' })).toHaveValue('Reviewed OSPF');
 return { writes, errors, failPreview() { failPreview = true; }, failApply() { failApply = true; }, conflict() { conflict = true; } };
}
async function applyPlan(page: Page) { await page.getByRole('button', { name: '保存并应用', exact: true }).click(); await expect(page.locator('.ospf-apply-dialog')).toBeVisible(); }
test('OSPF Area drawer displays actual per-version statistics separately from the current draft', async ({ page }) => {
 const protocol = (area: string, type: string) => ({ state: 'up', areasAvailable: true, areaError: null, error: null, raw: 'native protocol up with zero neighbors', areas: [{ area, type, interfaces: 2, neighbors: 0, adjacentNeighbors: 0, raw: `Area: ${area}\n Number of neighbors: 0` }] });
 await fixture(page, false, { nodes: ['local', 'edge'].map(nodeId => ({ nodeId, runtime: { v2: { state: null, neighbors: 0, routes: 0, protocol: protocol('0.0.0.0', 'normal') }, v3: { state: null, neighbors: 0, routes: 0, protocol: protocol('0.0.0.3', 'nssa') }, neighbors: [], routes: [] } })) });
 await page.locator('.ospf-inspector-nav').getByRole('button', { name: '节点', exact: true }).click();
 const card = page.locator('.ospf-inspector-runtime-summary .runtime-summary-card').nth(2);
 await expect(card).toContainText('2'); await expect(card).toContainText('实际 Area'); await card.click();
 const drawer = page.locator('.ospf-runtime-dialog'); await expect(drawer).toBeVisible();
 await expect(drawer).toContainText('OSPFv2 协议 · 运行中'); await expect(drawer).toContainText('OSPFv3 协议 · 运行中');
 await expect(drawer).toContainText('Area 0.0.0.3'); await expect(drawer).toContainText('NSSA · 2 个接口'); await expect(drawer).toContainText('邻居 0 · 完全邻接 0');
 const draft = drawer.locator('details').filter({ has: page.locator('summary', { hasText: '当前草稿 Area' }) });
 await expect(draft).not.toHaveAttribute('open', '');
 await drawer.getByRole('button', { name: '关闭 OSPF 运行详情' }).click();
 await page.getByRole('textbox', { name: 'OSPF 域名称' }).fill('Unsaved runtime draft'); await card.click();
 await expect(drawer).toContainText('Area 0.0.0.3'); await drawer.getByRole('button', { name: '关闭 OSPF 运行详情' }).click();
 await expect(page.getByRole('textbox', { name: 'OSPF 域名称' })).toHaveValue('Unsaved runtime draft');
 page.once('dialog', dialog => dialog.accept());
 await page.getByRole('button', { name: '新建域', exact: true }).click();
 await page.locator('.ospf-inspector-nav').getByRole('button', { name: '节点', exact: true }).click();
 await expect(card).toContainText('未知');
 await card.click(); await expect(drawer).not.toContainText('Area 0.0.0.3');
});
test('OSPF Area errors stay scoped to one version and do not hide successful results', async ({ page }) => {
 await fixture(page, false, { nodes: [{ nodeId: 'local', runtime: { v2: { state: 'Full/PtP', neighbors: 1, routes: 1, protocol: { state: 'up', areasAvailable: true, areas: [{ area: '0.0.0.0', interfaces: 1, neighbors: 1, adjacentNeighbors: 1, raw: 'actual v2 area' }] } }, v3: { state: null, neighbors: 0, routes: 0, protocol: { state: 'up', areasAvailable: false, areaError: '当前 Agent 未提供 OSPF Area 统计，请升级 Agent 后重试', areas: [] } } } }] });
 await page.locator('.ospf-inspector-nav').getByRole('button', { name: '节点', exact: true }).click();
 const card = page.locator('.ospf-inspector-runtime-summary .runtime-summary-card').nth(2); await expect(card).toContainText('未知'); await card.click();
 const drawer = page.locator('.ospf-runtime-dialog'); await expect(drawer).toContainText('Area 0.0.0.0'); await expect(drawer).toContainText('邻居 1 · 完全邻接 1'); await expect(drawer).toContainText('升级 Agent');
});
test('OSPF failed preflight retains successful-node results in the preview drawer', async ({ page }) => {
 const h = await fixture(page); h.failPreview(); await page.getByRole('button', { name: '预检配置', exact: true }).click();
 const drawer = page.locator('.ospf-preview-dialog'); await expect(drawer).toBeVisible(); await expect(drawer).toContainText('远端节点预检超时');
 await expect(drawer.locator('.ospf-preview-diff-row')).toHaveCount(2); await expect(drawer.getByRole('button', { name: '查看应用计划' })).toHaveCount(0); expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
});
test('OSPF saved-only draft resumes and applies through create rather than updating a missing active domain', async ({ page }) => {
 const h = await fixture(page, true); await expect(page.locator('.ospf-health-grid')).toContainText('草稿已保存，尚未应用');
 await page.getByRole('textbox', { name: 'OSPF 域名称' }).fill('Saved draft name'); await page.getByRole('button', { name: '保存草稿', exact: true }).click();
 await expect(page.getByRole('textbox', { name: 'OSPF 域名称' })).toHaveValue('Saved draft name');
 await applyPlan(page); await expect(page.locator('.ospf-apply-list .ospf-apply-row')).toHaveCount(2);
 await page.locator('.ospf-apply-dialog').getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('.ospf-apply-dialog').getByRole('button', { name: '完成', exact: true })).toBeVisible();
 expect(h.writes.find(r => r.body.mode === 'apply').method).toBe('POST'); expect(h.errors).toEqual([]);
});
test('OSPF apply failure shows rollback and unknown nodes separately while retaining edits', async ({ page }) => {
 const h = await fixture(page); h.failApply(); await page.getByRole('textbox', { name: 'OSPF 域名称' }).fill('Local edits'); await applyPlan(page);
 await page.locator('.ospf-apply-dialog').getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('.ospf-apply-list .status-rolled_back')).toContainText('已回滚'); await expect(page.locator('.ospf-apply-list .status-unknown')).toContainText('节点失联');
 await page.locator('.ospf-apply-dialog').getByRole('button', { name: '取消', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'OSPF 域名称' })).toHaveValue('Local edits'); expect(h.errors).toEqual([]);
});
test('OSPF CAS comparison preserves local draft and retries against explicitly accepted latest revision', async ({ page }) => {
 const h = await fixture(page); h.conflict(); await page.getByRole('textbox', { name: 'OSPF 域名称' }).fill('My OSPF'); await applyPlan(page);
 await page.locator('.ospf-apply-dialog').getByRole('button', { name: '确认应用', exact: true }).click(); await page.locator('.ospf-apply-dialog').getByRole('button', { name: '取消', exact: true }).click();
 await page.getByRole('button', { name: '加载最新版本并对比', exact: true }).click(); await expect(page.locator('.ospf-conflict-comparison')).toContainText('Remote OSPF');
 await expect(page.getByRole('textbox', { name: 'OSPF 域名称' })).toHaveValue('My OSPF');
 await page.getByRole('button', { name: '保留草稿并重新预检', exact: true }).click(); await applyPlan(page); await page.locator('.ospf-apply-dialog').getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('.ospf-apply-dialog').getByRole('button', { name: '完成', exact: true })).toBeVisible(); expect(h.writes.at(-1).body.inventoryRevision).toBe(2); expect(h.errors).toEqual([]);
});

test('OSPF inspectors show only the selected object and retain draft while switching and saving', async ({ page }) => {
 const h = await fixture(page);
 const nav = page.getByRole('navigation', { name: 'OSPF 对象导航' });
 await expect(page.locator('.ospf-domain-inspector')).toBeVisible();
 await expect(page.locator('.ospf-editor')).not.toBeVisible();
 await nav.getByRole('button', { name: '节点', exact: true }).click();
 await expect(page.locator('.ospf-object-name')).not.toBeEmpty();
 const router = page.locator('.ospf-form-grid .field').filter({ hasText: 'Router ID' }).locator('input');
 await router.fill('192.0.2.83');
 await expect(page.locator('.ospf-editor .channel-policy-disclosure[open]')).toHaveCount(0);
 await nav.getByRole('button', { name: '链路', exact: true }).click();
 await expect(page.locator('.ospf-link-editor')).toBeVisible();
 await expect(page.locator('.ospf-editor')).not.toBeVisible();
 await expect(page.locator('.ospf-node-panel')).not.toBeVisible();
 await expect(page.locator('.ospf-inspector-runtime-summary')).toHaveCount(0);
 await nav.getByRole('button', { name: 'Area', exact: true }).click();
 await expect(page.locator('.ospf-area-advanced-details')).not.toHaveAttribute('open', '');
 await expect(page.locator('.ospf-node-panel')).not.toBeVisible();
 await nav.getByRole('button', { name: '节点', exact: true }).click();
 await expect(router).toHaveValue('192.0.2.83');
 for (const width of [375, 390, 430]) {
  await page.setViewportSize({ width, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 }
 await page.setViewportSize({ width: 1280, height: 600 });
 await page.locator('.ospf-advanced > summary').click();
 await expect(page.locator('.ospf-advanced > summary')).toBeInViewport();
 const geometry = await page.locator('.ospf-inspector').evaluate(el => ({
  inspectorBottom: el.getBoundingClientRect().bottom,
  bodyBottom: el.querySelector('.ospf-inspector-body')!.getBoundingClientRect().bottom,
  bodyHeight: el.querySelector('.ospf-inspector-body')!.getBoundingClientRect().height,
 }));
 expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.inspectorBottom);
 expect(geometry.bodyHeight).toBeGreaterThan(100);
 await page.getByRole('button', { name: '保存草稿', exact: true }).click();
 await expect.poll(() => h.writes.length).toBe(1);
 expect(h.writes[0].body.mode).toBe('draft');
 expect(h.writes[0].body.nodeConfigs.find((node: any) => node.nodeId === 'local').routerId).toBe('192.0.2.83');
 expect(h.errors).toEqual([]);
});
