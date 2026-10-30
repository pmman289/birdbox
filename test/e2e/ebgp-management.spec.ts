import { expect, test, type Page } from '@playwright/test';
test.afterEach(async({page})=>{await page.unrouteAll({behavior:'ignoreErrors'});await page.request.post('/api/auth/logout');});
async function fixture(page:Page){
 let saved:any, seed:any, revision=1, failure='', loseResponse=false, valid=true, hold=false, release=()=>{};let barrier=Promise.resolve();const writes:any[]=[],previews:any[]=[],errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/dashboard**',async r=>{const response=await r.fetch(),d=await response.json();if(saved===undefined){seed=structuredClone(d.inventory.sessions[0]);saved=structuredClone(seed);}d.inventory.sessions=saved?[saved]:[];d.peers=d.peers.map((p:any)=>({...p,session:p.id===seed.peerId?saved:null}));d.selectedPeer=d.peers.find((p:any)=>p.id===d.selection.peerId)??null;await r.fulfill({response,json:d});});
 await page.route('**/api/nodes/*/runtime',async r=>{const response=await r.fetch(),d=await response.json();d.sessions=saved?[saved]:[];await r.fulfill({response,json:d});});
 await page.route('**/api/sessions/editor-context*',r=>r.fulfill({json:{inventoryRevision:revision,session:saved??null}}));
 await page.route('**/api/sessions/preview',async r=>{const b=r.request().postDataJSON();previews.push(b);if(hold)await barrier;if(b.inventoryRevision!==revision)return r.fulfill({status:409,json:{code:'STATE_CONFLICT',error:'库存已变化，草稿已保留'}});const session={...seed,...b,id:saved?.id??'ebgp_new'};for(const k of['inventoryRevision','previewId','candidateHash','mode'])delete session[k];await r.fulfill({status:valid?200:422,json:{valid,inventoryRevision:revision,previewId:'preview',candidateHash:'hash',session,config:`protocol bgp ${b.protocolName} { local ${b.localAddress} as ${b.localAsn}; }`,sessionConfig:`protocol bgp ${b.protocolName} { local ${b.localAddress} as ${b.localAsn}; }`,previousConfig:'OLD',diff:'+ SERVER_REVIEWED_DIFF',validation:{ok:valid,stdout:'',stderr:valid?'':'原生预检失败'},error:valid?undefined:'原生预检失败',events:[]}});});
 await page.route('**/api/sessions/apply',async r=>{const b=r.request().postDataJSON();writes.push(b);if(failure){const code=failure;failure='';return r.fulfill({status:code==='STATE_CONFLICT'?409:500,json:{code,error:code==='STATE_CONFLICT'?'库存已变化，草稿已保留':'部署失败，已回滚'}});}saved={...b,id:saved?.id??'ebgp_new'};for(const k of['inventoryRevision','previewId','candidateHash','mode'])delete saved[k];revision++;if(loseResponse){loseResponse=false;return r.abort('connectionreset');}await r.fulfill({json:{applied:true,enabled:saved.enabled,established:false,session:saved,config:'APPLIED',sessionConfig:'APPLIED_SESSION',events:[]}});});
 await page.route(/\/api\/sessions\/[^/?]+$/,r=>{if(r.request().method()!=='DELETE')return r.fallback();writes.push({method:'DELETE',...r.request().postDataJSON()});saved=null;revision++;return r.fulfill({json:{inventory:{sessions:[]},events:[]}});});
 await page.goto('/');await expect(page.locator('#authTitle')).toHaveText(/^(设置管理密码|登录 Birdbox)$/);await page.locator('#authPassword').fill('playwright-admin-password');if(await page.locator('#authTitle').textContent()==='设置管理密码')await page.locator('#authConfirmation').fill('playwright-admin-password');await page.locator('#authSubmitButton').click();await expect(page.locator('#protocolName')).toHaveValue('e2e_peer');await expect(page.getByRole('button',{name:'应用会话变更',exact:true})).toBeEnabled();
 return {writes,previews,errors,fail(code='DEPLOYMENT_FAILED'){failure=code;},loseNext(){loseResponse=true;},invalid(){valid=false;},hold(){hold=true;barrier=new Promise(r=>{release=r;});},release(){hold=false;release();},remoteChange(){revision++;saved={...saved,localAsn:64599};}};
}
const local=(page:Page)=>page.locator('#sessionEditorApp [data-field=localAddress] input');
async function ready(page:Page){await expect(page.getByRole('button',{name:'预检配置',exact:true})).toBeEnabled();}
async function preflight(page:Page){await ready(page);await page.getByRole('button',{name:'预检配置',exact:true}).click();await expect(page.locator('.session-change-summary')).toContainText('SERVER_REVIEWED_DIFF');await ready(page);}
async function apply(page:Page){await ready(page);await page.getByRole('button',{name:'应用会话变更',exact:true}).click();await expect(page.getByRole('dialog',{name:'应用节点会话配置'})).toBeVisible();await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.getByRole('dialog',{name:'应用节点会话配置'})).not.toBeVisible();await expect(page.getByTestId('session-draft-state')).toHaveText('已保存配置');}

