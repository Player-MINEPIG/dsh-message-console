import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';

import {Store} from '../src/store.js';
import {ConsoleService,fingerprint} from '../src/core.js';
import {createHandler} from '../src/http.js';

const at='2026-10-24T00:00:00Z';
const human={summary:'合成问题需人工判断',importance:2,urgent:false,urgencyReason:null,reason:'隔离验收',intervention:'human',evidence:'confirmed'};
let sequence=0;

async function fixture(t,count=127){
  const directory=await mkdtemp(join(tmpdir(),'dmc-bulk-state-'));
  const store=await new Store(directory).start();
  const unexpected=()=>{throw new Error('验收禁止调用真实模型或平台');};
  const service=new ConsoleService({store,connectors:{github:{status:()=>({ready:true}),fetch:unexpected,publish:unexpected},bilibili:{status:()=>({ready:true}),identity:async()=>({id:'1000000001'}),fetch:unexpected,publish:unexpected}},executor:new Proxy({},{get:()=>unexpected}),workspaces:{resolve:async id=>({id,path:directory}),list:async()=>[{id:'ws',path:directory}]}});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  const definitions=[['github','owner/synthetic',['issue','pr','release']],['bilibili','BV1111111111',['comment']],['bilibili','private-messages',['private-message']]];
  const sources=[];
  for(const [platform,target,types] of definitions){
    const source=await service.saveSource({workspaceId:'ws',name:`合成 ${target}`,platform,target,types});sources.push(source);
    store.applyFetch(source.id,[],{},at,fingerprint);
    const amount=platform==='github'?count:3;
    const entries=Array.from({length:amount},(_,i)=>({remoteId:String(i),kind:types[i%types.length],title:`合成项 ${i}`,body:`合成正文 ${i}`,payload:platform==='github'?{state:i%3===1?'CLOSED':'OPEN',number:i+1}:types[0]==='private-message'?{contact:{id:'synthetic-contact'},comments:[]}:{comments:[]}}));
    store.applyFetch(source.id,entries,{},at,fingerprint);
  }
  const all=source=>{const first=store.items(source.id,{pageSize:50,showClosed:true});return Array.from({length:first.pageCount},(_,i)=>store.items(source.id,{page:i+1,pageSize:50,showClosed:true}).items).flat();};
  const snapshots=()=>sources.flatMap(all).map(x=>store.item(x.id));
  const card=id=>sources.flatMap(all).find(x=>x.id===id);
  const adopt=(id,result=human)=>{const item=store.item(id),source=store.source(item.sourceId),run={id:`synthetic-run-${++sequence}`,itemId:id,sourceId:source.id,workspaceId:'ws',version:item.version,contextVersion:source.contextVersion,sourceContextVersion:source.contextVersion,baseAnalysisRevision:item.analysisRevision,status:'completed',startedAt:at};store.createRun(run);assert.equal(store.adoptResult(run.id,result),true);return run;};
  const draft=async(id,body='合成草稿历史')=>{const run=adopt(id),sessionId=`synthetic-human-${++sequence}`;service.bindSession({sessionId,runId:run.id,role:'human',workspaceId:'ws',cwd:directory});const receipt=await service.submitFromSession({sessionId},{kind:'draft',operationKey:`synthetic-draft-${sequence}`,body});return {run,sessionId,receipt};};
  const request=async(path,body={},headers={'x-owner':'1','x-dsh-message-console':'1','content-type':'application/json'})=>{const handler=createHandler(service,req=>req.headers['x-owner']==='1'?{}:{rejection:401}),req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',url:`/api/dsh-message-console/${path}`,headers});let status,data;await handler(req,{writeHead(code){status=code;},end(value){data=JSON.parse(value);}});return {status,data};};
  return {directory,store,service,sources,all,snapshots,card,adopt,draft,request};
}

test('全部已读跨 127 条分页、含隐藏关闭项，保留处理/关注/分析/草稿及其他来源',async t=>{
  const f=await fixture(t),rows=f.all(f.sources[0]);assert.equal(rows.length,127);assert.ok(f.service.items(f.sources[0].id,{pageSize:10}).total<127);
  f.store.handling(rows[0].id,'pending');f.store.handling(rows[1].id,'later');f.adopt(rows[2].id);
  const saved=await f.draft(rows.find(x=>x.kind==='issue').id);const draftBefore=f.service.draft(saved.receipt.draftId),before=f.snapshots(),handlingBefore=f.service.overview().sources.find(x=>x.id===f.sources[0].id).handling;
  const result=f.service.markAllRead({sourceId:f.sources[0].id});assert.equal(result.count,127);
  for(const previous of before){const current=f.store.item(previous.id);assert.deepEqual(current,{...previous,...(previous.sourceId===f.sources[0].id?{readVersion:previous.version}:{})});}
  assert.deepEqual(f.service.draft(saved.receipt.draftId),draftBefore);assert.equal(f.service.overview().sources.find(x=>x.id===f.sources[0].id).handling,handlingBefore);
  for(const previous of before.filter(x=>x.sourceId===f.sources[0].id))if(['pending','later'].includes(previous.handling))assert.equal(f.card(previous.id).status,'handling');
  assert.equal(f.service.items(f.sources[0].id,{filter:'unread',showClosed:true}).total,0);
});

test('全部已处理只完成当前需处理项，跨分页/关闭项，保持未读和草稿/分析完整',async t=>{
  const f=await fixture(t),rows=f.all(f.sources[0]);for(let i=0;i<rows.length;i++)if(i%2===0)f.store.handling(rows[i].id,i%4===0?'pending':'later');
  const withDraft=await f.draft(rows.find(x=>x.kind==='issue').id),draftBefore=f.service.draft(withDraft.receipt.draftId),before=f.snapshots();
  const targeted=new Set(f.all(f.sources[0]).filter(x=>x.needsHandling).map(x=>x.id));assert.ok(targeted.size>50);
  assert.equal(f.service.markAllHandled({sourceId:f.sources[0].id}).count,targeted.size);
  for(const previous of before){const current=f.store.item(previous.id);if(targeted.has(previous.id)){assert.equal(current.handling,'done');assert.equal(current.acknowledgedAttentionVersion,current.attentionVersion);assert.equal(f.card(current.id).needsHandling,false);assert.equal(f.card(current.id).status,'unread');assert.deepEqual(current,{...previous,handling:'done',acknowledgedAttentionVersion:previous.attentionVersion,attentionAcknowledged:true});}else assert.deepEqual(current,previous);}
  assert.deepEqual(f.service.draft(withDraft.receipt.draftId),draftBefore);assert.equal(f.service.items(f.sources[0].id,{filter:'handling',showClosed:true}).total,0);
  const settled=f.snapshots();assert.equal(f.service.markAllHandled({sourceId:f.sources[0].id}).count,0);assert.deepEqual(f.snapshots(),settled);
  await f.store.close();await f.store.start();assert.deepEqual(f.snapshots(),settled);assert.deepEqual(f.service.draft(withDraft.receipt.draftId),draftBefore);
});

test('平台批量只影响指定平台，总览全局包含 GitHub / B站评论 / 私信',async t=>{
  const f=await fixture(t,6);for(const source of f.sources)for(const row of f.all(source))f.store.handling(row.id,'pending');
  const before=f.snapshots();assert.equal(f.service.markAllHandled({platform:'bilibili'}).count,6);
  for(const row of before){const current=f.store.item(row.id);if(row.sourceId===f.sources[0].id)assert.deepEqual(current,row);else{assert.equal(current.handling,'done');assert.equal(current.readVersion,row.readVersion);}}
  assert.equal(f.service.markAllHandled().count,6);assert.ok(f.service.overview().sources.every(x=>x.handling===0));
  assert.equal(f.service.markAllRead({platform:'github'}).count,6);assert.equal(f.service.overview().sources.find(x=>x.id===f.sources[0].id).unread,0);assert.equal(f.service.overview().sources.filter(x=>x.platform==='bilibili').reduce((n,x)=>n+x.unread,0),6);
  assert.equal(f.service.markAllRead().count,12);assert.ok(f.service.overview().sources.every(x=>x.unread===0));
});

test('处理完成后新草稿、新监督结果、新分析、新内容及新条目仍按本轮关注规则提醒',async t=>{
  const f=await fixture(t,6),id=f.all(f.sources[1])[0].id,saved=await f.draft(id),read=f.store.item(id).readVersion;
  const finish=()=>{assert.equal(f.service.markAllHandled({sourceId:f.sources[1].id}).count,1);assert.equal(f.card(id).needsHandling,false);assert.equal(f.store.item(id).readVersion,read);};
  finish();await f.service.submitFromSession({sessionId:saved.sessionId},{kind:'draft',operationKey:'second-synthetic-draft',body:'新的合成草稿'});assert.equal(f.card(id).needsHandling,true);
  finish();f.store.updateDraft(saved.receipt.draftId,{status:'ready'});assert.equal(f.card(id).needsHandling,true);assert.equal(f.store.item(id).handling,'pending');
  finish();f.adopt(id);assert.equal(f.card(id).needsHandling,true);assert.equal(f.store.item(id).attentionAcknowledged,false);
  finish();const original=f.store.item(id),oldDraft=f.service.draft(saved.receipt.draftId);f.store.applyFetch(f.sources[1].id,[{remoteId:original.remoteId,kind:'comment',title:original.title,body:'之后的新原文',payload:{comments:[]}},{remoteId:'after-bulk',kind:'comment',title:'后来新项',body:'新事件',payload:{}}],{},at,fingerprint);
  assert.notEqual(f.store.item(id).version,original.version);assert.equal(f.store.item(id).attentionAcknowledged,false);assert.equal(f.store.item(id).handling,'none');assert.notEqual(f.store.item(id).readVersion,f.store.item(id).version);assert.equal(f.card(id).needsHandling,true);assert.equal(f.card(`${f.sources[1].id}:after-bulk`).status,'unread');assert.equal(f.service.draft(saved.receipt.draftId).body,oldDraft.body);
  f.adopt(id);assert.equal(f.card(id).needsHandling,true);
});

test('批量接口拒绝未认证/缺少防跨站头，范围错误不退化为全局操作',async t=>{
  const f=await fixture(t,6);for(const source of f.sources)f.store.handling(f.all(source)[0].id,'pending');
  for(const path of ['read-all','handle-all']){
    const before=f.snapshots();assert.equal((await f.request(path,{},{})).status,401);assert.equal((await f.request(path,{}, {'x-owner':'1','content-type':'application/json'})).status,403);assert.deepEqual(f.snapshots(),before);
    for(const body of [null,[],1,'source',{sourceID:'typo'},{sourceId:''},{sourceId:'missing-source'},{sourceId:12},{platform:'missing-platform'},{platform:''},{sourceId:f.sources[0].id,platform:'bilibili'}]){const response=await f.request(path,body);assert.ok(response.status>=400,JSON.stringify({path,body,response}));assert.deepEqual(f.snapshots(),before);}
  }
  assert.equal((await f.request('handle-all',{sourceId:f.sources[0].id})).status,200);assert.equal(f.service.overview().sources.find(x=>x.id===f.sources[0].id).handling,0);assert.equal(f.service.overview().sources.find(x=>x.id===f.sources[1].id).handling,1);
  assert.equal((await f.request('read-all',{sourceId:f.sources[0].id})).status,200);
});

test('中途数据库错误回滚整批处理、已读、来源计数和审计',async t=>{
  const f=await fixture(t,6);for(const row of f.all(f.sources[0]))f.store.handling(row.id,'pending');
  const db=new DatabaseSync(join(f.directory,'console.sqlite'));t.after(()=>db.close());
  for(const operation of ['markAllRead','markAllHandled']){
    const before=f.snapshots(),overview=f.service.overview(),audit=db.prepare('SELECT * FROM audit ORDER BY rowid').all(),revision=f.store.revision();
    db.exec("CREATE TRIGGER synthetic_abort BEFORE UPDATE ON items WHEN old.remote_id='3' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
    assert.throws(()=>f.service[operation]({sourceId:f.sources[0].id}),/synthetic rollback/);db.exec('DROP TRIGGER synthetic_abort');
    assert.deepEqual(f.snapshots(),before);assert.deepEqual(f.service.overview(),overview);assert.deepEqual(db.prepare('SELECT * FROM audit ORDER BY rowid').all(),audit);assert.equal(f.store.revision(),revision);
  }
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});

test('并发 HTTP 批量请求串行生效，后续事件不被旧操作迟到覆盖',async t=>{
  const f=await fixture(t,6),id=f.all(f.sources[1])[0].id;f.store.handling(id,'pending');
  const results=await Promise.all([f.request('handle-all',{sourceId:f.sources[1].id}),f.request('handle-all',{sourceId:f.sources[1].id}),f.request('read-all',{sourceId:f.sources[1].id})]);
  assert.ok(results.every(x=>x.status===200));assert.deepEqual(results.slice(0,2).map(x=>x.data.count).sort(),[0,1]);
  const old=f.store.item(id);f.store.applyFetch(f.sources[1].id,[{remoteId:old.remoteId,kind:'comment',title:old.title,body:'完成请求之后到达的新事件',payload:{}}],{},at,fingerprint);
  assert.equal(f.store.item(id).readVersion,old.version);assert.equal(f.store.item(id).attentionAcknowledged,false);assert.equal(f.card(id).status,'unread');
});


test('草稿各历史状态保持不动，完成已读待处理项不改变其阅读状态',async t=>{
  for(const status of ['pending-supervision','ready','blocked','stale','sending','unknown','sent','dismissed','superseded'])await t.test(status,async t=>{
    const f=await fixture(t,3),id=f.all(f.sources[1])[0].id,saved=await f.draft(id);
    f.adopt(id,{...human,intervention:'none'});f.store.handling(id,'none');f.store.updateDraft(saved.receipt.draftId,{status});
    const active=['pending-supervision','ready','blocked','stale','sending','unknown'].includes(status),before=f.service.draft(saved.receipt.draftId);
    assert.equal(f.card(id).needsHandling,active);
    assert.equal(f.service.markAllRead({sourceId:f.sources[1].id}).count,3);assert.equal(f.card(id).needsHandling,active);assert.equal(f.store.item(id).readVersion,f.store.item(id).version);
    assert.equal(f.service.markAllHandled({sourceId:f.sources[1].id}).count,active?1:0);assert.equal(f.card(id).needsHandling,false);assert.equal(f.card(id).status,'read');assert.deepEqual(f.service.draft(saved.receipt.draftId),before);
  });
});
