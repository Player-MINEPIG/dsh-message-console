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

test('authenticated session directory dispatches the incremental cursor and bounded limit',async()=>{
 const { Readable }=await import('node:stream');let received;const value={changes:[{sessionId:'original-id',eligible:true}],next:8,hasMore:false};const handler=createHandler({sessionDirectory:query=>{received=query;return value;}},()=>({}));
 const req=Readable.from([]);Object.assign(req,{method:'GET',url:'/api/dsh-message-console/session-directory?after=4&limit=100',headers:{}});let code,result;await handler(req,{writeHead(status){code=status;},end(text){result=JSON.parse(text);}});assert.equal(code,200);assert.deepEqual(result,value);assert.deepEqual(received,{after:'4',limit:'100'});
});

test('source suggestion endpoint requires owner admission and JSON CSRF headers and dispatches before source IDs without saving',async()=>{
 const {Readable}=await import('node:stream');let calls=0,writes=0;
 const handler=createHandler({suggestSource:async body=>{calls++;assert.deepEqual(body,{input:'o/r',types:['release']});return {fields:{name:'o/r'},access:'public'};},saveSource:async()=>{writes++;}},req=>req.headers['x-test-owner']==='1'?{}:{rejection:401});
 async function call(method,headers){const req=Readable.from([Buffer.from(JSON.stringify({input:'o/r',types:['release']}))]);Object.assign(req,{method,url:'/api/dsh-message-console/sources/suggest',headers});let code,data;await handler(req,{writeHead(value){code=value;},end(value){data=JSON.parse(value);}});return {code,data};}
 assert.equal((await call('POST',{})).code,401);assert.equal((await call('POST',{'x-test-owner':'1','content-type':'application/json'})).code,403);assert.equal((await call('GET',{'x-test-owner':'1'})).code,405);
 const result=await call('POST',{'x-test-owner':'1','content-type':'application/json','x-dsh-message-console':'1'});assert.equal(result.code,200);assert.equal(result.data.fields.name,'o/r');assert.equal(calls,1);assert.equal(writes,0);
});

test('read endpoints dispatch bounded page, precise content version, draft and decision requests without legacy state',async()=>{
 const {Readable}=await import('node:stream');const calls=[];
 const service={overview:query=>({sources:[],platforms:[],revision:1}),items:(id,query)=>{calls.push({id,query});return {items:[],page:1,pageSize:10,total:0,pageCount:1,revision:1};},content:(id,query)=>{calls.push({id,query});return {version:query.version,text:'原文',offset:0,nextOffset:null,total:2,complete:true};},draft:id=>({id,body:'saved',bodyHash:'hash',status:'pending-supervision'}),decision:id=>({input:{state:id},output:{saved:true}})};
 const handler=createHandler(service,()=>({}));
 async function get(path){const req=Readable.from([]);Object.assign(req,{method:'GET',url:'/api/dsh-message-console/'+path,headers:{}});let status,result;await handler(req,{writeHead(code){status=code;},end(text){result=JSON.parse(text);}});return {status,result};}
 assert.equal((await get('overview')).status,200);assert.equal((await get('state')).status,404);
 const page=await get('sources/source/items?page=2&pageSize=20&filter=unread&q=%25');assert.equal(page.status,200);assert.deepEqual(calls[0],{id:'source',query:{page:'2',pageSize:'20',filter:'unread',q:'%'}});
 const content=await get('items/source%3Ac/content?version=old&section=comment&commentId=123&offset=0&length=16');assert.equal(content.result.text,'原文');assert.equal(calls[1].id,'source:c');assert.equal(calls[1].query.version,'old');
 assert.equal((await get('drafts/draft')).result.body,'saved');assert.equal((await get('runs/run/decision')).result.input.state,'run');assert.equal((await get('items/id/content/unexpected')).status,404);
});

test('changed-comment endpoint keeps owner authentication and forwards both immutable versions and pagination',async()=>{
 const {Readable}=await import('node:stream');const calls=[];
 const handler=createHandler({changedComments:(id,query)=>{calls.push({id,query});return {items:[{id:'old',change:'removed',version:query.baseVersion}],total:1,page:1,pageSize:10,pageCount:1};}},req=>req.headers['x-test-owner']==='1'?{}:{rejection:401});
 async function get(headers){const req=Readable.from([]);Object.assign(req,{method:'GET',url:'/api/dsh-message-console/items/source%3Aroot/changes?version=new&baseVersion=old&page=2&pageSize=10',headers});let code,data;await handler(req,{writeHead(value){code=value;},end(value){data=JSON.parse(value);}});return {code,data};}
 assert.equal((await get({})).code,401);assert.equal(calls.length,0);
 const result=await get({'x-test-owner':'1'});assert.equal(result.code,200);assert.equal(result.data.items[0].version,'old');
 assert.deepEqual(calls,[{id:'source:root',query:{version:'new',baseVersion:'old',page:'2',pageSize:'10'}}]);
});
