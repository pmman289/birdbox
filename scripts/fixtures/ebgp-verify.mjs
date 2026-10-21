import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cookie=await fs.readFile('/verification/cookie','utf8'),nodeId='node_installer_e2e';
async function api(path,method='GET',body,status=200){const r=await fetch(`http://127.0.0.1:3000${path}`,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const v=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(v)}`);return v;}
async function until(check,message){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,200));}assert.fail(message);}
const accepted=p=>({...p.session,mode:'apply',inventoryRevision:p.inventoryRevision,previewId:p.previewId,candidateHash:p.candidateHash});
const peer=(await api(`/api/nodes/${nodeId}/peers`,'POST',{name:'Native remote',address:'192.0.2.2',asn:64513,port:1179},201)).peer;
const context=()=>api(`/api/sessions/editor-context?nodeId=${nodeId}&peerId=${peer.id}`);
const payload={nodeId,peerId:peer.id,protocolName:'native_ebgp',localAddress:'192.0.2.1',localAsn:64512,localPort:179,bgp:{strictBind:true}};
const before=(await api('/api/dashboard')).inventory;
const p=await api('/api/sessions/preview','POST',{...payload,inventoryRevision:(await context()).inventoryRevision});assert.ok(p.valid);assert.deepEqual((await api('/api/dashboard')).inventory,before);
const saved=(await api('/api/sessions/apply','POST',accepted(p),202)).session;
assert.equal((await api(`/api/dashboard?nodeId=${nodeId}&peerId=${peer.id}`)).config,p.config);
const protocol=()=>api(`/api/sessions/${saved.id}/protocol`);
await until(async()=>/BGP state:\s+Established/.test((await protocol()).output),'Native eBGP dual stack neighbor must establish');
const routes=family=>api(`/api/sessions/${saved.id}/routes?family=${family}&direction=import`);
await until(async()=>(await routes('ipv4')).routes.some(r=>r.prefix==='203.0.113.0/24'),'Actual IPv4 imported route');
await until(async()=>(await routes('ipv6')).routes.some(r=>r.prefix==='2001:db8:100::/48'),'Actual IPv6 imported route');
console.log('PASS: readonly preview, reviewed apply identity, actual BGP Established and dual-stack import via installed Go Agent');
const acceptedPolicy=p=>({...p.resource,mode:'apply',inventoryRevision:p.inventoryRevision,previewId:p.previewId,candidateHash:p.candidateHash});
async function policyPreview(kind,body){const context=await api(`/api/${kind}/editor-context${body.id?`?id=${body.id}`:''}`);const before=(await api('/api/dashboard')).inventory;const preview=await api(`/api/${kind}/preview`,'POST',{...body,inventoryRevision:context.inventoryRevision});assert.ok(preview.valid,JSON.stringify(preview));assert.deepEqual((await api('/api/dashboard')).inventory,before);return preview;}
const definePreview=await policyPreview('defines',{name:'NATIVE_LOCAL_PREF',label:'Native constant',nodeIds:[nodeId],type:'expression',value:'188'});
const define=(await api('/api/defines','POST',acceptedPolicy(definePreview),201)).resource;
const fnPreview=await policyPreview('functions',{name:'native_tag',label:'Native preference function',nodeIds:[nodeId],source:'function native_tag() { bgp_local_pref = NATIVE_LOCAL_PREF; bgp_community.add((64512,188)); }'});
const fn=(await api('/api/functions','POST',acceptedPolicy(fnPreview),201)).resource;
const filterPreview=await policyPreview('filters',{name:'native_import',label:'Native import filter',nodeIds:[nodeId],source:'filter native_import { native_tag(); accept; }'});
const filter=(await api('/api/filters','POST',acceptedPolicy(filterPreview),201)).resource;
await api('/api/sessions/apply','POST',accepted(p),409);
const edited={...saved,channels:structuredClone(saved.channels)};edited.channels.ipv4.importPolicy={mode:'custom',steps:[],filterId:filter.id,formAction:'none'};
const change=await api('/api/sessions/preview','POST',{...edited,inventoryRevision:(await context()).inventoryRevision});assert.ok(change.valid);await api('/api/sessions/apply','POST',accepted(change),202);
await until(async()=>{const route=(await routes('ipv4')).routes.find(r=>r.prefix==='203.0.113.0/24');return route&&/BGP.local_pref: 188/.test(route.details)&&/\(64512,188\)/.test(route.details);},'Function called by Filter must set actual IPv4 route attributes from Define');
const refs=await api(`/api/functions/editor-context?id=${fn.id}`);assert.ok(refs.references.some(r=>r.kind==='filters'&&r.id===filter.id));assert.ok(refs.references.some(r=>r.kind==='sessions'&&r.id===saved.id&&r.via.length));
await api(`/api/functions/${fn.id}`,'DELETE',undefined,409);await api(`/api/defines/${define.id}`,'DELETE',undefined,409);
const rejected=await policyPreview('filters',{...filter,source:'filter native_import { native_tag(); reject; }'});await api(`/api/filters/${filter.id}`,'PUT',acceptedPolicy(rejected));
await until(async()=>(await routes('ipv4')).routes.length===0,'Edited Filter must remove actual IPv4 import');
assert.ok((await routes('ipv6')).routes.some(r=>r.prefix==='2001:db8:100::/48'));
await api(`/api/filters/${filter.id}`,'DELETE',undefined,409);
const unchanged=(await api('/api/dashboard')).inventory;
const invalid=await api('/api/sessions/preview','POST',{...edited,bgp:{...edited.bgp,raw:'this_is_not_bird_syntax;'}},422);assert.equal(invalid.valid,false);assert.deepEqual((await api('/api/dashboard')).inventory,unchanged);
console.log('PASS: Define → Function → Filter → BGP actual local_pref/community attributes; reviewed create/edit, direct/indirect references; IPv4 rejection with IPv6 retained, stale CAS and native invalid preflight without writes');
for(const enabled of[false,true]){const current=(await context()).session;const preview=await api('/api/sessions/preview','POST',{...current,enabled,inventoryRevision:(await context()).inventoryRevision});assert.ok(preview.valid);await api('/api/sessions/apply','POST',accepted(preview),enabled?202:200);if(enabled)await until(async()=>/BGP state:\s+Established/.test((await protocol()).output),'Re-enabled eBGP establishes');else assert.match((await protocol()).output,/配置已停用/);}
await api(`/api/sessions/${saved.id}`,'DELETE',{inventoryRevision:(await context()).inventoryRevision});
await api(`/api/filters/${filter.id}`,'DELETE');
for(const enabled of[false,true]){const preview=await policyPreview('functions',{...fn,enabled});await api(`/api/functions/${fn.id}`,'PUT',acceptedPolicy(preview));}
await api(`/api/functions/${fn.id}`,'DELETE');await api(`/api/defines/${define.id}`,'DELETE');await api(`/api/peers/${peer.id}`,'DELETE');
assert.equal((await api('/api/dashboard')).inventory.sessions.length,0);
console.log('PASS: actual disable/re-enable, cleanup session, policies and remote peer');
