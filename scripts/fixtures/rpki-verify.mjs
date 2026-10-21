import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRtrCache } from './rpki-rtr.mjs';
const cookie=await fs.readFile('/verification/cookie','utf8'),nodeId='node_installer_e2e';
const cache=await createRtrCache('0.0.0.0');
async function api(path,method='GET',body,status=200){const r=await fetch(`http://127.0.0.1:3000${path}`,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const v=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(v)}`);return v;}
async function until(check,message){for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}assert.fail(message);}
const accepted=p=>({...p.resource,mode:'apply',inventoryRevision:p.inventoryRevision,previewId:p.previewId,candidateHash:p.candidateHash});
const roas=(id,family)=>api(`/api/rpki/${id}/roas?nodeId=${nodeId}&family=${family}`);
try{
 const before=(await api('/api/dashboard')).inventory;
 const preview=await api('/api/rpki/preview','POST',{label:'RTR native',name:'lab_rtr',sourceType:'server',nodeIds:[nodeId],remote:process.argv[2],port:cache.port,minVersion:1,maxVersion:1,roa4Table:'RTR4',roa6Table:'RTR6',refresh:60,retry:10,expire:600,keepRefresh:true,keepRetry:true,keepExpire:true});
 assert.equal(preview.valid,true,JSON.stringify(preview.configs));assert.deepEqual((await api('/api/dashboard')).inventory,before);
 const rtr=(await api('/api/rpki','POST',accepted(preview),201)).resource;
 assert.equal((await api(`/api/dashboard?nodeId=${nodeId}`)).config,preview.configs[0].config);
 await until(async()=>(await api(`/api/rpki/${rtr.id}/runtime`)).nodes[0].protocols[0].rtrState==='Established','RTR must establish using actual Agent/BIRD, not route-count inference');
 for(const[family,asn,max]of[['ipv4',64512,28],['ipv6',64513,48]]){const entries=(await roas(rtr.id,family)).entries;assert.equal(entries.length,1);assert.equal(entries[0].asn,asn);assert.equal(entries[0].maxLength,max);assert.equal(entries[0].protocol,'lab_rtr');}
 console.log('PASS: readonly full-bundle preview, explicit apply identity, actual RTR v1 IPv4/IPv6 connection/ROAs/state/counts');
 const filePreview=await api('/api/rpki/preview','POST',{label:'File native',name:'lab_roa_file',sourceType:'file',nodeIds:[nodeId],roa4Table:'FILE4',roa6Table:'FILE6',file4:'/etc/bird/roa4.conf',file6:'/etc/bird/roa6.conf'});assert.equal(filePreview.valid,true,JSON.stringify(filePreview.configs));
 const file=(await api('/api/rpki','POST',accepted(filePreview),201)).resource;
 for(const[family,asn]of[['ipv4',64514],['ipv6',64515]])assert.equal((await roas(file.id,family)).entries[0].asn,asn);
 const localRuntime=(await api(`/api/rpki/${file.id}/runtime`)).nodes[0].protocols;assert.equal(localRuntime.length,2);assert.ok(localRuntime.every(p=>p.state==='up'&&p.rtrState===null&&p.channels[0].imported===1));
 const fn=(await api('/api/functions','POST',{name:'lab_validate_roa',label:'ROA validation',nodeIds:[nodeId],source:'function lab_validate_roa() { return roa_check(RTR4, net, bgp_path.last) = ROA_VALID; }'},201)).resource;
 assert.equal((await api(`/api/rpki/editor-context?id=${rtr.id}`)).references[0].id,fn.id);
 await api(`/api/rpki/${rtr.id}`,'DELETE',undefined,409);
 const protectedRename=await api('/api/rpki/preview','POST',{id:rtr.id,roa4Table:'RENAMED4'},409);assert.match(protectedRename.error,/引用/);
 const current=(await api('/api/dashboard')).inventory;
 const invalid=await api('/api/rpki/preview','POST',{id:file.id,file4:'/nonexistent/birdbox-roa.conf'});assert.equal(invalid.valid,false);assert.deepEqual((await api('/api/dashboard')).inventory,current);
 await api(`/api/rpki/${rtr.id}`,'PUT',accepted(preview),409);
 console.log('PASS: actual local dual-stack ROA files and Static channel status; symbol/deletion dependency protection; native invalid-file preflight preserves state; stale CAS rejected');
 cache.withdraw();await until(async()=>(await roas(rtr.id,'ipv4')).entries.length===0,'actual serial notification must remove IPv4 ROAs');assert.equal((await roas(rtr.id,'ipv6')).entries.length,0);
 const runtime=(await api(`/api/rpki/${rtr.id}/runtime`)).nodes[0].protocols[0];assert.equal(runtime.rtrState,'Established');assert.ok(runtime.channels.every(c=>c.imported===0));
 await api(`/api/functions/${fn.id}`,'DELETE');
 for(const id of[rtr.id,file.id]){
  const stop=await api('/api/rpki/preview','POST',{id,enabled:false});assert.equal(stop.valid,true);await api(`/api/rpki/${id}`,'PUT',accepted(stop));assert.ok((await api(`/api/rpki/${id}/runtime`)).nodes[0].protocols.every(p=>p.state==='disabled'));
  const enable=await api('/api/rpki/preview','POST',{id,enabled:true});assert.equal(enable.valid,true);await api(`/api/rpki/${id}`,'PUT',accepted(enable));
  const latest=await api(`/api/rpki/editor-context?id=${id}`);await api(`/api/rpki/${id}`,'DELETE',{inventoryRevision:latest.inventoryRevision});
 }
 assert.equal((await api('/api/dashboard')).inventory.rpki.length,0);
 console.log('PASS: actual RTR serial withdrawals with connection still established and zero counts; stop/re-enable/delete both source types; final inventory cleanup');
}finally{await cache.close();}
