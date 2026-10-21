import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { normalizeRPKI, renderBirdConfigBundle } from '../src/bird.js';
import { parseRpkiRuntime, parseRoaEntries } from '../src/bird-rpki-runtime.js';
import { createRtrCache } from '../scripts/fixtures/rpki-rtr.mjs';
const bird=process.env.BIRDBOX_TEST_BIRD??'bird',birdc=process.env.BIRDBOX_TEST_BIRDC??'birdc';
const available=spawnSync(bird,['--version'],{encoding:'utf8'}).status===0;
async function until(check,message){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}assert.fail(message);}
test('Actual BIRD loads dual-stack file/RTR ROAs, parses established state, applies ROA validation and withdraws RTR records', {skip:available?false:'BIRD binary unavailable',timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'birdbox-rpki-native-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cache=await createRtrCache();t.after(()=>cache.close());
 const node={id:'native',name:'Native',transport:'agent',routerId:'192.0.2.1',deploymentMode:'include',mainConfigPath:path.join(root,'bird.conf'),generatedConfigPath:path.join(root,'generated.conf'),socketPath:path.join(root,'bird.ctl')};
 const file4=path.join(root,'roa4.conf'),file6=path.join(root,'roa6.conf');
 await fs.writeFile(file4,'route 198.51.100.0/24 max 28 as 64514;\n');await fs.writeFile(file6,'route 2001:db8:100::/48 max 64 as 64515;\n');
 const resources=[normalizeRPKI({id:'file',name:'native_file',label:'File',sourceType:'file',roa4Table:'FILE4',roa6Table:'FILE6',file4,file6}),normalizeRPKI({id:'rtr',name:'native_rtr',label:'RTR',sourceType:'server',remote:'127.0.0.1',port:cache.port,minVersion:1,maxVersion:1,roa4Table:'RTR4',roa6Table:'RTR6'})];
 const bundle=renderBirdConfigBundle(node,[],[],[],[],[],resources);
 const conf=`router id 192.0.2.1;\n${bundle.main}\nprotocol static validate_routes { ipv4; route 203.0.113.0/24 blackhole; route 203.0.113.0/29 blackhole; route 192.0.2.0/24 blackhole; }\n`;
 await fs.writeFile(node.mainConfigPath,conf);const parsed=spawnSync(bird,['-p','-c',node.mainConfigPath],{encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);
 const process=spawn(bird,['-f','-c',node.mainConfigPath,'-s',node.socketPath,'-P',path.join(root,'bird.pid')],{stdio:'ignore'});
 t.after(async()=>{process.kill('SIGTERM');if(process.exitCode===null)await new Promise(resolve=>process.once('exit',resolve));});
 const query=command=>{const r=spawnSync(birdc,['-s',node.socketPath,'-v',command],{encoding:'utf8',timeout:2000});return r.stdout??'';};
 await until(async()=>fs.stat(node.socketPath).then(()=>true,()=>false),'BIRD socket must become ready');
 await until(()=>parseRpkiRuntime(query('show protocols all native_rtr'),'native_rtr','RPKI').rtrState==='Established','RTR must establish using real TCP connection');
 for(const [family,table,asn]of[['ipv4','RTR4',64512],['ipv6','RTR6',64513],['ipv4','FILE4',64514],['ipv6','FILE6',64515]]){const entries=parseRoaEntries(query(`show route table ${table} all`),family).entries;assert.equal(entries.length,1,table);assert.equal(entries[0].asn,asn);}
 const runtime=parseRpkiRuntime(query('show protocols all native_rtr'),'native_rtr','RPKI');assert.equal(runtime.state,'up');assert.equal(runtime.channels.length,2);assert.ok(runtime.channels.every(c=>c.imported===1));
 const valid=query('show route table master4 where roa_check(RTR4, net, 64512) = ROA_VALID');assert.match(valid,/203\.0\.113\.0\/24/);assert.doesNotMatch(valid,/203\.0\.113\.0\/29/);
 const invalid=query('show route table master4 where roa_check(RTR4, net, 64512) = ROA_INVALID');assert.match(invalid,/203\.0\.113\.0\/29/);
 const unknown=query('show route table master4 where roa_check(RTR4, net, 64512) = ROA_UNKNOWN');assert.match(unknown,/192\.0\.2\.0\/24/);
 cache.withdraw();await until(()=>parseRoaEntries(query('show route table RTR4 all'),'ipv4').entries.length===0,'RTR serial update must withdraw IPv4 ROA');assert.equal(parseRoaEntries(query('show route table RTR6 all'),'ipv6').entries.length,0);
 const after=parseRpkiRuntime(query('show protocols all native_rtr'),'native_rtr','RPKI');assert.equal(after.rtrState,'Established');assert.equal(after.channels[0].imported,0,'zero ROAs must still be an established RTR connection');
});
