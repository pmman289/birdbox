import { expect, test, type Page } from '@playwright/test';
import { defaultBgpOptions, defaultChannel } from '../../apps/web/src/sessions/session-draft';
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });
async function fixture(page: Page, disconnectedMember = false) {
  let revision = 1, failure = '', held = false, release = () => {}, barrier = Promise.resolve();
  let inventory: any, saved: any = { id: 'core', name: 'Core', asn: 64512, members: [{ nodeId: 'local', address: '192.0.2.1' }, { nodeId: 'edge', address: '192.0.2.22' }], adjacencies: [{ id: 'pair', leftNodeId: 'local', rightNodeId: 'edge', leftSessionId: 'left', rightSessionId: 'right', enabled: true }], layout: {} };
  let sessions: any[] = saved.members.map((m: any, i: number) => ({ id: i ? 'right' : 'left', nodeId: m.nodeId, peerId: `pair_peer_${i ? 'right' : 'left'}`, protocolName: `core_${i}`, localAddress: m.address, localAsn: 64512, localPort: 179, enabled: true, sessionType: 'ibgp', bgp: { ...defaultBgpOptions(), connectionMode: 'multihop' }, channels: { ipv4: defaultChannel(), ipv6: defaultChannel() }, managedBy: { kind: 'ibgp-domain', domainId: 'core', adjacencyId: 'pair' } }));
  if (disconnectedMember) saved.members.push({ nodeId: 'spare', address: '192.0.2.33' });
  const writes: any[] = [], previews: any[] = [], errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/ibgp-domains**', async r => {
    const method = r.request().method(), url = r.request().url();
    if (method === 'GET') {
      if (!inventory) { const response = await r.fetch(); inventory = (await response.json()).inventory; if (disconnectedMember) inventory.nodes.push({ ...inventory.nodes[0], id: 'spare', name: 'Spare Router', routerId: '192.0.2.33' }); }
      return r.fulfill({ json: { domains: saved ? [saved] : [], inventoryRevision: revision, inventory: { ...inventory, sessions, ibgpDomains: saved ? [saved] : [] } } });
    }
    const b = r.request().postDataJSON() ?? {};
    if (url.endsWith('/preview')) {
      previews.push(b); const fail = failure === 'OLD_PREVIEW' && held;
      if (held) await barrier;
      if (fail) return r.fulfill({ status: 502, json: { error: '旧域检查失败' } });
      if (b.inventoryRevision !== revision) return r.fulfill({ status: 409, json: { error: '库存已变化', code: 'STATE_CONFLICT' } });
      const domain = { ...b, id: b.id || 'new_core' }; for (const key of ['inventoryRevision', 'sessionUpdates']) delete domain[key];
      const normalized = (b.sessionUpdates ?? []).map((s: any) => ({ ...s, managedBy: { ...s.managedBy, domainId: domain.id } }));
      return r.fulfill({ json: { valid: true, domain, sessions: normalized, inventoryRevision: revision, previewId: 'reviewed', candidateHash: 'hash', configs: domain.members.map((m: any) => ({ nodeId: m.nodeId, nodeName: m.nodeId, config: '', previousConfig: '', diff: '+ REVIEWED_DIFF', validation: { ok: true } })), sides: normalized.map((s: any, i: number) => ({ side: i ? 'right' : 'left', nodeId: s.nodeId, nodeName: s.nodeId, session: s, config: `protocol bgp ${s.protocolName} {}`, validation: { ok: true } })) } });
    }
    if (url.endsWith('/layout')) return r.fulfill({ json: { inventoryRevision: ++revision } });
    writes.push({ method, ...b });
    if (failure === 'DEPLOYMENT_FAILED') { failure = ''; return r.fulfill({ status: 500, json: { error: '部署失败，已回滚' } }); }
    if (b.inventoryRevision !== revision) return r.fulfill({ status: 409, json: { error: '库存已变化', code: 'STATE_CONFLICT' } });
    if (method === 'DELETE') { saved = null; sessions = []; }
    else { saved = { ...b }; sessions = b.sessionUpdates; for (const key of ['sessionUpdates', 'mode', 'inventoryRevision', 'previewId', 'candidateHash']) delete saved[key]; }
    revision++;
    return r.fulfill({ json: { domain: saved, inventoryRevision: revision, inventory: { ...inventory, sessions, ibgpDomains: saved ? [saved] : [] }, deployment: { applied: true, nodeResults: [{ nodeId: 'local', status: 'success' }] } } });
  });
  await page.goto('/'); await expect(page.locator('#authTitle')).toHaveText(/^(设置管理密码|登录 Birdbox)$/);
  await page.locator('#authPassword').fill('playwright-admin-password'); if (await page.locator('#authTitle').textContent() === '设置管理密码') await page.locator('#authConfirmation').fill('playwright-admin-password');
  await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible(); await page.locator('#ibgpWorkspaceTab').click(); await expect(page.locator('#ibgpName')).toHaveValue('Core');
  return { writes, previews, errors, remoteChange() { revision++; saved.name = 'Remote Core'; }, fail() { failure = 'DEPLOYMENT_FAILED'; }, holdError() { held = true; failure = 'OLD_PREVIEW'; barrier = new Promise(r => { release = r; }); }, release() { held = false; failure = ''; release(); } };
}
const protocol = (page: Page, side = 0) => page.locator('.ibgp-side-editor').nth(side).locator('input[pattern]').first();
async function preflight(page: Page) {
  const button = page.getByRole('button', { name: '预检并查看变更', exact: true }); await expect(button).toBeEnabled(); await button.click();
  await expect(page.locator('.ibgp-change-review > summary')).toHaveText(/· 通过$/);
}
async function apply(page: Page) {
  await expect(page.getByRole('button', { name: '确认应用', exact: true })).toBeEnabled(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.getByRole('button', { name: '保存域', exact: true })).toBeVisible();
}
test('iBGP reviewed apply preserves independent endpoints and empty-domain create/remove flow', async ({ page }) => {
  const h = await fixture(page); await expect(page.locator('.ibgp-side-editor').nth(1)).not.toBeVisible(); await protocol(page).fill('left_custom'); await page.getByRole('button', { name: '同时查看双端', exact: true }).click(); await protocol(page, 1).fill('right_custom');
  await page.locator('.ibgp-side-editor').nth(0).locator('input[type=number]').first().fill('1179'); await page.locator('.ibgp-side-editor').nth(1).locator('input[type=number]').first().fill('2179');
  await preflight(page); expect(h.writes).toHaveLength(0); await apply(page);
  expect(h.writes[0]).toMatchObject({ mode: 'apply', inventoryRevision: 1, previewId: 'reviewed', candidateHash: 'hash' }); expect(h.writes[0].sessionUpdates.map((s: any) => [s.protocolName, s.localPort])).toEqual([['left_custom', 1179], ['right_custom', 2179]]);
  await expect(protocol(page)).toHaveValue('left_custom'); await page.getByRole('button', { name: '新建域', exact: true }).click(); await page.locator('#ibgpName').fill('Empty Core'); await preflight(page); await apply(page); expect(h.writes.at(-1).adjacencies).toEqual([]);
  await page.locator('#ibgpName').fill('Unsaved Empty'); page.once('dialog', d => d.dismiss()); await page.getByRole('combobox', { name: '选择 iBGP 域', exact: true }).selectOption('core'); await expect(page.getByRole('combobox', { name: '选择 iBGP 域', exact: true })).toHaveValue('new_core'); await expect(page.locator('#ibgpName')).toHaveValue('Unsaved Empty');
  page.once('dialog', d => d.accept()); await page.locator('.ibgp-toolbar').getByRole('button', { name: '删除', exact: true }).click(); await expect(page.locator('#ibgpName')).toHaveValue('Core'); expect(h.writes.at(-1).method).toBe('DELETE'); expect(h.errors).toEqual([]);
});
test('iBGP deployment failure and CAS keep draft, compare/rebase then reviewed retry', async ({ page }) => {
  const h = await fixture(page); await protocol(page).fill('retry_draft'); await preflight(page); h.fail(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('.ibgp-workspace')).toContainText('部署失败，已回滚'); await expect(protocol(page)).toHaveValue('retry_draft');
  h.remoteChange(); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.getByRole('button', { name: '加载最新版本并对比', exact: true })).toBeVisible(); await page.getByRole('button', { name: '加载最新版本并对比', exact: true }).click(); await expect(page.locator('.ibgp-workspace')).toContainText('Remote Core'); await page.getByRole('button', { name: '保留本地草稿并重新预检', exact: true }).click(); await expect(protocol(page)).toHaveValue('retry_draft'); await preflight(page); await apply(page); expect(h.writes.at(-1).inventoryRevision).toBe(2); expect(h.errors).toEqual([]);
});
test('iBGP rejects stale domain preview errors and guards workspace switch without losing draft', async ({ page }) => {
  const h = await fixture(page); await preflight(page); h.holdError(); await protocol(page).fill('old_pending'); await expect.poll(() => h.previews.at(-1)?.sessionUpdates?.[0]?.protocolName).toBe('old_pending');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '新建域', exact: true }).click(); h.release(); await expect(page.locator('#ibgpName')).toHaveValue('新 iBGP 域'); await preflight(page); await expect(page.locator('.ibgp-workspace')).not.toContainText('旧域检查失败');
  await page.locator('#ibgpName').fill('Keep New'); page.once('dialog', d => d.dismiss()); await page.locator('#resourceWorkspaceTab').click(); await expect(page.locator('#ibgpWorkspace')).toBeVisible(); await expect(page.locator('#ibgpName')).toHaveValue('Keep New'); expect(h.errors).toEqual([]);
});
test('iBGP reviewed diff and dual-end editors fit 375/390/430px', async ({ page }) => {
  const h = await fixture(page); await preflight(page);
 await expect(page.getByRole('button', { name: '移除连接', exact: true })).toBeVisible();
 await expect(page.locator('.ibgp-connection-selection-flow')).toHaveCount(0);
  for (const width of [375, 390, 430]) { await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false); await expect(page.getByRole('button', { name: '确认应用', exact: true })).toBeVisible(); }
  expect(h.errors).toEqual([]);
});

