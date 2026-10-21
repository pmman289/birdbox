import { expect, test, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.request.post('/api/auth/logout'); });
async function fixture(page: Page) {
 const source = { id:'rpki_demo', label:'业务验证缓存', name:'demo_rtr', nodeIds:['local'], sourceType:'server', enabled:true, roa4Table:'DEMO_ROA4',roa6Table:'DEMO_ROA6',remote:'192.0.2.100',port:323,localAddress:null,transport:'tcp',authentication:'md5',password:'********',refresh:null,retry:null,expire:null,minVersion:null,maxVersion:null,ignoreMaxLength:'default',keepRefresh:false,keepRetry:false,keepExpire:false,birdPrivateKey:null,remotePublicKey:null,user:null };
 let currentNodeId='local';
 let resources: any[] = [source], revision=1, failure='', valid=true, hold=false;
 let release=()=>{}, barrier=Promise.resolve(); const writes:any[]=[],previews:any[]=[],errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/dashboard**',async route=>{const response=await route.fetch();const data=await response.json();currentNodeId=data.node?.id??data.inventory.nodes[0]?.id;data.inventory.rpki=resources;await route.fulfill({response,json:data});});
 await page.route('**/api/rpki/editor-context*',route=>{const id=new URL(route.request().url()).searchParams.get('id');return route.fulfill({json:{inventoryRevision:revision,resource:resources.find(r=>r.id===id)??null,references:[]}});});
 await page.route('**/api/rpki/preview',async route=>{
  const b=route.request().postDataJSON();previews.push(b);if(hold)await barrier;
  if(b.inventoryRevision!==revision)return route.fulfill({status:409,json:{code:'STATE_CONFLICT',error:'库存已变化，草稿保留'}});
  const resource={...source,...b,id:b.id??'rpki_new',...(b.authentication==='md5'?{password:'********'}:{password:null})};
  await route.fulfill({json:{valid,previewId:'preflight',candidateHash:'candidate',inventoryRevision:revision,resource,references:[],configs:[{nodeId:'local',config:'SERVER_RPKI_CONFIG',diff:'+ SERVER_RPKI_DIFF',validation:{ok:valid,stdout:'',stderr:valid?'':'节点不支持此传输方式'}}]}});
 });
 await page.route(/\/api\/rpki(?:\/[^/?]+)?$/,async route=>{
  const path=new URL(route.request().url()).pathname;if(path.endsWith('/preview')||path.endsWith('/editor-context'))return route.fallback();
  const method=route.request().method(),b=route.request().postDataJSON();writes.push({method,...b});
  if(failure){const code=failure;failure='';if(code==='STATE_CONFLICT'){revision++;resources[0].label='服务端最新备注';}return route.fulfill({status:409,json:{code,error:code==='STATE_CONFLICT'?'库存已变化，草稿保留':'部署失败，已回滚'}});}
  resources=method==='DELETE'?[]:[{...b,id:method==='POST'?'rpki_new':'rpki_demo'}];revision++;await route.fulfill({json:{deployment:{applied:true},resource:resources[0]}});
 });
 await page.route('**/api/rpki/*/runtime',route=>route.fulfill({json:{resourceId:'rpki_demo',nodes:[{nodeId:'local',lastCheckedAt:new Date().toISOString(),protocols:[{name:'demo_rtr',state:'start',rtrState:'Transport-Error',channels:[{family:'ipv4',table:'DEMO_ROA4',state:'DOWN',imported:7}],raw:'RPKI_RAW_DETAILS',error:null}]},{nodeId:'edge',lastCheckedAt:new Date().toISOString(),protocols:[{name:'demo_rtr',state:'error',channels:[],raw:'',error:'节点超时'}]}]}}));
 await page.route('**/api/rpki/*/roas*',route=>{const family=new URL(route.request().url()).searchParams.get('family');return route.fulfill({json:{resourceId:'rpki_demo',nodeId:'local',family,table:family==='ipv6'?'DEMO_ROA6':'DEMO_ROA4',entries:[{prefix:family==='ipv6'?'2001:db8::/32':'203.0.113.0/24',maxLength:family==='ipv6'?48:28,asn:64512,protocol:'demo_rtr',raw:'ROA_RAW'}],truncated:true,limit:200}});});
 await page.goto('/');await expect(page.locator('#authTitle')).toHaveText(/^(设置管理密码|登录 Birdbox)$/);await page.locator('#authPassword').fill('playwright-admin-password');if(await page.locator('#authTitle').textContent()==='设置管理密码')await page.locator('#authConfirmation').fill('playwright-admin-password');await page.locator('#authSubmitButton').click();await expect(page.locator('#appMain')).toBeVisible();
 await page.locator('#resourceWorkspaceTab').click();await page.locator('#resourceRpkiTab').click();
 return {writes,previews,errors,get currentNodeId(){return currentNodeId;},fail(code='STATE_CONFLICT'){failure=code;},invalid(){valid=false;},removeElsewhere(){resources=[];revision++;},hold(){hold=true;barrier=new Promise(r=>{release=r;});},release(){hold=false;release();}};
}
async function edit(page:Page){await page.getByRole('button',{name:'编辑 RPKI demo_rtr',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();}
async function inspect(page:Page){await page.getByRole('button',{name:'预检并查看变更',exact:true}).click();await expect(page.locator('#rpkiPreview')).toBeVisible();}
test('RPKI create defaults → readonly preview → confirm → reopen → single stack → stop → delete',async({page})=>{
 const h=await fixture(page);page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'+ 添加 RPKI',exact:true}).click();
 await expect(page.locator('#rpkiSourceType')).toHaveValue('server');await expect(page.locator('#rpkiNodeScope input[value=selected]')).toBeChecked();await expect(page.locator(`#rpkiNodeScope .policy-scope-node input[value="${h.currentNodeId}"]`)).toBeChecked();await expect(page.locator('#rpkiDialog details[open]')).toHaveCount(0);
 await page.locator('#rpkiLabel').fill('创建验收');await page.locator('#rpkiName').fill('acceptance_rtr');await page.locator('#rpkiRemote').fill('192.0.2.5');await inspect(page);expect(h.writes).toHaveLength(0);await expect(page.locator('#rpkiPreview')).toContainText('SERVER_RPKI_DIFF');await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();expect(h.writes[0]).toMatchObject({mode:'apply',previewId:'preflight',inventoryRevision:1,nodeIds:[h.currentNodeId]});
 await page.getByRole('button',{name:'编辑 RPKI acceptance_rtr',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();await expect(page.locator('.rpki-edit-state')).toContainText('已保存');
 await page.getByLabel('启用 IPv4 ROA',{exact:true}).uncheck();await inspect(page);expect(h.previews.at(-1).roa4Table).toBeNull();expect(h.previews.at(-1).roa6Table).toBeTruthy();await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();
 await page.getByRole('button',{name:'编辑 RPKI acceptance_rtr',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();await page.locator('label[for=rpkiEnabled]').click();await inspect(page);await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();expect(h.writes.at(-1).enabled).toBe(false);
 await page.getByRole('button',{name:'编辑 RPKI acceptance_rtr',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();await page.locator('#deleteRPKIButton').click();await expect(page.locator('#rpkiDialog')).not.toBeVisible();expect(h.writes.at(-1).method).toBe('DELETE');expect(h.errors).toEqual([]);
});
test('RPKI source and transport switching preserves independent ports, keys, passwords and hidden family fields',async({page})=>{
 const h=await fixture(page);await edit(page);await page.locator('#rpkiPassword').fill('typed-demo-secret');await page.locator('#rpkiPort').fill('3323');await page.locator('#rpkiTransport').selectOption('ssh');await expect(page.locator('#rpkiPort')).toHaveValue('22');
 await page.locator('#rpkiBirdPrivateKey').fill('/etc/bird/private');await page.locator('#rpkiRemotePublicKey').fill('/etc/bird/public');await page.locator('#rpkiUser').fill('bird');await page.locator('#rpkiPort').fill('2222');
 await page.locator('#rpkiTransport').selectOption('tcp');await expect(page.locator('#rpkiPassword')).toHaveValue('typed-demo-secret');await expect(page.locator('#rpkiPort')).toHaveValue('3323');await page.locator('#rpkiTransport').selectOption('ssh');await expect(page.locator('#rpkiPort')).toHaveValue('2222');await expect(page.locator('#rpkiBirdPrivateKey')).toHaveValue('/etc/bird/private');
 await page.locator('#rpkiSourceType').selectOption('file');await page.locator('#rpkiFile4').fill('/etc/bird/roa4.conf');await page.locator('#rpkiFile6').fill('/etc/bird/roa6.conf');await page.getByLabel('启用 IPv6 ROA',{exact:true}).uncheck();await inspect(page);expect(h.previews.at(-1)).toMatchObject({sourceType:'file',file4:'/etc/bird/roa4.conf',file6:null,roa6Table:null});
 await page.getByLabel('启用 IPv6 ROA',{exact:true}).check();await expect(page.locator('#rpkiFile6')).toHaveValue('/etc/bird/roa6.conf');await page.locator('#rpkiSourceType').selectOption('server');await expect(page.locator('#rpkiBirdPrivateKey')).toHaveValue('/etc/bird/private');expect(h.writes).toHaveLength(0);expect(h.errors).toEqual([]);
});
test('RPKI unsaved Escape protection, stale previews discarded and deployment failure retains edits',async({page})=>{
 const h=await fixture(page);await edit(page);await page.locator('#rpkiLabel').fill('本地修改');page.once('dialog',d=>d.dismiss());await page.keyboard.press('Escape');await expect(page.locator('#rpkiDialog')).toBeVisible();
 h.hold();await page.getByRole('button',{name:'预检并查看变更',exact:true}).click();await expect.poll(()=>h.previews.length).toBe(1);await page.locator('#rpkiRemote').fill('192.0.2.9');h.release();await expect(page.locator('#rpkiPreview')).toHaveCount(0);
 await inspect(page);h.fail('DEPLOYMENT_FAILED');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('#rpkiDialog')).toContainText('部署失败，已回滚');await expect(page.locator('#rpkiRemote')).toHaveValue('192.0.2.9');await expect(page.locator('#saveRpkiButton')).toBeEnabled();expect(h.errors).toEqual([]);
});
test('RPKI CAS conflict preserves local fields, masks typed secrets and rebases before retry',async({page})=>{
 const h=await fixture(page);await edit(page);await page.locator('#rpkiLabel').fill('本地备注');await page.locator('#rpkiPassword').fill('typed-demo-secret');await inspect(page);h.fail();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'确认应用',exact:true}).click();
 await page.getByRole('button',{name:'加载最新版本并对比',exact:true}).click();const compare=page.getByRole('region',{name:'RPKI 库存冲突对比'});await expect(compare).toContainText('服务端最新备注');await expect(compare).not.toContainText('typed-demo-secret');await page.getByRole('button',{name:'保留草稿，重新预检',exact:true}).click();await expect(page.locator('#rpkiLabel')).toHaveValue('本地备注');await inspect(page);expect(h.previews.at(-1).inventoryRevision).toBe(2);expect(h.errors).toEqual([]);
});
test('RPKI runtime distinguishes stale ROAs from RTR state, isolates nodes, switches ROA family and jumps to config',async({page})=>{
 const h=await fixture(page);await page.getByRole('button',{name:'查看 RPKI demo_rtr 运行态',exact:true}).click();await expect(page.locator('#rpkiRuntimeDialog')).toContainText('Transport-Error');await expect(page.locator('#rpkiRuntimeDialog')).toContainText('节点超时');await expect(page.locator('#rpkiRuntimeDialog')).toContainText('203.0.113.0/24');
 await page.getByLabel('ROA 查询地址族').selectOption('ipv6');await expect(page.locator('#rpkiRuntimeDialog')).toContainText('2001:db8::/32');await expect(page.locator('#rpkiRuntimeDialog')).not.toContainText('203.0.113.0/24');await expect(page.locator('#rpkiRuntimeDialog')).toContainText('已截断');await page.getByLabel('搜索 ROA 前缀或 ASN').fill('64512');await expect(page.locator('.rpki-roa-table')).toContainText('AS64512');
 await page.getByRole('button',{name:'编辑配置',exact:true}).click();await expect(page.locator('#saveRpkiButton')).toBeEnabled();h.invalid();await inspect(page);await expect(page.locator('#rpkiPreview')).toContainText('节点不支持此传输方式');await expect(page.getByRole('button',{name:'确认应用',exact:true})).toHaveCount(0);expect(h.writes).toHaveLength(0);expect(h.errors).toEqual([]);
});
test('RPKI deleted elsewhere recovers as new draft without automatically applying',async({page})=>{
 const h=await fixture(page);await edit(page);await page.locator('#rpkiRemote').fill('192.0.2.9');h.removeElsewhere();await page.getByRole('button',{name:'预检并查看变更',exact:true}).click();await page.getByRole('button',{name:'加载最新版本并对比',exact:true}).click();await expect(page.getByRole('region',{name:'RPKI 库存冲突对比'})).toContainText('资源已被删除');await page.getByRole('button',{name:'保留草稿，作为新资源预检',exact:true}).click();await expect(page.locator('#rpkiDialogTitle')).toHaveText('添加 RPKI 资源');await expect(page.locator('#rpkiRemote')).toHaveValue('192.0.2.9');await expect(page.locator('#rpkiPassword')).toHaveAttribute('required','');expect(h.writes).toHaveLength(0);
});
test('RPKI editor and runtime remain usable at 375/390/430px with sticky actions and contained ROA table scrolling',async({page})=>{
 await fixture(page);await edit(page);
 for(const width of [375,390,430]){
  await page.setViewportSize({width,height:844});
  const scope=await page.locator('#rpkiNodeScope').evaluate(el=>{
   const search=el.querySelector('input[type=search]')!.getBoundingClientRect(),node=el.querySelector('.policy-scope-node')!,checkbox=node.querySelector('input')!.getBoundingClientRect(),text=node.querySelector('span')!.getBoundingClientRect();
   return {searchHeight:search.height,checkboxRight:checkbox.right,textLeft:text.left,checkboxCenter:(checkbox.top+checkbox.bottom)/2,textTop:text.top,textBottom:text.bottom};
  });
  expect(scope.searchHeight).toBeLessThanOrEqual(44);expect(scope.textLeft).toBeGreaterThan(scope.checkboxRight);expect(scope.checkboxCenter).toBeGreaterThanOrEqual(scope.textTop);expect(scope.checkboxCenter).toBeLessThanOrEqual(scope.textBottom);
  await inspect(page);const size=await page.locator('#rpkiDialog').evaluate(el=>({overflow:el.scrollWidth-el.clientWidth,outerScroll:el.scrollTop,head:el.querySelector('header')!.getBoundingClientRect().top,foot:el.querySelector('footer')!.getBoundingClientRect().bottom,content:el.querySelector('.rpki-editor-content')!.clientHeight}));expect(size.overflow).toBe(0);expect(size.outerScroll).toBe(0);expect(size.head).toBeGreaterThanOrEqual(0);expect(size.foot).toBeLessThanOrEqual(844);expect(size.content).toBeGreaterThan(300);await expect(page.getByRole('button',{name:'确认应用',exact:true})).toBeInViewport();await page.locator('#rpkiRemote').fill(`192.0.2.${width===375?2:width===390?3:4}`);
 }
});
