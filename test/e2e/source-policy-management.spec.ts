import { expect, test, type Page } from '@playwright/test';

test.afterEach(async ({ page }) => {
 await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout');
});
async function fixture(page: Page) {
 let resource: any = { id: 'source_demo', nodeIds: ['local'], label: '业务出口', groups: [{ id: 'gateway_demo', egressAddress: '192.0.2.100', sources: ['198.18.100.0/24'], kernelTable: 50100, ruleSlot: 0 }], rulePriorityBase: 12048, copyInternalRoutes: false, internalDefineIds: [], enabled: true };
 let revision = 1, fail = false, failPreflight = false;
 const writes: any[] = [], errors: string[] = [];
 page.on('pageerror', error => errors.push(error.message));
 const plan = (candidate: any) => ({ operation: 'reconcile', resourceId: candidate.id, resourceLabel: candidate.label, nodeId: 'local', nodeName: 'E2E Router', platform: 'linux', birdConfig: 'protocol static SERVER_CANDIDATE {}', rules: [], removeRules: [], gatewayRules: [], removeGatewayRules: [], managedRules: [], removeManagedRules: [], applyScript: null, cleanupScript: '', systemdUnit: null, systemdInstallScript: null, instructions: [], management: 'agent', upgradeRequired: false, warning: null });
 const runtime = () => ({ resourceId: resource.id, nodes: resource.nodeIds.map((nodeId: string) => ({ nodeId, lastCheckedAt: '2026-10-19T00:00:00Z', rules: { expected: 2, installed: nodeId === 'edge' ? null : 2, missing: [], unexpected: [], persistence: nodeId === 'edge' ? 'unknown' : 'ready', error: nodeId === 'edge' ? '节点离线' : null, raw: '[]' }, groups: resource.groups.map((g: any) => ({ groupId: g.id, egressAddress: g.egressAddress, table: `bb_${g.id}`, kernelTable: g.kernelTable, skipped: false, protocols: [{ name: `static_${g.id}`, kind: 'Static', state: nodeId === 'edge' ? 'error' : 'up', raw: 'Native protocol detail', error: nodeId === 'edge' ? '节点离线' : null }], kernelRoutes: nodeId === 'edge' ? [] : [{ prefix: 'default', gateway: g.egressAddress, interface: 'eth1', type: 'unicast', raw: JSON.stringify({ gateway: g.egressAddress }) }], routesTruncated: false, routeError: nodeId === 'edge' ? '节点离线' : null })) })) });
 await page.route('**/api/source-policies/*/runtime', route => route.fulfill({ json: runtime() }));
 await page.route('**/api/source-policies/*/routes?*', route => {
  const params = new URL(route.request().url()).searchParams, groupId = params.get('groupId');
  return route.fulfill({ json: { resourceId: resource.id, nodeId: params.get('nodeId'), family: 'ipv4', table: `bb_${groupId}`, routes: [{ prefix: groupId === 'gateway_second' ? '198.18.222.0/24' : '198.18.111.0/24', summary: 'blackhole', details: `group=${groupId} target=${params.get('target')}` }], truncated: false, limit: 200 } });
 });
 await page.route('**/api/dashboard**', async route => { const response = await route.fetch(); const data = await response.json(); data.inventory.sourcePolicies = resource ? [resource] : []; await route.fulfill({ response, json: data }); });
 await page.route('**/api/source-policies/editor-context*', route => route.fulfill({ json: { inventoryRevision: revision, resource: new URL(route.request().url()).searchParams.has('id') ? resource : null } }));
 await page.route('**/api/source-policies/preview', async route => {
  const body = route.request().postDataJSON();
  if (body.inventoryRevision !== revision) return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化，草稿保留' } });
  const candidate = { ...body, id: body.id ?? 'new_mapping', rulePriorityBase: 12048, groups: body.groups.map((g: any) => ({ ...g, id: g.id ?? 'new_gateway', kernelTable: g.kernelTable ?? 50100, ruleSlot: 0 })) };
  const { mode: _mode, inventoryRevision: _revision, ...normalized } = candidate;
  if (body.mode !== 'plan' && failPreflight) {
   failPreflight = false;
   return route.fulfill({ json: { resource: normalized, inventoryRevision: revision, manualPlans: [plan(normalized)], valid: false, configs: [
    { nodeId: 'local', config: 'candidate', diff: '+ candidate', validation: { ok: true, stdout: '', stderr: '' } },
    { nodeId: 'edge', config: 'candidate', diff: '+ candidate', validation: { ok: false, stdout: '', stderr: '节点预检超时，未应用配置' } },
   ] } });
  }
  return route.fulfill({ json: { resource: normalized, manualPlans: [plan(normalized)], inventoryRevision: revision, ...(body.mode === 'plan' ? {} : { valid: true, previewId: 'source_preflight', candidateHash: 'hash', configs: [{ nodeId: 'local', config: 'SERVER_GENERATED', diff: '+ SERVER_GENERATED', validation: { ok: true, stdout: '', stderr: '' } }] }) } });
 });
 await page.route(/\/api\/source-policies(?:\/[^/?]+)?$/, async route => {
  const path = new URL(route.request().url()).pathname; if (path.endsWith('/preview') || path.endsWith('/editor-context')) return route.fallback();
  const body = route.request().postDataJSON(); writes.push({ method: route.request().method(), body });
  if (fail) { fail = false; revision++; resource.label = '服务端最新出口'; return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '版本冲突，草稿保留' } }); }
  if (route.request().method() === 'DELETE') { const deleted = resource; resource = null; revision++; return route.fulfill({ json: { manualPlans: [plan(deleted)], inventoryRevision: revision } }); }
  const { mode: _mode, inventoryRevision: _revision, previewId: _preview, candidateHash: _hash, ...normalized } = body;
  resource = normalized; revision++;
  return route.fulfill({ json: { resource, manualPlans: [plan(resource)], inventoryRevision: revision, deployment: { applied: true, nodeIds: ['local'] } } });
 });
 await page.goto('/'); await expect(page.locator('#authTitle')).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
 await page.locator('#authPassword').fill('playwright-admin-password'); if (await page.locator('#authTitle').textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password');
 await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceSourcePoliciesTab').click();
 return { writes, errors, fail() { fail = true; }, failPreflight() { failPreflight = true; }, removeElsewhere() { resource = null; revision++; }, addRuntimeExamples() { resource.nodeIds = ['local', 'edge']; resource.groups.push({ id: 'gateway_second', egressAddress: '192.0.2.101', sources: ['198.18.101.0/24'], kernelTable: 50101, ruleSlot: 1 }); } };
}
async function edit(page: Page) {
 await page.getByRole('button', { name: '编辑源地址出口映射 业务出口', exact: true }).click();
 await expect(page.getByRole('button', { name: '预检并查看变更', exact: true })).toBeEnabled();
}
test('source policy preview stays readonly, protects edits and applies the reviewed allocation before continuing editing and deletion', async ({ page }) => {
 const h = await fixture(page); await edit(page);
 await page.locator('#sourcePolicySource0_0').fill('198.18.101.0/24');
 page.once('dialog', d => d.dismiss()); await page.getByRole('button', { name: '关闭', exact: true }).click(); await expect(page.locator('#sourcePolicyDialog')).toBeVisible();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 expect(h.writes).toHaveLength(0); await expect(page.locator('#sourcePolicyPreflight')).toContainText('预检通过');
 await page.locator('#sourcePolicyLabel').fill('更新业务出口'); await expect(page.locator('#sourcePolicyPreflight')).toHaveCount(0);
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 page.on('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('.source-policy-heading-status')).toContainText('已保存配置'); expect(h.writes[0].body).toMatchObject({ mode: 'apply', inventoryRevision: 1, previewId: 'source_preflight', rulePriorityBase: 12048 });
 expect(h.writes[0].body.groups[0]).toMatchObject({ id: 'gateway_demo', kernelTable: 50100, sources: ['198.18.101.0/24'] });
 await page.getByRole('button', { name: '删除映射集', exact: true }).click(); await expect(page.locator('#sourcePolicyDialogTitle')).toHaveText('系统规则清理');
 await expect(page.locator('#sourcePolicyDialog')).toContainText('无需手工执行清理脚本'); expect(h.errors).toEqual([]);
});
test('source policy CAS conflict retains local draft and requires explicit comparison/rebase before retry', async ({ page }) => {
 const h = await fixture(page); await edit(page); page.on('dialog', d => d.accept());
 await page.locator('#sourcePolicySource0_0').fill('198.18.102.0/24');
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 h.fail(); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.getByRole('button', { name: '加载最新版本并对比' })).toBeVisible(); await expect(page.locator('#sourcePolicySource0_0')).toHaveValue('198.18.102.0/24');
 await page.getByRole('button', { name: '加载最新版本并对比' }).click(); await expect(page.locator('.source-policy-comparison')).toContainText('服务端最新出口');
 await page.getByRole('button', { name: '保留草稿并重新预检', exact: true }).click();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('.source-policy-heading-status')).toContainText('已保存配置');
 expect(h.writes.at(-1).body.inventoryRevision).toBe(2); expect(h.errors).toEqual([]);
});
test('source policy deleted elsewhere recovers as a new resource without losing local source CIDRs', async ({ page }) => {
 const h = await fixture(page); await edit(page); await page.locator('#sourcePolicySource0_0').fill('198.18.103.0/24'); h.removeElsewhere();
 await page.getByRole('button', { name: '加载最新版本并对比' }).click();
 await expect(page.locator('.source-policy-comparison')).toContainText('此映射集已删除');
 await page.getByRole('button', { name: '保留草稿并作为新映射预检', exact: true }).click();
 await expect(page.locator('#sourcePolicyDialogTitle')).toHaveText('新增源地址出口映射'); await expect(page.locator('#sourcePolicySource0_0')).toHaveValue('198.18.103.0/24');
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 expect(h.writes).toHaveLength(0); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('.source-policy-heading-status')).toContainText('已保存配置'); expect(h.writes[0].method).toBe('POST'); expect(h.errors).toEqual([]);
});
test('source policy retaining the opened configuration after remote edits still protects unsaved changes', async ({ page }) => {
 const h = await fixture(page); await edit(page);
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 h.fail(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await page.getByRole('button', { name: '加载最新版本并对比' }).click();
 await page.getByRole('button', { name: '保留草稿并重新预检', exact: true }).click();
 await expect(page.locator('.source-policy-heading-status')).toContainText('未保存修改');
 page.once('dialog', d => d.dismiss()); await page.getByRole('button', { name: '关闭', exact: true }).click();
 await expect(page.locator('#sourcePolicyDialog')).toBeVisible(); await expect(page.locator('#sourcePolicyLabel')).toHaveValue('业务出口');
 expect(h.errors).toEqual([]);
});
test('source policy runtime separates node errors and real route views; inspecting saved state preserves the editor draft', async ({ page }) => {
 const h = await fixture(page); h.addRuntimeExamples();
 // Reload the fixture inventory so the second node/group appears in selectors.
 await page.reload(); await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceSourcePoliciesTab').click();
 await edit(page); await page.locator('#sourcePolicySource0_0').fill('198.18.199.0/24');
 await page.getByRole('button', { name: '查看已保存运行态', exact: true }).click();
 const drawer = page.locator('#sourcePolicyRuntimeDialog'); await expect(drawer.locator('.source-rule-summary')).toContainText('2 / 2');
 await expect(drawer).toContainText('已保存，可在 Agent 启动时恢复'); await expect(drawer).toContainText('default');
 await page.getByLabel('源地址出口运行态节点').selectOption('edge'); await expect(drawer).toContainText('节点离线');
 await page.getByLabel('源地址出口运行态节点').selectOption('local'); await expect(drawer.locator('.source-rule-summary')).not.toContainText('节点离线');
 await page.getByRole('button', { name: 'BIRD 策略表路由', exact: true }).click(); await expect(drawer).toContainText('198.18.111.0/24');
 await page.getByLabel('源地址出口运行态出口组').selectOption('gateway_second'); await expect(drawer).toContainText('198.18.222.0/24');
 await page.getByLabel('源地址出口目标 IP').fill('198.18.222.1'); await drawer.getByRole('button', { name: '查询路由', exact: true }).click();
 await drawer.locator('.protocol-runtime-route > summary').click(); await expect(drawer).toContainText('target=198.18.222.1');
 await drawer.getByRole('button', { name: '关闭', exact: true }).click();
 await expect(page.locator('#sourcePolicySource0_0')).toHaveValue('198.18.199.0/24'); expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
});
test('source policy runtime discards route responses for a previously selected group', async ({ page }) => {
 const h = await fixture(page); h.addRuntimeExamples(); await page.reload(); await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceSourcePoliciesTab').click();
 await page.getByRole('button', { name: '查看源地址出口映射 业务出口 运行态', exact: true }).click();
 let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
 await page.route('**/api/source-policies/*/routes?*', async route => { if (new URL(route.request().url()).searchParams.get('groupId') !== 'gateway_demo') return route.fallback(); await barrier; await route.fulfill({ json: { routes: [{ prefix: 'STALE_ROUTE', summary: '', details: '' }] } }); });
 try {
  const started = page.waitForRequest(r => r.url().includes('/routes?') && r.url().includes('gateway_demo'));
  await page.getByRole('button', { name: 'BIRD 策略表路由', exact: true }).click(); await started;
  await page.getByLabel('源地址出口运行态出口组').selectOption('gateway_second');
  await expect(page.locator('#sourcePolicyRuntimeDialog')).toContainText('198.18.222.0/24'); release();
  await expect(page.locator('#sourcePolicyRuntimeDialog')).not.toContainText('STALE_ROUTE'); expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
 } finally { release(); }
});
test('source policy isolates failed nodes and discards obsolete preflight when the source CIDRs change', async ({ page }) => {
 const h = await fixture(page); await edit(page); h.failPreflight();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click();
 await expect(page.locator('#sourcePolicyPreflight')).toBeVisible(); await expect(page.locator('#sourcePolicyPreflight')).toContainText('E2E Router · 通过');
 await expect(page.locator('#sourcePolicyPreflight [role="alert"]')).toContainText('节点预检超时'); expect(h.writes).toHaveLength(0);
 await expect(page.getByRole('button', { name: '确认应用', exact: true })).toHaveCount(0);
 let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
 await page.route('**/api/source-policies/preview', async route => {
  if (route.request().postDataJSON().mode === 'plan') return route.fallback();
  await barrier; await route.fulfill({ json: { valid: true, configs: [{ nodeId: 'local', config: 'STALE_RESPONSE' }] } });
 });
 try {
  const started = page.waitForRequest(r => r.url().endsWith('/api/source-policies/preview') && r.postDataJSON()?.mode !== 'plan');
  await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await started;
  await page.locator('#sourcePolicySource0_0').fill('198.18.109.0/24'); release();
  await expect(page.locator('#sourcePolicyPreflight')).toHaveCount(0);
  await expect(page.locator('.source-policy-preview')).toContainText('草稿示意');
  await expect(page.getByRole('button', { name: '预检并查看变更', exact: true })).toBeEnabled();
  await expect(page.locator('#sourcePolicySource0_0')).toHaveValue('198.18.109.0/24'); expect(h.errors).toEqual([]);
 } finally { release(); }
});
for (const width of [375, 390, 430]) test(`source policy edit and preflight have readable content and fixed actions at ${width}px`, async ({ page }) => {
 await page.setViewportSize({ width, height: 844 }); await fixture(page); await edit(page);
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible();
 const bounds = await page.locator('#sourcePolicyDialog').evaluate(el => {
  const actions = el.querySelector('.dialog-actions')!.getBoundingClientRect(), content = el.querySelector('.source-policy-content')!, box = el.getBoundingClientRect();
  return { bodyOverflow: document.documentElement.scrollWidth - innerWidth, overflow: content.scrollWidth - content.clientWidth, left: box.left, right: box.right, contentHeight: content.clientHeight, footerBottom: actions.bottom, height: innerHeight };
 });
 expect(bounds.bodyOverflow).toBeLessThanOrEqual(0); expect(bounds.overflow).toBeLessThanOrEqual(1); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); expect(bounds.contentHeight).toBeGreaterThan(300); expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.height);
 await expect(page.getByRole('button', { name: '确认应用', exact: true })).toBeVisible();
});
for (const width of [375, 390, 430]) test(`source policy runtime has visible controls and no horizontal overflow at ${width}px`, async ({ page }) => {
 await page.setViewportSize({ width, height: 844 }); await fixture(page);
 await page.getByRole('button', { name: '查看源地址出口映射 业务出口 运行态', exact: true }).click();
 const drawer = page.locator('#sourcePolicyRuntimeDialog'); await expect(drawer).toContainText('2 / 2');
 await expect(drawer.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
 await expect(page.getByLabel('源地址出口运行态出口组')).toBeInViewport();
 const bounds = await drawer.evaluate(el => { const content = el.querySelector('.source-runtime-content')!; return { overflow: document.documentElement.scrollWidth - innerWidth, body: content.scrollWidth - content.clientWidth, height: content.clientHeight }; });
 expect(bounds.overflow).toBeLessThanOrEqual(0); expect(bounds.body).toBeLessThanOrEqual(1); expect(bounds.height).toBeGreaterThan(300);
});