test('eBGP preview and refresh preserve unsaved draft; cancel switching and explicitly discard',async({page})=>{
 const h=await fixture(page);await local(page).fill('192.0.2.10');await preflight(page);await expect(page.getByTestId('session-draft-state')).toHaveText('有未应用修改');expect(h.writes).toHaveLength(0);
 await page.locator('#refreshButton').click();await expect(page.locator('#refreshButton')).toBeEnabled();await expect(local(page)).toHaveValue('192.0.2.10');
 page.once('dialog',d=>d.dismiss());await page.locator('#resourceWorkspaceTab').click();await expect(page.locator('#sessionWorkspace')).toBeVisible();await expect(local(page)).toHaveValue('192.0.2.10');
 page.once('dialog',d=>d.dismiss());await page.locator('#nodeSelect').selectOption('edge');await expect(page.locator('#nodeSelect')).toHaveValue('local');await expect(local(page)).toHaveValue('192.0.2.10');
 page.once('dialog',d=>d.accept());await page.locator('#resourceWorkspaceTab').click();await expect(page.locator('#resourceWorkspace')).toBeVisible();await page.locator('#sessionWorkspaceTab').click();await expect(local(page)).toHaveValue('192.0.2.1');expect(h.errors).toEqual([]);
});
test('eBGP reviewed apply → independent dual family → disable → remove → create',async({page})=>{
 const h=await fixture(page);await local(page).fill('192.0.2.10');await preflight(page);expect(h.writes).toHaveLength(0);await apply(page);expect(h.writes[0]).toMatchObject({mode:'apply',previewId:'preview',candidateHash:'hash',inventoryRevision:1,localAddress:'192.0.2.10'});
 await page.locator('#sessionEditorApp .afi-tab').filter({hasText:'IPv6'}).click();await page.locator('[data-family=ipv6] .channel-enable-row .compact-toggle').click();await preflight(page);await apply(page);expect(h.writes.at(-1).channels.ipv4.enabled).toBe(true);expect(h.writes.at(-1).channels.ipv6.enabled).toBe(false);
 await page.locator('.session-enabled-row').click();await preflight(page);await apply(page);expect(h.writes.at(-1).enabled).toBe(false);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'移除当前会话',exact:true}).click();await expect(page.getByRole('button',{name:'移除当前会话',exact:true})).toHaveCount(0);await expect(page.getByTestId('session-draft-state')).toHaveText('已保存配置');
 await page.locator('#protocolName').fill('fresh_ebgp');await page.locator('#sessionEditorApp [data-field=localAsn] input').fill('64512');await local(page).fill('192.0.2.1');await preflight(page);await apply(page);expect(h.writes.at(-1).protocolName).toBe('fresh_ebgp');expect(h.errors).toEqual([]);
});
test('eBGP deployment failure retains content, conflict compares and rebases before a new reviewed apply',async({page})=>{
 const h=await fixture(page);await local(page).fill('192.0.2.19');await preflight(page);h.fail();await page.getByRole('button',{name:'应用会话变更',exact:true}).click();await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('.session-form-error')).toContainText('部署失败');await expect(local(page)).toHaveValue('192.0.2.19');await expect(page.getByTestId('session-draft-state')).toHaveText('有未应用修改');
 h.remoteChange();await preflightConflict(page);await page.getByRole('button',{name:'加载最新版本并对比',exact:true}).click();await expect(page.getByRole('region',{name:'eBGP 冲突对比'})).toContainText('64599');await expect(local(page)).toHaveValue('192.0.2.19');await page.getByRole('button',{name:'保留草稿，重新预检',exact:true}).click();await preflight(page);expect(h.previews.at(-1).inventoryRevision).toBe(2);await apply(page);expect(h.errors).toEqual([]);
});
async function preflightConflict(page:Page){await ready(page);await page.getByRole('button',{name:'预检配置',exact:true}).click();await expect(page.getByRole('button',{name:'加载最新版本并对比',exact:true})).toBeVisible();}
test('eBGP peer workspace searches, filters and switches to mobile detail',async({page})=>{
 await fixture(page);
 const rows=page.locator('#dashboardOverviewApp .ebgp-peer-row');
 await expect(rows).not.toHaveCount(0);
 await page.locator('#ebgpPeerSearch').fill('Documentation Peer');
 await expect(rows).toHaveCount(1);
 await expect(rows.first()).toContainText('Documentation Peer With An Intentionally Long Remote Name');
 await page.locator('#ebgpConfigFilter').selectOption('configured');
 await expect(rows).toHaveCount(1);
 await page.locator('#ebgpConfigFilter').selectOption('unconfigured');
 await expect(page.locator('#dashboardOverviewApp .ebgp-list-empty')).toContainText('没有匹配');
 await page.locator('#ebgpPeerSearch').fill('');
 await page.locator('#ebgpConfigFilter').selectOption('all');
 await page.locator('#ebgpStatusFilter').selectOption('established');
 await expect(page.locator('#dashboardOverviewApp .ebgp-peer-list, #dashboardOverviewApp .ebgp-list-empty')).toHaveCount(1);
 await page.locator('#ebgpStatusFilter').selectOption('all');
 await page.setViewportSize({width:390,height:844});
 await rows.first().click();
 await expect(page.locator('#dashboardOverviewApp .ebgp-workbench')).toHaveClass(/mobile-detail-open/);
 await expect(page.locator('#dashboardOverviewApp .ebgp-peer-detail-panel')).toBeVisible();
 await page.getByRole('button',{name:/返回 Peer 列表/}).click();
 await expect(page.locator('#dashboardOverviewApp .ebgp-workbench')).not.toHaveClass(/mobile-detail-open/);
});
test('eBGP discards stale preview, rejects invalid configuration, and remains within 375/390/430px',async({page})=>{
 const h=await fixture(page);await ready(page);h.hold();await local(page).fill('192.0.2.31');await expect.poll(()=>h.previews.some(p=>p.localAddress==='192.0.2.31')).toBe(true);await local(page).fill('192.0.2.32');h.release();await expect(page.locator('#localConfig')).toContainText('192.0.2.32');await expect(page.getByTestId('session-draft-state')).toHaveText('有未应用修改');
 for(const width of[375,390,430]){await page.setViewportSize({width,height:844});const geometry=await page.locator('#sessionEditorApp').evaluate(el=>({doc:document.documentElement.scrollWidth,view:document.documentElement.clientWidth,width:el.getBoundingClientRect().width}));expect(geometry.doc).toBeLessThanOrEqual(geometry.view);expect(geometry.width).toBeLessThanOrEqual(width);await expect(page.getByRole('button',{name:'应用会话变更',exact:true})).toBeVisible();}
 h.invalid();await ready(page);await page.getByRole('button',{name:'预检配置',exact:true}).click();await expect(page.locator('.session-form-error')).toContainText('原生预检失败');await page.getByRole('button',{name:'应用会话变更',exact:true}).click();await expect(page.getByRole('dialog',{name:'应用节点会话配置'})).not.toBeVisible();expect(h.writes).toHaveLength(0);expect(h.errors).toEqual([]);
});

