import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from '../src/http.js';

test('HTTP requires host admission and rejects cross-site simple writes',async t=>{
  let writes=0;
  const server=createServer(createHandler({configure:async()=>{writes++;}},req=>req.headers['x-test-admitted']?{}:{rejection:401}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/dsh-message-console/settings`;
  let result=await fetch(url,{method:'POST',body:'{}'});assert.equal(result.status,401);
  result=await fetch(url,{method:'POST',headers:{'x-test-admitted':'1','content-type':'application/json'},body:'{}'});assert.equal(result.status,403);
  result=await fetch(url,{method:'POST',headers:{'x-test-admitted':'1','content-type':'application/json','x-dsh-message-console':'1'},body:'{}'});assert.equal(result.status,200);assert.equal(writes,1);
});

test('authenticated preview endpoint dispatches unsaved source and selected item without saving',async()=>{
 const { Readable }=await import('node:stream');let received,writes=0;
 const service={previewInput:async body=>{received=body;return {input:{blocks:[]},itemId:body.itemId};},saveSource:async()=>{writes++;}};
 const handler=createHandler(service,()=>({}));
 const body={source:{name:'unsaved'},sourceId:'source-1',itemId:'item-1'};
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',url:'/api/dsh-message-console/sources/preview',headers:{'content-type':'application/json','x-dsh-message-console':'1'}});
 let status,result;await handler(req,{writeHead(code){status=code;},end(text){result=JSON.parse(text);}});
 assert.equal(status,200);assert.deepEqual(received,body);assert.equal(result.itemId,'item-1');assert.equal(writes,0);
});

test('manual organization HTTP selects history scope and returns processing statistics',async()=>{
 const { Readable }=await import('node:stream');let scope;
 const report={scope:'history',candidates:4,completed:0,failed:4,skipped:0,status:'failed'};
 const handler=createHandler({organize:async(id,options)=>{assert.equal(id,'source-1');scope=options.scope;return report;}},()=>({}));
 const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{method:'POST',url:'/api/dsh-message-console/sources/source-1/organize',headers:{'content-type':'application/json','x-dsh-message-console':'1'}});
 let status,result;await handler(req,{writeHead(code){status=code;},end(text){result=JSON.parse(text);}});assert.equal(status,200);assert.equal(scope,'history');assert.deepEqual(result,report);
});

test('authenticated catalog endpoints separate provider profiles from lazy model lookup',async()=>{
 const { Readable }=await import('node:stream');const seen=[];
 const handler=createHandler({catalog:async()=>({providers:[{id:'sub',name:'Subscription'}],decisionProfiles:[{id:'jev',name:'Decision'}]}),models:async id=>{seen.push(id);return [{provider:id,id:'m',name:'Model'}];}},()=>({}));
 async function get(url){const req=Readable.from([]);Object.assign(req,{method:'GET',url,headers:{}});let code,result;await handler(req,{writeHead(status){code=status;},end(text){result=JSON.parse(text);}});assert.equal(code,200);return result;}
 assert.equal((await get('/api/dsh-message-console/catalog')).decisionProfiles[0].id,'jev');assert.deepEqual(seen,[]);assert.equal((await get('/api/dsh-message-console/catalog/models/sub'))[0].provider,'sub');assert.deepEqual(seen,['sub']);
});

test('authenticated session directory exposes only the service identity inventory',async()=>{
 const { Readable }=await import('node:stream');const handler=createHandler({sessionDirectory:()=>({sessionIds:['original-id']})},()=>({}));
 const req=Readable.from([]);Object.assign(req,{method:'GET',url:'/api/dsh-message-console/session-directory',headers:{}});let code,result;await handler(req,{writeHead(value){code=value;},end(text){result=JSON.parse(text);}});assert.equal(code,200);assert.deepEqual(result,{sessionIds:['original-id']});
});