test('iBGP single endpoint navigation preserves independent drafts and collapsed policies through review', async ({ page }) => {
 const h = await fixture(page);
 const sides = page.locator('.ibgp-side-editor');
 await expect(sides.nth(0)).toBeVisible(); await expect(sides.nth(1)).not.toBeVisible();
 await expect(page.locator('.ibgp-preview-section[open]')).toHaveCount(0);
 await expect(sides.first().locator('.channel-policy-disclosure[open]')).toHaveCount(0);
 await protocol(page).fill('guided_left');
 const direction = sides.first().locator('[data-family=ipv4] .channel-policy-disclosure').first();
 await direction.locator('summary').click();
 await direction.locator('.policy-form-fields select').first().selectOption('none');
 await page.getByRole('group', { name: '选择编辑端点' }).getByRole('button').nth(1).click();
 await expect(sides.nth(0)).not.toBeVisible(); await expect(sides.nth(1)).toBeVisible();
 await protocol(page, 1).fill('guided_right');
 await expect(sides.nth(1).locator('[data-family=ipv4] .channel-policy-disclosure').first().locator('summary')).toContainText('接收全部');
 await page.getByRole('group', { name: '选择编辑端点' }).getByRole('button').first().click();
 await expect(protocol(page)).toHaveValue('guided_left');
 await expect(direction.locator('summary')).toContainText('禁止接收');
 await page.getByRole('navigation', { name: 'iBGP 配置步骤' }).getByRole('button', { name: /预检与应用/ }).click();
 await expect(page.locator('.ibgp-change-review > summary')).toHaveText(/· 通过$/);
 expect(h.writes).toHaveLength(0);
 expect(h.previews.at(-1).sessionUpdates.map((s: any) => s.protocolName)).toEqual(['guided_left', 'guided_right']);
 await apply(page); expect(h.writes).toHaveLength(1);
 expect(h.writes[0].sessionUpdates[0].channels.ipv4.importPolicy.formAction).toBe('none');
 expect(h.writes[0].sessionUpdates[1].channels.ipv4.importPolicy.formAction).toBe('all');
 expect(h.errors).toEqual([]);
});

test('iBGP selecting a disconnected member clears the previous pair without changing its draft', async ({ page }) => {
 const h = await fixture(page, true);
 await protocol(page).fill('keep_existing_pair');
 await page.locator('.ibgp-node').filter({ hasText: 'Spare Router' }).click();
 await expect(page.locator('.ibgp-pair-workspace')).toHaveCount(0);
 await expect(page.locator('.ibgp-connection-panel')).toContainText('在拓扑中依次选择端点 A 和端点 B');
 await page.locator('.ibgp-node').filter({ hasText: 'E2E Router' }).click();
 await expect(protocol(page)).toHaveValue('keep_existing_pair');
 await preflight(page); expect(h.previews.at(-1).adjacencies).toHaveLength(1);
 expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
});