test('eBGP lost apply response reconciles saved server state without submitting twice',async({page})=>{
 const h=await fixture(page);await local(page).fill('192.0.2.44');await preflight(page);h.loseNext();
 await apply(page);expect(h.writes).toHaveLength(1);await expect(local(page)).toHaveValue('192.0.2.44');await expect(page.locator('.toast-region')).toContainText('会话变更已生效');expect(h.errors).toEqual([]);
});
test('eBGP policy summaries start collapsed, preserve both directions/families and reveal invalid hidden fields',async({page})=>{
 const h=await fixture(page);const v4=page.locator('[data-family=ipv4]'),imports=v4.locator('.channel-policy-disclosure').nth(0),exports=v4.locator('.channel-policy-disclosure').nth(1);
 await expect(v4.locator('.channel-policy-disclosure[open]')).toHaveCount(0);await expect(imports.locator('summary')).toContainText('接收全部');
 await imports.locator('summary').click();await imports.locator('.policy-form-fields select').first().selectOption('none');await exports.locator('summary').click();await exports.locator('.policy-form-fields select').first().selectOption('all');await imports.locator('summary').click();await exports.locator('summary').click();
 await page.locator('#sessionEditorApp .afi-tab').filter({hasText:'IPv6'}).click();await expect(page.locator('[data-family=ipv6] .channel-policy-disclosure').first().locator('summary')).toContainText('接收全部');await preflight(page);expect(h.previews.at(-1).channels.ipv4.importPolicy.formAction).toBe('none');expect(h.previews.at(-1).channels.ipv4.exportPolicy.formAction).toBe('all');expect(h.previews.at(-1).channels.ipv6.importPolicy.formAction).toBe('all');
 await page.locator('#sessionEditorApp .afi-tab').filter({hasText:'IPv4'}).click();await expect(imports.locator('summary')).toContainText('禁止接收');await exports.locator('summary').click();await exports.locator('label').filter({hasText:'自定义'}).click();await exports.locator('summary').click();await page.locator('#sessionEditorApp .afi-tab').filter({hasText:'IPv6'}).click();await ready(page);await page.getByRole('button',{name:'预检配置',exact:true}).click();await expect(exports).toHaveAttribute('open','');await expect(v4).toBeVisible();expect(h.writes).toHaveLength(0);expect(h.errors).toEqual([]);
});
test('eBGP editor version request can be retried without discarding typed fields',async({page})=>{
 const h=await fixture(page);let failOnce=true;await page.route('**/api/sessions/editor-context*',async r=>{if(!failOnce)return r.fallback();failOnce=false;await r.fulfill({status:503,json:{error:'编辑版本服务暂时不可用'}});});
 await page.getByRole('button',{name:'重新加载已保存配置',exact:true}).click();await expect(page.getByRole('button',{name:'重试读取编辑版本',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'应用会话变更',exact:true})).toBeDisabled();
 await local(page).fill('192.0.2.61');await page.getByRole('button',{name:'重试读取编辑版本',exact:true}).click();await expect(page.getByRole('button',{name:'重试读取编辑版本',exact:true})).toHaveCount(0);await expect(local(page)).toHaveValue('192.0.2.61');expect(h.writes).toHaveLength(0);expect(h.errors).toEqual([]);
});
test('eBGP invalidated preview never appears as the saved configuration while the next preview is pending',async({page})=>{
 const h=await fixture(page);await local(page).fill('192.0.2.10');await preflight(page);await expect(page.locator('#localConfig')).toContainText('192.0.2.10');
 h.hold();await local(page).fill('192.0.2.12');await expect.poll(()=>h.previews.some(p=>p.localAddress==='192.0.2.12')).toBe(true);await expect(page.locator('#localConfig')).not.toContainText('192.0.2.10');await expect(page.locator('#localConfig')).toContainText('192.0.2.1');expect(h.writes).toHaveLength(0);h.release();await expect(page.locator('#localConfig')).toContainText('192.0.2.12');expect(h.errors).toEqual([]);
});

