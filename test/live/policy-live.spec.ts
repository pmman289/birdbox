import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.request.post('/api/auth/logout'); });

for (const kind of ['functions', 'filters'] as const) {
 test(`${kind} shared editor: real HTTP create → readonly preview → apply → edit → disable/enable → delete`, async ({ page }, info) => {
  const title = kind === 'functions' ? 'Function' : 'Filter';
  const name = `accept_${kind}_${info.project.name}_${Date.now()}`;
  const source = (value: boolean) => kind === 'functions' ? `function ${name}() { return ${value}; }` : `filter ${name} { ${value ? 'accept' : 'reject'}; }`;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('/'); await page.locator('#authPassword').fill('demo-admin-password'); await page.locator('#authSubmitButton').click();
  await expect(page.locator('#appMain')).toBeVisible(); await page.locator('#resourceWorkspaceTab').click();
  await page.locator(kind === 'functions' ? '#resourceFunctionsTab' : '#resourceFiltersTab').click();
  await page.getByRole('button', { name: `+ 添加 ${title}`, exact: true }).click();
  await page.locator('#policyResourceLabel').fill(`${title} 验收`); await page.locator('#policyResourceName').fill(name);
  await page.locator('#policyResourceSource').fill(source(true));
  const resources = async () => (await (await page.request.get('/api/dashboard')).json()).inventory[kind];
  const before = await resources();
  await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toBeVisible();
  await expect(page.locator('#definePreview')).toContainText('预检通过'); expect(await resources()).toEqual(before);
  const apply = async () => {
   await page.getByRole('button', { name: '确认应用', exact: true }).click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
   await page.getByRole('button', { name: `编辑 ${title} ${name}`, exact: true }).click();
   await expect(page.locator('.define-heading-status')).toContainText('已保存配置');
  };
  await apply(); await expect(page.locator('#policyResourceSource')).toHaveValue(source(true));
  await page.locator('#policyResourceSource').fill(source(false));
  page.removeAllListeners('dialog'); page.once('dialog', d => d.dismiss());
  await page.locator('[data-close="policyResourceDialog"]').click(); await expect(page.locator('#policyResourceDialog')).toBeVisible();
  page.on('dialog', d => d.accept());
  await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toBeVisible(); await apply();
  await expect(page.locator('#policyResourceSource')).toHaveValue(source(false));
  for (const enabled of [false, true]) {
   await page.locator('label[for="policyResourceEnabled"]').click();
   await page.locator('#savePolicyResourceButton').click(); await expect(page.locator('#definePreview')).toContainText('预检通过');
   await apply(); expect((await resources()).find((r: any) => r.name === name).enabled).toBe(enabled);
  }
  await page.locator('#deletePolicyResourceButton').click(); await expect(page.locator('#policyResourceDialog')).not.toBeVisible();
  expect((await resources()).some((r: any) => r.name === name)).toBe(false); expect(errors).toEqual([]);
 });
}
