import { test, expect, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });
async function fixture(page: Page, kind: 'directs' | 'kernels') {
 const title = kind === 'directs' ? 'Direct' : 'Kernel', collection = kind === 'directs' ? 'directProtocols' : 'kernelProtocols';
 const policy = (action: string) => ({ mode: 'form', formAction: action, steps: [], filterId: null, inlineFilterSource: null });
 let resources: any[] = [{ id: 'system_demo', name: `demo_${kind}`, label: '业务路由', enabled: true, ipv4: true, ipv6: true, ...(kind === 'directs' ? { nodeId: 'local', interfaces: ['eth0'], checkLink: false } : { nodeIds: ['local'], importPolicy: policy('none'), exportPolicy: policy('all'), exportPolicies: { ipv4: { mode: 'visual', policy: policy('all'), prefSrc: null }, ipv6: { mode: 'visual', policy: policy('none'), prefSrc: null } }, table: null, scanTime: 60, persist: false }) }];
 let revision = 1, fail = '', hold = false, valid = true;
 let release: () => void = () => {}; let barrier = Promise.resolve();
 const writes: any[] = [], errors: string[] = [], previews: any[] = [], filterWrites: string[] = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname === '/api/filters' || pathname.startsWith('/api/filters/')) filterWrites.push(request.method()); });
 await page.route('**/api/dashboard**', async route => { const response = await route.fetch(); const data = await response.json(); data.inventory[collection] = resources; await route.fulfill({ response, json: data }); });
 await page.route(`**/api/${kind}/editor-context*`, route => { const id = new URL(route.request().url()).searchParams.get('id'); return route.fulfill({ json: { inventoryRevision: revision, resource: resources.find(r => r.id === id) ?? null } }); });
 await page.route('**/api/nodes/*/interfaces', route => route.fulfill({ status: 503, json: { error: '节点接口目录离线' } }));
 await page.route(`**/api/${kind}/preview`, async route => {
  const b = route.request().postDataJSON(); previews.push(b); if (hold) await barrier;
  if (b.inventoryRevision !== revision) return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT', error: '库存已变化' } });
  await route.fulfill({ json: { valid, previewId: 'preflight', candidateHash: 'candidate', inventoryRevision: revision, resource: { ...b, id: b.id ?? 'system_new' }, configs: [{ nodeId: 'local', config: 'SERVER_GENERATED_CONFIG', diff: '+ SERVER_GENERATED_DIFF', validation: { ok: valid, stdout: '', stderr: valid ? '' : '接口参数非法' } }] } });
 });
 await page.route(new RegExp(`/api/${kind}(?:/[^/?]+)?$`), async route => {
  if (['/preview', '/editor-context'].some(p => new URL(route.request().url()).pathname.endsWith(p))) return route.fallback();
  const method = route.request().method(), b = route.request().postDataJSON(); writes.push({ method, ...b });
  if (fail) { const code = fail; fail = ''; if (code === 'STATE_CONFLICT') { revision++; resources[0].label = '服务器上的新名称'; } return route.fulfill({ status: 409, json: { code, error: code === 'STATE_CONFLICT' ? '库存已变化，草稿保留' : '部署失败，已回滚' } }); }
  resources = method === 'DELETE' ? [] : [{ ...b, id: method === 'POST' ? 'system_new' : 'system_demo' }]; revision++;
  await route.fulfill({ json: { deployment: { applied: true } } });
 });
 await page.route(`**/api/${kind}/*/runtime`, route => route.fulfill({ json: { resourceId: 'system_demo', nodes: [{ nodeId: 'local', lastCheckedAt: new Date().toISOString(), protocols: [{ name: `demo_${kind}`, family: 'dual', state: 'up', imported: 3, exported: 7, error: null, raw: 'Real raw fixture' }] }, { nodeId: 'edge', lastCheckedAt: new Date().toISOString(), protocols: [{ name: `demo_${kind}`, family: 'dual', state: 'error', imported: null, exported: null, error: '节点超时', raw: '' }] }] } }));
 await page.route(`**/api/${kind}/*/routes*`, route => route.fulfill({ json: { resourceId: 'system_demo', nodeId: 'local', table: new URL(route.request().url()).searchParams.get('family') === 'ipv6' ? 'master6' : 'master4', routes: [{ prefix: '198.51.100.0/24', summary: 'via 192.0.2.2', details: 'BGP.local_pref: 150' }], truncated: true } }));
 await page.goto('/'); await expect(page.locator('#authTitle')).toHaveText(/^(设置管理密码|登录 Birdbox)$/); await page.locator('#authPassword').fill('playwright-admin-password'); if (await page.locator('#authTitle').textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click(); await page.locator(`#resource${title}sTab`).click();
 return { writes, errors, previews, filterWrites, title, fail(code = 'STATE_CONFLICT') { fail = code; }, invalid() { valid = false; }, hold() { hold = true; barrier = new Promise(resolve => { release = resolve; }); }, release() { hold = false; release(); } };
}
async function edit(page: Page, title: string, kind: string) { await page.getByRole('button', { name: `编辑 ${title} demo_${kind}`, exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).toBeVisible(); await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled(); }
async function inspect(page: Page) { await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#systemProtocolPreview')).toBeVisible(); }
for (const kind of ['directs', 'kernels'] as const) {
 test(`${kind}: create defaults, offline fallback, readonly preview → apply → reopen → disable → delete`, async ({ page }) => {
  const h = await fixture(page, kind); page.on('dialog', d => d.accept()); await page.getByRole('button', { name: `+ 添加 ${h.title}`, exact: true }).click();
  await expect(page.locator('#systemProtocolDialog')).toBeVisible(); await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled();
  if (kind === 'directs') { await expect(page.locator('#directNode')).toHaveValue('local'); await expect(page.locator('#systemProtocolDialog')).toContainText('节点接口目录离线'); await page.getByLabel('手动填写接口或匹配规则').fill('eth1, vlan*'); }
  else { await expect(page.locator('#kernelScope')).toHaveValue('false'); await expect(page.locator('#systemProtocolDialog details[open]')).toHaveCount(0); }
  await page.locator('#systemProtocolLabel').fill('验收路由'); await page.locator('#systemProtocolName').fill('acceptance_routes'); await inspect(page);
  expect(h.writes).toHaveLength(0); await expect(page.locator('#systemProtocolPreview')).toContainText('SERVER_GENERATED_DIFF');
  await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible();
  expect(h.writes[0]).toMatchObject({ mode: 'apply', previewId: 'preflight', inventoryRevision: 1 });
  await page.getByRole('button', { name: `编辑 ${h.title} acceptance_routes`, exact: true }).click(); await expect(page.locator('#systemProtocolLabel')).toHaveValue('验收路由');
  await page.locator('label[for=systemProtocolEnabled]').click(); await expect(page.locator('#systemProtocolEnabled')).not.toBeChecked(); await inspect(page); await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible();
  expect(h.writes[1].enabled).toBe(false);
  await page.getByRole('button', { name: `编辑 ${h.title} acceptance_routes`, exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).toBeVisible(); await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled(); await page.getByRole('button', { name: '删除资源', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).not.toBeVisible(); expect(h.writes.at(-1).method).toBe('DELETE'); expect(h.errors).toEqual([]);
 });
 test(`${kind}: unsaved/Escape protection, stale preview discarded and deploy error keeps draft`, async ({ page }) => {
  const h = await fixture(page, kind); await edit(page, h.title, kind); await page.locator('#systemProtocolLabel').fill('尚未保存');
  page.once('dialog', d => d.dismiss()); await page.keyboard.press('Escape'); await expect(page.locator('#systemProtocolDialog')).toBeVisible();
  h.hold(); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect.poll(() => h.previews.length).toBe(1); await page.locator('#systemProtocolLabel').fill('较新的草稿'); h.release(); await expect(page.locator('#systemProtocolPreview')).toHaveCount(0);
  await inspect(page); h.fail('DEPLOYMENT_FAILED'); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#systemProtocolDialog')).toContainText('部署失败，已回滚'); await expect(page.locator('#systemProtocolLabel')).toHaveValue('较新的草稿'); await expect(page.getByRole('button', { name: '预检并查看变更', exact: true })).toBeEnabled(); expect(h.errors).toEqual([]);
 });
 test(`${kind}: CAS compares remote, keeps local, rebases and requires new preview`, async ({ page }) => {
  const h = await fixture(page, kind); await edit(page, h.title, kind); await page.locator('#systemProtocolLabel').fill('本地名称'); await inspect(page); h.fail(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click();
  await page.getByRole('button', { name: '加载最新版本并对比', exact: true }).click(); await expect(page.getByRole('region', { name: '库存冲突对比' })).toContainText('服务器上的新名称');
  await page.getByRole('button', { name: '保留草稿，重新预检', exact: true }).click(); await expect(page.locator('#systemProtocolLabel')).toHaveValue('本地名称'); await inspect(page); expect(h.previews.at(-1).inventoryRevision).toBe(2); expect(h.errors).toEqual([]);
 });
 test(`${kind}: invalid preview cannot apply; independent runtime and routes lead back to config`, async ({ page }) => {
  const h = await fixture(page, kind); await page.getByRole('button', { name: `查看 ${h.title} demo_${kind} 运行态`, exact: true }).click(); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText('运行中'); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText('节点超时');
  await page.getByLabel('协议路由地址族').selectOption('ipv6'); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText('master6'); await expect(page.locator('#systemProtocolRuntimeDialog')).toContainText('已截断'); await page.getByRole('button', { name: '编辑配置', exact: true }).click();
  await expect(page.locator('#systemProtocolDialog')).toBeVisible(); await expect(page.locator('#systemProtocolDialog .primary-button')).toBeEnabled(); h.invalid(); await inspect(page); await expect(page.locator('#systemProtocolPreview')).toContainText('接口参数非法'); await expect(page.getByRole('button', { name: '确认应用', exact: true })).toHaveCount(0); expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
 });
}
test('Kernel independent export families and 375/390/430px stable header/footer without horizontal overflow', async ({ page }) => {
 const h = await fixture(page, 'kernels'); await edit(page, h.title, 'kernels');
 await page.getByText('BIRD → Linux（IPv4 Export）', { exact: false }).click(); await page.getByLabel('ipv4 Kernel 导出策略模式').selectOption('krt_prefsrc'); await page.locator('#kernelPrefSrc-ipv4').fill('192.0.2.1');
 await page.getByText('BIRD → Linux（IPv6 Export）', { exact: false }).click(); await page.getByLabel('ipv6 Kernel 导出策略模式').selectOption('krt_prefsrc'); await page.locator('#kernelPrefSrc-ipv6').fill('2001:db8::1');
 for (const width of [375, 390, 430]) {
  await page.setViewportSize({ width, height: 844 }); await inspect(page);
  const layout = await page.locator('#systemProtocolDialog').evaluate(el => { const head = el.querySelector('header')!.getBoundingClientRect(), foot = el.querySelector('footer')!.getBoundingClientRect(); return { overflow: el.scrollWidth - el.clientWidth, outerScroll: el.scrollTop, headTop: head.top, footBottom: foot.bottom }; });
  expect(layout.overflow).toBe(0); expect(layout.outerScroll).toBe(0); expect(layout.headTop).toBeGreaterThanOrEqual(0); expect(layout.footBottom).toBeLessThanOrEqual(844);
  const button = page.getByRole('button', { name: '确认应用', exact: true }); await expect(button).toBeInViewport();
  await page.locator('#kernelPrefSrc-ipv4').fill(`192.0.2.${width === 375 ? 2 : width === 390 ? 3 : 4}`);
 }
 expect(h.previews[0].exportPolicies).toMatchObject({ ipv4: { prefSrc: '192.0.2.1' }, ipv6: { prefSrc: '2001:db8::1' } }); expect(h.errors).toEqual([]);
});

test('Kernel exposes independent inline Filter quick editors for all families and directions', async ({ page }) => {
 const h = await fixture(page, 'kernels'); await edit(page, h.title, 'kernels');
 const cases = [
  ['ipv4-import', 'ipv4 Import 直接编写 Filter', 'if net ~ [ 203.0.113.0/24 ] then accept;\nreject;'],
  ['ipv6-import', 'ipv6 Import 直接编写 Filter', 'if net ~ [ 2001:db8:1::/48 ] then accept;\nreject;'],
  ['ipv4-export', 'ipv4 Export 直接编写 Filter', 'if net ~ [ 198.51.100.0/24 ] then accept;\nreject;'],
  ['ipv6-export', 'ipv6 Export 直接编写 Filter', 'if net ~ [ 2001:db8:2::/48 ] then accept;\nreject;'],
 ] as const;
 for (const [key, action, source] of cases) {
  if (key === 'ipv4-export') { await page.locator('[data-kernel-policy="ipv4-export"] > summary').click(); await page.getByLabel('ipv4 Kernel 导出策略模式').selectOption('krt_prefsrc'); }
  const button = page.getByRole('button', { name: action, exact: true });
  await expect(button).toBeVisible(); await button.click();
  const editor = page.locator(`[data-policy-editor="kernel-${key}"]`);
  await expect(editor).toBeVisible(); await expect(editor).toBeFocused(); await editor.fill(source);
  await expect(page.locator(`[data-kernel-policy="${key}"]`)).toHaveAttribute('open', '');
 }
 await page.setViewportSize({ width: 390, height: 844 });
 await expect(page.locator('[data-policy-editor="kernel-ipv6-export"]')).toBeVisible();
 await inspect(page);
 expect(h.previews.at(-1)).toMatchObject({
  importPolicies: {
   ipv4: { mode: 'custom', filterId: null, inlineFilterSource: cases[0][2] },
   ipv6: { mode: 'custom', filterId: null, inlineFilterSource: cases[1][2] },
  },
  exportPolicies: {
   ipv4: { mode: 'visual', policy: { mode: 'custom', filterId: null, inlineFilterSource: cases[2][2] } },
   ipv6: { mode: 'visual', policy: { mode: 'custom', filterId: null, inlineFilterSource: cases[3][2] } },
  },
 });
 expect(h.filterWrites).toEqual([]); expect(h.errors).toEqual([]);
});
