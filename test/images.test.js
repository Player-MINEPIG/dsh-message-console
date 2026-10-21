import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ConsoleService,fingerprint } from '../src/core.js';
import { WorkflowExecutor } from '../src/executor.js';
import { contentInput } from '../src/input-assembly.js';
import { validateSource,validateSettings } from '../src/config.js';
import { createHandler } from '../src/http.js';
import { Readable } from 'node:stream';
const photo=id=>({url:`https://i0.hdslb.com/bfs/new_dyn/${id}.png`,width:100,height:80});
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'dmc-image-refs-')),store=await new Store(directory).start();
 const service=new ConsoleService({store,connectors:{bilibili:{status:()=>({ready:true})}},executor:{},workspaces:{resolve:async id=>({id,path:directory})}});
 const source=await service.saveSource({workspaceId:'ws',name:'图片合成来源',platform:'bilibili',target:'BV1111111111',types:['comment']});
 const entry={remoteId:'root',kind:'comment',title:'根评论',body:'正文',payload:{images:[photo('one')],comments:[{id:'reply',author:'观众',body:'楼中楼',images:[photo('child')]}]}};
 const id=`${source.id}:root`;store.applyFetch(source.id,[entry],{},'2026-10-20T00:00:00Z',fingerprint);
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});return {directory,store,service,source,entry,id};
}

test('images retain version-specific ownership in cards, comments, change samples and history; image changes create content versions',async t=>{
 const f=await fixture(t),old=f.store.item(f.id).version;
 assert.deepEqual(f.service.items(f.source.id).items[0].payload.images,[photo('one')]);assert.deepEqual(f.service.comments(f.id,old).items[0].images,[photo('child')]);
 f.entry.payload.images=[photo('two')];f.entry.payload.comments[0].images=[photo('changed')];f.store.applyFetch(f.source.id,[f.entry],{},'2026-10-21T00:00:00Z',fingerprint);
 const current=f.store.item(f.id).version;assert.notEqual(current,old);
 const reason=f.store.organizationReason(f.id);assert.equal(reason.rootImagesChanged,true);assert.equal(reason.contextChanged,false);assert.equal(reason.comments.edited,1);assert.equal(reason.comments.samples[0].images[0].url,photo('changed').url);
 assert.deepEqual(f.store.image(f.id,{version:old,index:'0'}),photo('one'));assert.deepEqual(f.store.image(f.id,{version:current,commentId:'reply',index:'0'}),photo('changed'));
 assert.deepEqual(f.service.item(f.id,old).payload.images,[photo('one')]);
 assert.deepEqual(f.service.changedComments(f.id,{version:current,baseVersion:old}).items[0].images,[photo('changed')]);
 for(const query of [{version:current,index:-1},{version:current,index:5},{version:'other',index:0},{version:current,index:0,commentId:'other'}])assert.throws(()=>f.store.image(f.id,query));
 f.entry.payload.comments=[];f.store.applyFetch(f.source.id,[f.entry],{},'2026-10-22T00:00:00Z',fingerprint);
 const removed=f.service.changedComments(f.id,{version:f.store.item(f.id).version,baseVersion:current}).items[0];assert.equal(removed.version,current);assert.deepEqual(removed.images,[photo('changed')]);assert.deepEqual(f.store.image(f.id,{version:removed.version,commentId:removed.id,index:0}),photo('changed'));
});

test('cache controls are global only and model inputs explicitly describe unread images without claiming vision',async()=>{
 assert.equal(validateSettings({imageCacheMaxMB:64}).imageCacheMaxMB,64);assert.throws(()=>validateSettings({imageCacheMaxMB:0}));
 assert.throws(()=>validateSource({workspaceId:'ws',name:'source',platform:'bilibili',target:'BV1111111111',types:['comment'],settings:{imageCacheMaxMB:64}}),/不适用/);
 const item={kind:'comment',payload:{comments:[{images:[photo('a')]}]}};assert.match(contentInput(item).imageStatus,/尚未读取/);
 const executor=new WorkflowExecutor({decision:()=>{throw new Error('must not infer pictures');},runAgent:()=>{throw new Error('no vision');}});
 const result=await executor.analyze({item});assert.equal(result.evidence,'insufficient');assert.equal(result.intervention,'human');assert.match(result.summary,/尚未读取图片/);
});

test('binary image route enforces owner admission and exact stored refs; cache clear uses protected POST',async()=>{
 const calls=[],service={image:async(id,query)=>{calls.push({id,query});return {body:Buffer.from([1,2,3]),mime:'image/webp'};},imageCacheStatus:async()=>({usedBytes:3}),clearImageCache:async()=>{calls.push('clear');return {usedBytes:0};}};
 const handler=createHandler(service,req=>req.headers.owner==='1'?{}:{rejection:401});
 async function call(path,{owner=true,method='GET',marker=true}={}){const req=Readable.from(method==='POST'?[Buffer.from('{}')]:[]);Object.assign(req,{method,url:'/api/dsh-message-console/'+path,headers:{...(owner?{owner:'1'}:{}),'content-type':'application/json',...(marker?{'x-dsh-message-console':'1'}:{})}});let code,body,headers;await handler(req,{writeHead(c,h){code=c;headers=h;},end(b){body=b;}});return {code,body,headers};}
 assert.equal((await call('items/x/image?version=v&index=0',{owner:false})).code,401);assert.equal(calls.length,0);
 const response=await call('items/s%3Ax/image?version=old&commentId=c&index=0&variant=original');assert.equal(response.code,200);assert.ok(Buffer.isBuffer(response.body));assert.equal(response.headers['Cache-Control'],'private, no-store');assert.equal(response.headers['X-Content-Type-Options'],'nosniff');assert.equal(calls[0].id,'s:x');assert.equal(calls[0].query.version,'old');
 assert.equal((await call('image-cache/clear',{method:'POST',marker:false})).code,403);assert.equal((await call('image-cache/clear',{method:'POST'})).code,200);assert.equal(calls.at(-1),'clear');
});