test('eBGP guided sections keep context and expose reviewed actions at narrow widths', async ({ page }) => {
 const h = await fixture(page);
 const workflow = page.getByRole('navigation', { name: 'eBGP 配置步骤' });
 await expect(workflow.getByRole('button')).toHaveCount(3);
 await local(page).fill('192.0.2.73');
 await workflow.getByRole('button', { name: /路由策略/ }).click();
 await expect(page.locator('[data-workflow-section=channels]')).toBeFocused();
 await expect(page.locator('[data-family=ipv4] .channel-policy-disclosure[open]')).toHaveCount(0);
 await workflow.getByRole('button', { name: /基础连接/ }).click();
 await expect(local(page)).toHaveValue('192.0.2.73');
 await preflight(page);
 await expect(workflow).toContainText('当前草稿已通过预检');
 for (const width of [375, 390, 430]) {
  await page.setViewportSize({ width, height: 844 });
  await page.locator('[data-workflow-section=channels]').scrollIntoViewIfNeeded();
  await expect(page.getByRole('region', { name: 'eBGP 配置操作' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 }
 expect(h.writes).toHaveLength(0);
 expect(h.errors).toEqual([]);
});

test('eBGP background preflight leaves other fields clickable while preserving candidate binding', async ({ page }) => {
 const h = await fixture(page); await ready(page); h.hold();
 await local(page).fill('192.0.2.81');
 await expect.poll(() => h.previews.some(p => p.localAddress === '192.0.2.81')).toBe(true);
 await expect(page.locator('.session-preview-overlay')).toBeVisible();
 const asn = page.locator('#sessionEditorApp [data-field=localAsn] input');
 await asn.click(); await asn.fill('64520');
 await expect(asn).toHaveValue('64520');
 await expect(page.getByRole('button', { name: '应用会话变更', exact: true })).toBeDisabled();
 h.release(); await preflight(page);
 expect(h.previews.at(-1)).toMatchObject({ localAddress: '192.0.2.81', localAsn: 64520 });
 expect(h.writes).toHaveLength(0); expect(h.errors).toEqual([]);
});

test('eBGP Apply waits for a competing preflight and still requires reviewed confirmation', async ({ page }) => {
 const h = await fixture(page); await ready(page);
 await local(page).fill('192.0.2.85'); await preflight(page);
 h.hold();
 // Start a check at the click boundary, reproducing a debounce competing
 // with Apply without bypassing disabled controls or repeating the click.
 await page.getByRole('button', { name: '应用会话变更', exact: true }).evaluate(button => {
  button.addEventListener('click', () => button.closest('form')?.requestSubmit(), { capture: true, once: true });
 });
 const count = h.previews.length;
 await page.getByRole('button', { name: '应用会话变更', exact: true }).click();
 await expect.poll(() => h.previews.length).toBeGreaterThan(count);
 await expect(page.getByRole('dialog', { name: '应用节点会话配置' })).not.toBeVisible();
 expect(h.writes).toHaveLength(0); h.release();
 await expect(page.getByRole('dialog', { name: '应用节点会话配置' })).toBeVisible();
 await page.getByRole('button', { name: '确认应用', exact: true }).click();
 await expect(page.getByTestId('session-draft-state')).toHaveText('已保存配置');
 expect(h.writes).toHaveLength(1);
 expect(h.writes[0]).toMatchObject({ localAddress: '192.0.2.85', previewId: 'preview', candidateHash: 'hash' });
 expect(h.errors).toEqual([]);
});
