// Minimal isolated RTR v1 test cache. No external validation data or networking.
import net from 'node:net';
export async function createRtrCache(host = '127.0.0.1') {
 const sessionId = 42, clients = new Set(); let serial = 1, withdrawn = false;
 const routes = [{ address:'203.0.113.0', length:24, max:28, asn:64512 }, { address:'2001:db8::', length:32, max:48, asn:64513 }];
 const header = (type, length, session = 0) => {const p=Buffer.alloc(length);p[0]=1;p[1]=type;p.writeUInt16BE(session,2);p.writeUInt32BE(length,4);return p;};
 function prefix(route, announce) {
  const v6=route.address.includes(':'),p=header(v6?6:4,v6?32:20);p[8]=announce?1:0;p[9]=route.length;p[10]=route.max;
  if(v6){const [left,right='']=route.address.split('::'),first=left?left.split(':'):[],last=right?right.split(':'):[];const groups=[...first,...Array(8-first.length-last.length).fill('0'),...last];groups.forEach((g,i)=>p.writeUInt16BE(parseInt(g,16),12+i*2));}
  else route.address.split('.').forEach((part,i)=>p[12+i]=Number(part));
  p.writeUInt32BE(route.asn,p.length-4);return p;
 }
 function end() {const p=header(7,24,sessionId);p.writeUInt32BE(serial,8);p.writeUInt32BE(60,12);p.writeUInt32BE(10,16);p.writeUInt32BE(600,20);return p;}
 const server=net.createServer(socket=>{
  clients.add(socket);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));let buffer=Buffer.alloc(0);
  socket.on('data',data=>{
   buffer=Buffer.concat([buffer,data]);
   while(buffer.length>=8){const length=buffer.readUInt32BE(4);if(length<8||length>4096){socket.destroy();return;}if(buffer.length<length)return;const p=buffer.subarray(0,length);buffer=buffer.subarray(length);
    if(p[0]!==1){socket.destroy();return;}
    if(p[1]===2){socket.write(Buffer.concat([header(3,8,sessionId),...(!withdrawn?routes.map(r=>prefix(r,true)):[]),end()]));}
    else if(p[1]===1&&p.length===12){const previous=p.readUInt32BE(8);socket.write(Buffer.concat([header(3,8,sessionId),...(withdrawn&&previous<serial?routes.map(r=>prefix(r,false)):[]),end()]));}
   }
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});
 return {port:server.address().port,withdraw(){withdrawn=true;serial++;const p=header(0,12,sessionId);p.writeUInt32BE(serial,8);for(const socket of clients)socket.write(p);},async close(){for(const socket of clients)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
