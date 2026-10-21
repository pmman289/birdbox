import { expect, test } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.request.post('/api/auth/logout'); });
test('source mapping real HTTP: readonly preflight → reviewed apply → reopen/edit → disable/enable → delete', async ({ page }, info) => {
 const label = `源出口验收 ${info.project.name} ${Date.now()}`, errors: string[] = [];
 page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
 await page.goto('/'); await page.locator('#authPassword').fill('demo-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceSourcePoliciesTab').click();
 await page.locator('#resource-sourcePolicies .primary-button').click();
 await page.locator('#sourcePolicyLabel').fill(label); await page.locator('#sourcePolicyGroup0').fill('10.10.0.200'); await page.locator('#sourcePolicySource0_0').fill('198.18.220.1/32');
 await page.locator('label[for="sourcePolicyCopyInternal"]').click();
 const inventory = async () => (await (await page.request.get('/api/dashboard')).json()).inventory;
 const before = await inventory();
 const inspect = async () => { await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#sourcePolicyPreflight')).toContainText('预检通过'); await expect(page.locator('#sourcePolicyPreflight')).toBeVisible(); };
 const apply = async () => { await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('.source-policy-heading-status')).toContainText('已保存配置'); };
 await inspect(); expect(await inventory()).toEqual(before); await apply();
 const saved = (await inventory()).sourcePolicies.find((r: any) => r.label === label); expect(saved.groups[0].sources).toEqual(['198.18.220.1/32']);
 await page.getByRole('button', { name: '关闭', exact: true }).click();
 await page.getByRole('button', { name: `编辑源地址出口映射 ${label}`, exact: true }).click();
 await expect(page.locator('#sourcePolicyKernelTable0')).toHaveValue(String(saved.groups[0].kernelTable));
 await page.locator('#sourcePolicyGroup0').fill('10.10.0.201'); await page.locator('#sourcePolicySource0_0').fill('198.18.220.2/32'); await inspect(); await apply();
 for (const enabled of [false, true]) {
  await page.locator('label[for="sourcePolicyEnabled"]').click(); await inspect(); await apply();
  const current = (await inventory()).sourcePolicies.find((r: any) => r.id === saved.id); expect(current.enabled).toBe(enabled); expect(current.rulePriorityBase).toBe(saved.rulePriorityBase); expect(current.groups[0].id).toBe(saved.groups[0].id); expect(current.groups[0].kernelTable).toBe(saved.groups[0].kernelTable);
 }
 await page.getByRole('button', { name: '删除映射集', exact: true }).click(); await expect(page.locator('#sourcePolicyDialogTitle')).toHaveText('系统规则清理');
 expect((await inventory()).sourcePolicies.some((r: any) => r.id === saved.id)).toBe(false); expect(errors).toEqual([]);
});
