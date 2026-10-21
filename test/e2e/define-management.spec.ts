import { expect, test, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => {
 await page.unrouteAll({ behavior: 'ignoreErrors' });
 // Each test logs in with a fresh context. Release it rather than exhausting
 // the real controller's 64 active-session limit during the combined suite.
 await page.request.post('/api/auth/logout');
});
async function fixture(page: Page, irr = false) {
 const sync = { status: 'ready', lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, error: null, contentHash: 'fixture' };
 let resources: any[] = [{ id: 'define_demo', name: 'CUSTOMERS', label: '业务前缀', nodeIds: ['local'], enabled: true, type: 'cidr4', entries: ['203.0.113.0/24'], entrySource: irr ? { kind: 'irr-as-set', asSet: 'AS-EXAMPLE', server: 'rr.example', databases: [], refreshIntervalSeconds: 900, prefixLimit: 100, allowMoreSpecific: false } : { kind: 'manual' }, sync }];
 let revision = 1, fail = false, failApply = false, failPreflight = false, loseResponse = false;
 let references: any[] = [];
 const writes: any[] = [], writeMethods: string[] = [], errors: string[] = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.route('**/api/dashboard**', async route => { const response = await route.fetch(); const data = await response.json(); data.inventory.defines = resources; await route.fulfill({ response, json: data }); });
 await page.route('**/api/defines/editor-context*', route => { const id = new URL(route.request().url()).searchParams.get('id'); return route.fulfill({ json: { inventoryRevision: revision, resource: resources.find(r => r.id === id) ?? null, references } }); });
 await page.route('**/api/defines/preview', async route => {
  const b = route.request().postDataJSON();
  if (b.inventoryRevision !== revision) return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化，草稿保留' } });
  const resource = { ...b, id: b.id ?? 'new_define', entries: b.type === 'expression' ? undefined : b.entrySource.kind === 'irr-as-set' ? ['198.51.100.0/24'] : String(b.entries).split('\n').filter(Boolean), sync };
  if (failPreflight) {
   failPreflight = false;
   return route.fulfill({ json: { valid: false, resource, inventoryRevision: revision, references, changes: { added: [], removed: [], addedCount: 0, removedCount: 0 }, configs: [
    { nodeId: 'local', config: 'candidate', diff: '+ candidate', validation: { ok: true, stdout: '', stderr: '' } },
    { nodeId: 'edge', config: 'candidate', diff: '+ candidate', validation: { ok: false, stdout: '', stderr: '节点预检超时，当前配置保持不变' } },
   ] } });
  }
  await route.fulfill({ json: { valid: true, previewId: 'preflight', candidateHash: 'candidate', inventoryRevision: revision, resource, references: [], changes: { added: resource.entries ?? [], removed: [], addedCount: resource.entries?.length ?? 0, removedCount: 0 }, configs: [{ nodeId: 'local', config: `define ${b.name} = SERVER_GENERATED;`, diff: '+ SERVER_GENERATED', validation: { ok: true, stdout: '', stderr: '' } }] } });
 });
 await page.route(/\/api\/defines(?:\/[^/?]+)?$/, async route => {
  const path = new URL(route.request().url()).pathname, method = route.request().method();
  if (path.endsWith('/preview') || path.endsWith('/editor-context')) return route.fallback();
  if (method === 'DELETE') { resources = []; return route.fulfill({ json: {} }); }
  if (!['POST', 'PUT'].includes(method)) return route.continue();
  const body = route.request().postDataJSON(); writes.push(body); writeMethods.push(method);
  if (failApply) { failApply = false; return route.fulfill({ status: 502, json: { error: '节点下发失败，已回滚' } }); }
  if (fail) { fail = false; revision++; resources[0].label = '服务端新备注'; return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化，草稿保留' } }); }
  resources = [{ ...body, id: body.id ?? 'new_define' }]; revision++;
  if (loseResponse) { loseResponse = false; return route.fulfill({ status: 200, contentType: 'text/plain', body: 'response interrupted' }); }
  await route.fulfill({ json: { resource: resources[0], deployment: { applied: true, nodeIds: ['local'] } } });
 });
 await page.goto('/'); await expect(page.locator('#authTitle')).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
 await page.locator('#authPassword').fill('playwright-admin-password'); if (await page.locator('#authTitle').textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceDefinesTab').click();
 return { writes, writeMethods, errors, loseResponse() { loseResponse = true; }, fail() { fail = true; }, failApply() { failApply = true; }, failPreflight() { failPreflight = true; }, setReferences(value: any[]) { references = value; }, removeElsewhere() { resources = []; revision++; } };
}
async function edit(page: Page) { await page.getByRole('button', { name: '编辑 Define CUSTOMERS', exact: true }).click(); await expect(page.getByRole('button', { name: '预检并查看变更', exact: true })).toBeEnabled(); }
test('Define type and source switches preserve separate drafts without mixing address families or expressions', async ({ page }) => {
 const h = await fixture(page); await edit(page);
 await page.locator('#policyResourceType').selectOption('cidr6');
 await expect(page.locator('#policyResourceSource')).toHaveValue('');
 await page.locator('#policyResourceSource').fill('2001:db8::/32+');
 await page.locator('#policyResourceType').selectOption('expression');
 await expect(page.locator('#policyResourceSource')).toHaveValue('true');
 await page.locator('#policyResourceSource').fill('150 # preference');
 await page.locator('#policyResourceType').selectOption('cidr4');
 await expect(page.locator('#policyResourceSource')).toHaveValue('203.0.113.0/24');
 await expect(page.locator('.define-heading-status')).toContainText('已保存配置');
 await page.locator('#policyResourceEntrySource').selectOption('irr-as-set');
 await expect(page.locator('.define-snapshot')).toContainText('尚未生成快照');
 await page.locator('#policyResourceEntrySource').selectOption('manual');
 await expect(page.locator('#policyResourceSource')).toHaveValue('203.0.113.0/24');
 await page.locator('#policyResourceType').selectOption('cidr6');
 await expect(page.locator('#policyResourceSource')).toHaveValue('2001:db8::/32+');
 await page.locator('#policyResourceType').selectOption('expression');
 await expect(page.locator('#policyResourceSource')).toHaveValue('150 # preference');
 expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
});
test('Prefix cleanup preserves length ranges and invalid text for server diagnostics', async ({ page }) => {
 await fixture(page); await edit(page);
 await page.locator('#policyResourceSource').fill('192.0.2.0/24{24, 28}, 192.0.2.0/24{24,28};198.51.100.0/24+');
 await page.getByRole('button', { name: '去重并整理' }).click();
 await expect(page.locator('#policyResourceSource')).toHaveValue('192.0.2.0/24{24,28}\n198.51.100.0/24+');
 await page.locator('#policyResourceSource').fill('192.0.2.0/24{24,28}}');
 await page.getByRole('button', { name: '去重并整理' }).click();
 await expect(page.locator('#policyResourceSource')).toHaveValue('192.0.2.0/24{24,28}}');
});
test('Creating a Define with a lost apply response reconciles its saved ID before another edit', async ({ page }) => {
 const h = await fixture(page); page.on('dialog', d => d.accept());
 await page.getByRole('button', { name: '+ 添加 Define', exact: true }).click();
 await page.locator('#policyResourceLabel').fill('响应丢失恢复'); await page.locator('#policyResourceName').fill('RECOVERED');
 await page.locator('#policyResourceSource').fill('198.18.40.0/24');
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#definePreview')).toBeVisible();
 h.loseResponse(); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('.policy-review-panels > [role="alert"]')).toContainText('配置可能已生效');
 await expect(page.getByRole('button', { name: '预检并查看变更', exact: true })).toBeDisabled();
 const context = page.waitForRequest(request => request.url().includes('/defines/editor-context?id=new_define'));
 await page.getByRole('button', { name: '加载最新版本并对比' }).click(); await context;
 await expect(page.locator('.define-comparison')).toContainText('RECOVERED');
 await page.getByRole('button', { name: '保留草稿并重新预检', exact: true }).click();
 await expect(page.locator('#policyResourceDialogTitle')).toHaveText('编辑 Define');
 await page.locator('#policyResourceSource').fill('198.18.41.0/24');
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#definePreview')).toBeVisible();
 await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
 expect(h.writeMethods).toEqual(['POST', 'PUT']); expect(h.errors).toEqual([]);
});
test('Define preflight → confirm → apply → reopen preserves normalized content; editing invalidates preview', async ({ page }) => {
 const h = await fixture(page); page.on('dialog', d => d.accept()); await edit(page);
 await page.locator('#policyResourceSource').fill('203.0.114.0/24'); await page.locator('#savePolicyResourceButton').click();
 await expect(page.locator('#definePreview')).toContainText('预检通过'); expect(h.writes).toHaveLength(0);
 await page.locator('#policyResourceLabel').fill('新的业务前缀'); await expect(page.locator('#definePreview')).toHaveCount(0);
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#definePreview')).toContainText('SERVER_GENERATED');
 await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
 expect(h.writes[0]).toMatchObject({ mode: 'apply', previewId: 'preflight', inventoryRevision: 1, entries: ['203.0.114.0/24'] });
 await edit(page); await expect(page.locator('#policyResourceSource')).toHaveValue('203.0.114.0/24');
 await expect(page.locator('.define-heading-status')).toContainText('已保存配置');
 expect(h.errors).toEqual([]);
});
test('Define unsaved cancellation, prefix import/dedup and expression templates', async ({ page }) => {
 const h = await fixture(page); await edit(page); await page.locator('#policyResourceSource').fill('203.0.113.0/24\n203.0.113.0/24');
 page.once('dialog', d => d.dismiss()); await page.locator('[data-close="policyResourceDialog"]').click(); await expect(page.locator('#policyResourceDialog')).toBeVisible();
 await page.getByRole('button', { name: '去重并整理' }).click(); await expect(page.locator('#policyResourceSource')).toHaveValue('203.0.113.0/24');
 await page.getByLabel('导入前缀文本').setInputFiles({ name: 'prefixes.txt', mimeType: 'text/plain', buffer: Buffer.from('[198.51.100.0/24, 192.0.2.0/24{24,28}]') });
 await expect(page.locator('#policyResourceSource')).toHaveValue('203.0.113.0/24\n198.51.100.0/24\n192.0.2.0/24{24,28}');
 await page.locator('#policyResourceType').selectOption('expression'); page.once('dialog', d => d.accept()); await page.getByLabel('表达式模板').selectOption('[64512, 64513]');
 await expect(page.locator('#policyResourceSource')).toHaveValue('[64512, 64513]'); expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
});
test('Define CAS conflict retains draft, compares remote changes and explicitly rebases before retry', async ({ page }) => {
 const h = await fixture(page); page.on('dialog', d => d.accept()); await edit(page);
 await page.locator('#policyResourceSource').fill('203.0.114.0/24'); await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toBeVisible();
 h.fail(); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 const feedback = page.getByRole('button', { name: '版本冲突 · 查看处理方式', exact: true });
 await expect(feedback).toBeInViewport();
 await page.locator('.policy-editor-content').evaluate(el => { el.scrollTop = 0; });
 await feedback.click();
 await expect(page.locator('.policy-review-panels > [role="alert"]')).toBeInViewport();
 await expect(page.locator('#policyResourceSource')).toHaveValue('203.0.114.0/24'); await expect(page.getByRole('button', { name: '加载最新版本并对比' })).toBeVisible();
 await page.getByRole('button', { name: '加载最新版本并对比' }).click(); await expect(page.locator('.define-comparison')).toContainText('服务端新备注');
 await page.getByRole('button', { name: '保留草稿并重新预检' }).click(); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click();
 await expect(page.locator('#definePreview')).toContainText('预检通过'); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('#policyResourceDialog')).not.toBeVisible(); expect(h.writes.at(-1).inventoryRevision).toBe(2); expect(h.errors).toEqual([]);
});
test('Keeping the opened configuration after a remote edit protects it as an unsaved draft', async ({ page }) => {
 const h = await fixture(page); await edit(page);
 await expect(page.locator('.define-heading-status')).toContainText('已保存配置');
 await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toBeVisible();
 h.fail(); page.once('dialog', d => d.accept());
 await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await page.getByRole('button', { name: '加载最新版本并对比' }).click();
 await expect(page.locator('.define-comparison')).toContainText('服务端新备注');
 await page.getByRole('button', { name: '保留草稿并重新预检' }).click();
 await expect(page.locator('#policyResourceLabel')).toHaveValue('业务前缀');
 await expect(page.locator('.define-heading-status')).toContainText('未保存修改');
 page.once('dialog', d => d.dismiss());
 await page.locator('[data-close="policyResourceDialog"]').click();
 await expect(page.locator('#policyResourceDialog')).toBeVisible();
 await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toContainText('预检通过');
 page.once('dialog', d => d.accept());
 await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await edit(page); await expect(page.locator('.define-heading-status')).toContainText('已保存配置');
 expect(h.writes.at(-1)).toMatchObject({ label: '业务前缀', inventoryRevision: 2 });
 expect(h.errors).toEqual([]);
});
test('Define removed elsewhere can recover local edits as a new resource after readonly comparison', async ({ page }) => {
 const h = await fixture(page); await edit(page);
 await page.locator('#policyResourceSource').fill('192.0.2.0/24'); h.removeElsewhere();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click();
 await page.getByRole('button', { name: '加载最新版本并对比' }).click();
 await expect(page.locator('.define-comparison')).toContainText('此 Define 已删除');
 await expect(page.getByRole('button', { name: '采用最新配置', exact: true })).toHaveCount(0);
 expect(h.writes).toHaveLength(0);
 await page.getByRole('button', { name: '保留草稿并作为新 Define 预检', exact: true }).click();
 await expect(page.locator('#policyResourceDialogTitle')).toHaveText('添加 Define');
 await expect(page.locator('#policyResourceSource')).toHaveValue('192.0.2.0/24');
 page.once('dialog', d => d.dismiss()); await page.locator('[data-close="policyResourceDialog"]').click();
 await expect(page.locator('#policyResourceDialog')).toBeVisible();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click();
 await expect(page.locator('#definePreview')).toContainText('预检通过');
 expect(h.writes).toHaveLength(0);
 page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
 expect(h.writes[0]).toMatchObject({ id: 'new_define', inventoryRevision: 2, entries: ['192.0.2.0/24'] });
 expect(h.errors).toEqual([]);
});
test('Define discards stale preview responses and cancels IRR expansion after switching to manual entries', async ({ page }) => {
 await fixture(page, true); await edit(page);
 let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
 await page.route('**/api/defines/irr/resolve', async route => { await barrier; await route.fulfill({ json: { entries: ['198.51.100.0/24'], count: 1 } }); });
 const request = page.waitForRequest('**/api/defines/irr/resolve'); await page.getByRole('button', { name: '测试展开', exact: true }).click(); await request;
 await page.locator('#policyResourceEntrySource').selectOption('manual'); await page.locator('#policyResourceSource').fill('192.0.2.0/24'); release();
 await expect(page.locator('#policyResourceSource')).toHaveValue('192.0.2.0/24');
 let unblock!: () => void; const wait = new Promise<void>(r => { unblock = r; });
 await page.route('**/api/defines/preview', async route => { await wait; await route.fulfill({ json: { valid: true, configs: [{ config: 'STALE' }] } }); });
 const preview = page.waitForRequest('**/api/defines/preview'); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await preview;
 await page.locator('#policyResourceLabel').fill('new draft'); unblock(); await expect(page.locator('#definePreview')).toHaveCount(0);
});
test('IRR sync uses saved configuration and stays disabled while current source is unsaved', async ({ page }) => {
 const h = await fixture(page, true); await edit(page);
 const sync = page.getByRole('button', { name: '立即同步并应用', exact: true }); await expect(sync).toBeEnabled();
 await sync.click(); await expect(page.locator('#definePreview')).toContainText('预检通过'); expect(h.writes).toHaveLength(0);
 await page.locator('#policyResourceAsSet').fill('AS-CHANGED'); await expect(sync).toBeDisabled();
 await expect(page.getByLabel('搜索快照前缀')).toBeVisible(); await page.getByLabel('搜索快照前缀').fill('not-present'); await expect(page.locator('.define-snapshot')).toContainText('匹配 0 条'); expect(h.writes).toHaveLength(0);
});
test('Define node preflight and apply failures show details, preserve edits and allow a complete retry', async ({ page }) => {
 const h = await fixture(page); page.on('dialog', d => d.accept()); await edit(page);
 await page.locator('#policyResourceSource').fill('198.18.40.0/24'); h.failPreflight();
 await page.locator('#savePolicyResourceButton').click();
 await expect(page.locator('#definePreview')).toBeVisible();
 await expect(page.locator('#definePreview')).toContainText('预检未通过');
 await expect(page.locator('#definePreview [role="alert"]')).toBeVisible();
 await expect(page.locator('#definePreview [role="alert"]')).toContainText('节点预检超时');
 await expect(page.locator('#definePreview')).toContainText('E2E Router · 通过');
 await expect(page.getByRole('button', { name: '确认应用', exact: true })).toHaveCount(0);
 expect(h.writes).toHaveLength(0);
 await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toContainText('预检通过');
 h.failApply(); await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('#policyResourceDialog')).toBeVisible();
 await expect(page.locator('#policyResourceSource')).toHaveValue('198.18.40.0/24');
 await expect(page.locator('.policy-review-panels > [role="alert"]')).toContainText('已回滚');
 await page.getByRole('button', { name: '操作未完成 · 查看错误详情', exact: true }).click();
 await expect(page.locator('.policy-review-panels > [role="alert"]')).toBeInViewport();
 await expect(page.getByRole('button', { name: '预检并查看变更', exact: true })).toBeEnabled();
 await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toBeVisible();
 await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.locator('#policyResourceDialog')).not.toBeVisible(); await edit(page);
 await expect(page.locator('#policyResourceSource')).toHaveValue('198.18.40.0/24'); expect(h.errors).toEqual([]);
});
test('Define reference impact remains visible and prevents accidental deletion', async ({ page }) => {
 const h = await fixture(page);
 h.setReferences([{ kind: 'functions', id: 'used', label: '业务前缀检查', nodeIds: ['local'], via: [] }, { kind: 'pipes', id: 'pipe', label: '主表业务互通', nodeIds: ['local'], via: ['业务前缀检查'] }]);
 await edit(page); await expect(page.locator('.define-references > summary')).toBeVisible();
 await expect(page.locator('.define-references > summary')).toContainText('2 个资源');
 await page.locator('#deletePolicyResourceButton').click();
 await expect(page.locator('.define-references')).toHaveAttribute('open', '');
 await expect(page.locator('.define-references')).toContainText('业务前缀检查');
 await expect(page.locator('.define-references')).toContainText('经 业务前缀检查');
 await expect(page.locator('.policy-review-panels > [role="alert"]')).toContainText('仍被引用');
 await expect(page.locator('#policyResourceDialog')).toBeVisible(); expect(h.writes).toHaveLength(0);
});
for (const width of [375, 390, 430]) test(`Define editor has no overflow and keeps actions visible at ${width}px`, async ({ page }) => {
 await page.setViewportSize({ width, height: 844 }); await fixture(page, true); await edit(page);
 const scope = await page.locator('#policyResourceNodeScope').evaluate(el => {
  const search = el.querySelector('input[type=search]')!.getBoundingClientRect(), node = el.querySelector('.policy-scope-node')!, checkbox = node.querySelector('input')!.getBoundingClientRect(), text = node.querySelector('span')!.getBoundingClientRect();
  return { searchHeight: search.height, checkboxRight: checkbox.right, textLeft: text.left };
 });
 expect(scope.searchHeight).toBeLessThanOrEqual(44); expect(scope.textLeft).toBeGreaterThan(scope.checkboxRight);
 const dialog = page.locator('#policyResourceDialog'); await page.locator('#policyResourceLabel').fill('长名称'.repeat(20));
 await expect(dialog.locator('.protocol-save-hint')).toBeInViewport();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#definePreview')).toBeVisible();
 const size = await dialog.evaluate(el => { const box = el.getBoundingClientRect(), actions = el.querySelector('.dialog-actions')!.getBoundingClientRect(); return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, left: box.left, right: box.right, bottom: actions.bottom, top: actions.top, height: window.innerHeight, contentScroll: el.querySelector('.policy-editor-content')!.scrollWidth, contentWidth: el.querySelector('.policy-editor-content')!.clientWidth }; });
 expect(size.scroll).toBeLessThanOrEqual(size.width); expect(size.left).toBeGreaterThanOrEqual(0); expect(size.right).toBeLessThanOrEqual(width); expect(size.bottom).toBeLessThanOrEqual(size.height); expect(size.top).toBeGreaterThan(0); expect(size.contentScroll).toBeLessThanOrEqual(size.contentWidth + 1);
});
