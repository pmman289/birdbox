import { expect, test } from '@playwright/test';
test.afterEach(async({page})=>{await page.request.post('/api/auth/logout');});
test('RPKI real HTTP create → preview without writes → apply → runtime/ROAs → edit/stop → delete',async({page},info)=>{
 page.on('dialog',d=>d.accept());const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.locator('#authPassword').fill('demo-admin-password');await page.locator('#authSubmitButton').click();await expect(page.locator('#appMain')).toBeVisible();await page.locator('#resourceWorkspaceTab').click();await page.locator('#resourceRpkiTab').click();
 await page.getByRole('button',{name:'+ 添加 RPKI',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();
 const name=`acceptance_rpki_${info.project.name}_${Date.now()}`;await page.locator('#rpkiLabel').fill('RPKI 完整流程验收');await page.locator('#rpkiName').fill(name);await page.locator('#rpkiRemote').fill('192.0.2.200');
 const before=(await(await page.request.get('/api/dashboard')).json()).inventory;
 await page.locator('#saveRpkiButton').click();await expect(page.locator('#rpkiPreview')).toContainText('预检通过');expect((await(await page.request.get('/api/dashboard')).json()).inventory).toEqual(before);
 await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();
 const saved=(await(await page.request.get('/api/dashboard')).json()).inventory.rpki.find((r:any)=>r.name===name);expect(saved.nodeIds).toHaveLength(1);
 await page.getByRole('button',{name:`查看 RPKI ${name} 运行态`,exact:true}).click();await expect(page.locator('#rpkiRuntimeDialog')).toContainText('Established');await expect(page.locator('#rpkiRuntimeDialog')).toContainText('203.0.113.0/24');await page.getByLabel('ROA 查询地址族').selectOption('ipv6');await expect(page.locator('#rpkiRuntimeDialog')).toContainText('2001:db8::/32');
 await page.getByRole('button',{name:'编辑配置',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();await expect(page.locator('#rpkiRemote')).toHaveValue('192.0.2.200');await expect(page.locator('.rpki-edit-state')).toContainText('已保存');await page.locator('label[for=rpkiEnabled]').click();
 await page.locator('#saveRpkiButton').click();await expect(page.locator('#rpkiPreview')).toContainText('预检通过');await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();
 await page.getByRole('button',{name:`查看 RPKI ${name} 运行态`,exact:true}).click();await expect(page.locator('#rpkiRuntimeDialog')).toContainText('配置已停用');await page.getByRole('button',{name:'编辑配置',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();await page.locator('#deleteRPKIButton').click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();
 expect((await(await page.request.get('/api/dashboard')).json()).inventory.rpki.some((r:any)=>r.name===name)).toBe(false);expect(errors).toEqual([]);
});
