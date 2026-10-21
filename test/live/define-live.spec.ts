import { expect, test } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.request.post('/api/auth/logout'); });
test('Define real HTTP workflow creates, previews without writes, applies, reopens, edits and deletes', async ({ page }, info) => {
 page.on('dialog', d => d.accept()); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto('/'); await page.locator('#authPassword').fill('demo-admin-password'); await page.locator('#authSubmitButton').click(); await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click(); await page.locator('#resourceDefinesTab').click();
 await page.getByRole('button', { name: '+ 添加 Define', exact: true }).click();
 const name = `acceptance_${info.project.name}_${Date.now()}`;
 await page.locator('#policyResourceLabel').fill('Define 流程验收'); await page.locator('#policyResourceName').fill(name);
 await page.locator('#policyResourceSource').fill('198.18.100.0/24');
 await page.getByLabel('导入前缀文本').setInputFiles({ name: 'prefixes.txt', mimeType: 'text/plain', buffer: Buffer.from('[198.18.101.0/24]') });
 await expect(page.locator('#policyResourceSource')).toHaveValue('198.18.100.0/24\n198.18.101.0/24');
 const before = await (await page.request.get('/api/dashboard')).json();
 await page.getByRole('button', { name: '预检并查看变更', exact: true }).click(); await expect(page.locator('#definePreview')).toContainText('预检通过');
 const after = await (await page.request.get('/api/dashboard')).json(); expect(after.inventory.defines).toEqual(before.inventory.defines);
 await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
 const saved = await (await page.request.get('/api/dashboard')).json(); const resource = saved.inventory.defines.find((r: any) => r.name === name); expect(resource.entries).toEqual(['198.18.100.0/24', '198.18.101.0/24']);
 await page.getByRole('button', { name: `编辑 Define ${name}`, exact: true }).click(); await expect(page.locator('#policyResourceSource')).toHaveValue('198.18.100.0/24\n198.18.101.0/24');
 await page.locator('#policyResourceSource').fill('198.18.102.0/24'); await page.getByRole('button', { name: '预检并查看变更', exact: true }).click();
 await expect(page.locator('#definePreview')).toContainText('移除 2'); await expect(page.locator('#definePreview')).toContainText('新增 1');
 await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
 await page.getByRole('button', { name: `编辑 Define ${name}`, exact: true }).click(); await expect(page.locator('#policyResourceSource')).toHaveValue('198.18.102.0/24');
 for (const enabled of [false, true]) {
  await page.locator('label[for="policyResourceEnabled"]').click();
  await expect(page.locator('#policyResourceEnabled')).toBeChecked({ checked: enabled });
  await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toBeVisible();
  await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
  const inventory = (await (await page.request.get('/api/dashboard')).json()).inventory;
  expect(inventory.defines.find((r: any) => r.name === name).enabled).toBe(enabled);
  await page.getByRole('button', { name: `编辑 Define ${name}`, exact: true }).click();
 }
 await page.locator('#deletePolicyResourceButton').click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
 expect((await (await page.request.get('/api/dashboard')).json()).inventory.defines.some((r: any) => r.name === name)).toBe(false); expect(errors).toEqual([]);
});
