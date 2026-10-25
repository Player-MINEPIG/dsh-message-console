import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { resolveSettings } from '../src/config.js';

const entry = body => ({ remoteId:'comment:1',kind:'comment',title:'关于新视频的提问',body,url:'https://example.com/comment/1',payload:{comments:[]} });
async function setup(t) {
  const directory=await mkdtemp(join(tmpdir(),'dmc-test-'));
  const store=await new Store(directory).start();
  let rows=[entry('旧评论')], calls=0, published=0;
  const connector={status:()=>({ready:true,canPublish:true}),fetch:async()=>({complete:true,items:structuredClone(rows)}),getItem:async()=>structuredClone(rows[0]),publish:async()=>{published++;return {remoteId:'remote-1'};}};
  let service;
  const analysis={summary:'有新问题',importance:2,urgent:false,urgencyReason:null,reason:'需要回复',intervention:'review',evidence:'confirmed'};
  const bindHuman=(runId,sessionId)=>{service.bindSession({sessionId,runId,role:'human',workspaceId:store.run(runId).workspaceId,cwd:directory});return sessionId;};
  const executor={analyze:async({runId,recordDecision})=>{
    calls++;await recordDecision({input:'test',output:'test'});
    service.bindSession({sessionId:`writer-${calls}`,runId,role:'writer',workspaceId:store.run(runId).workspaceId,cwd:directory});
    const receipt=await service.submitFromSession({sessionId:`writer-${calls}`,callId:'write'},{kind:'analysis',operationKey:'write',analysis,draftBody:'测试回复'});
    service.bindSession({sessionId:`supervisor-${calls}`,runId,role:'supervisor',workspaceId:store.run(runId).workspaceId,cwd:directory,draftId:receipt.draftId});
    await service.submitFromSession({sessionId:`supervisor-${calls}`,callId:'check'},{kind:'supervision',operationKey:'check',approved:true,reason:'有依据'});
    return {...analysis,committed:true,processing:'analysis'};
  },conversation:async({runId})=>bindHuman(runId,`human-${calls}`)};
  service=new ConsoleService({store,connectors:{bilibili:connector},executor,workspaces:{list:async()=>[],resolve:async id=>{if(!["ws-1","ws-2"].includes(id))throw new Error("工作区不存在");return {id,path:directory};}}});
  const source=await service.saveSource({workspaceId:'ws-1',name:'测试来源',platform:'bilibili',target:'BV1111111111',types:['comment']});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  const items=()=>service.items(source.id,{pageSize:50}).items;
  return {directory,store,service,source,connector,executor,bindHuman,items,drafts:()=>service.drafts(items()[0].id,{pageSize:50}).items,runs:()=>service.runs(items()[0].id,{pageSize:50}).items,setRows:value=>{rows=value;},get calls(){return calls;},get published(){return published;}};
}

test('initial baseline is read and not analyzed; later changes stay unread until explicitly opened',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);
  let item=f.items()[0];assert.equal(item.readVersion,item.version);assert.equal(f.calls,0);
  f.setRows([entry('新回复')]);await f.service.refresh(f.source.id);
  item=f.items()[0];assert.notEqual(item.readVersion,item.version);assert.equal(f.calls,1);assert.equal(f.drafts()[0].status,'ready');assert.equal(f.published,0);
  await f.service.organize(f.source.id);assert.equal(f.calls,1);
  await f.service.markRead(item.id,item.version);assert.equal(f.items()[0].readVersion,item.version);
  await f.service.setHandling(item.id,'done');f.setRows([entry('另一条新回复')]);await f.service.refresh(f.source.id);
  assert.equal(f.items()[0].handling,'none');assert.notEqual(f.items()[0].readVersion,f.items()[0].version);
});
test('incomplete baseline never commits or marks source initialized',async t=>{
  const f=await setup(t);f.connector.fetch=async()=>({complete:false,items:[entry('partial')]});
  const result=await f.service.refresh(f.source.id);assert.equal(result.fetched,false);assert.equal(f.items().length,0);assert.equal(f.service.source(f.source.id).initialized,false);
});

test('conversation entry prefers the working session over a prior human fallback',async t=>{
  const f=await setup(t);let count=0;f.executor.conversation=async({runId})=>f.bindHuman(runId,`human-${++count}`);
  await f.service.refresh(f.source.id);const id=f.items()[0].id;
  const first=await f.service.openConversation(id);assert.deepEqual(await f.service.openConversation(id),first);assert.equal(count,1);
  f.setRows([entry('changed')]);await f.service.refresh(f.source.id);
  const second=await f.service.openConversation(id);assert.notEqual(second.sessionId,first.sessionId);assert.equal(second.sessionId,'writer-1');assert.equal(f.store.item(f.items()[0].id).sessions.filter(link=>link.role==='human').length,1);
});

test('unconfirmed publication also blocks a new draft on a later content version',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('change one')]);await f.service.refresh(f.source.id);
  const first=f.drafts()[0];f.store.updateDraft(first.id,{status:'unknown'});
  f.setRows([entry('change two')]);await f.service.refresh(f.source.id);const next=f.drafts().find(draft=>draft.id!==first.id);
  await assert.rejects(f.service.approveAndPublish(next.id,{version:next.version,bodyHash:next.bodyHash}),/尚未确认/);assert.equal(f.published,0);
});
test('supervision and exact content approval are both required; duplicate clicks publish once',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('需要回复的新问题')]);await f.service.refresh(f.source.id);
  const draft=f.drafts()[0];
  await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:'wrong'}),/重新审核/);assert.equal(f.published,0);
  await Promise.all([1,2].map(()=>f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:draft.bodyHash})));
  assert.equal(f.published,1);assert.equal(f.drafts()[0].status,'sent');
  await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:draft.bodyHash}));assert.equal(f.published,1);
});
test('new remote content invalidates an old approval before POST',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);const draft=f.drafts()[0];
  f.setRows([entry('changed again')]);await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:draft.bodyHash}),/原始内容有新变化/);
  assert.equal(f.published,0);assert.equal(f.drafts()[0].status,'stale');
});
test('uncertain send is durable and cannot automatically retry',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);const draft=f.drafts()[0];let attempts=0;
  f.connector.publish=async()=>{attempts++;throw new Error('connection reset after POST');};
  await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:draft.bodyHash}));
  assert.equal(f.drafts()[0].status,'unknown');await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:draft.bodyHash}));assert.equal(attempts,1);
  await f.store.close();await f.store.start();assert.equal(f.drafts()[0].status,'unknown');
});
test('scope defaults only expose applicable settings, overrides do not change other sources',async t=>{
  const f=await setup(t);await f.service.configure({fetchHours:8,reviewFocus:'correctness',replyStyle:'concise'});
  let settings=resolveSettings(f.store.settings(),f.source);assert.equal(settings.fetchHours.value,8);assert.equal(settings.fetchHours.inherited,true);assert.equal(settings.reviewFocus,undefined);
  const source=await f.service.saveSource({...f.service.source(f.source.id),settings:{fetchHours:12}},f.source.id);settings=resolveSettings(f.store.settings(),source);assert.equal(settings.fetchHours.value,12);assert.equal(settings.fetchHours.origin,'source');
  await assert.rejects(f.service.saveSource({...f.source,settings:{reviewFocus:'invalid'}},f.source.id),/不适用/);
});
test('failed analysis keeps version pending, source errors do not erase successful history',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);f.executor.analyze=async()=>{throw new Error('model down');};await f.service.refresh(f.source.id);
  assert.notEqual(f.items()[0].analyzedVersion,f.items()[0].version);assert.equal(f.runs()[0].status,'failed');
  f.connector.fetch=async()=>{throw new Error('rate limited');};await f.service.refresh(f.source.id);assert.equal(f.service.content(f.items()[0].id,{}).text,'new');assert.match(f.service.source(f.source.id).fetchError,/rate limited/);
});
test('concurrent read state updates are durable after reopen',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);const item=f.items()[0];
  await Promise.all(Array.from({length:20},()=>f.service.markRead(item.id,item.version)));
  await f.store.close();await f.store.start();assert.equal(f.items()[0].readVersion,item.version);
});
test('restart reclaims dead-process lock and marks in-flight send unknown',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);
  const draft=f.drafts()[0];f.store.updateDraft(draft.id,{status:'sending'});await f.store.close();
  await writeFile(join(f.directory,'owner.lock'),'2147483647\n');await f.store.start();assert.equal(f.store.draft(draft.id).status,'unknown');
});
test('scheduler respects slower organization independently from fetch',async t=>{
  const f=await setup(t);let now=Date.now();f.service.clock=()=>now;
  await f.service.saveSource({...f.source,settings:{fetchHours:1,organizeHours:6}},f.source.id);await f.service.tick();
  f.setRows([entry('new')]);now+=2*3600000;await f.service.tick();assert.equal(f.calls,0);assert.equal(f.service.content(f.items()[0].id,{}).text,'new');
  now+=5*3600000;await f.service.tick();assert.equal(f.calls,1);
});

test('sources require an existing workspace, legacy sources cannot start analysis, rebinding preserves old sessions',async t=>{
  const f=await setup(t);
  await assert.rejects(f.service.saveSource({...f.source,workspaceId:undefined}),/已有工作区/);
  await assert.rejects(f.service.saveSource({...f.source,workspaceId:'deleted'}),/工作区不存在/);
  await f.service.refresh(f.source.id);
  let created=0;f.executor.conversation=async ({source,runId})=>f.bindHuman(runId,`${source.workspaceId}-${++created}`);
  const id=f.items()[0].id;
  const first=await f.service.openConversation(id);
  await f.service.saveSource({...f.source,workspaceId:'ws-2'},f.source.id);
  const second=await f.service.openConversation(id);
  assert.notEqual(first.sessionId,second.sessionId);
  assert.deepEqual(f.store.item(f.items()[0].id).sessions.map(link=>link.workspaceId),['ws-1','ws-2']);
  f.store.updateSource(f.source.id,{workspaceId:undefined});
  f.setRows([entry('new')]);await f.service.refresh(f.source.id);
  assert.equal(f.calls,0);assert.match(f.runs()[0].error,/工作区/);
  await assert.rejects(f.service.openConversation(id),/工作区/);
});

test('changing input order invalidates drafts but keeps the original working conversation',async t=>{
 const f=await setup(t);let count=0;f.executor.conversation=async({runId})=>f.bindHuman(runId,`human-${++count}`);
 await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);
 const item=f.items()[0],first=await f.service.openConversation(item.id);
 await f.service.saveSource({...f.source,inputOrder:['content','context','source','materials'],description:'brief',tags:['personal']},f.source.id);
 assert.equal(f.drafts()[0].status,'stale');
 const second=await f.service.openConversation(item.id);assert.deepEqual(second,first);
 assert.equal(first.sessionId,'writer-1');assert.equal(count,0);
 assert.equal(f.service.source(f.source.id).description,'brief');assert.deepEqual(f.service.source(f.source.id).tags,['personal']);
});
test('preview resolves only explicit workspace files and the selected source real item, without mutation',async t=>{
 const f=await setup(t);f.service.workspaces.resolve=async id=>({id,path:f.directory});
 await writeFile(join(f.directory,'notes.md'),'REAL_FILE_SENTINEL');await f.service.refresh(f.source.id);
 const item=f.items()[0],source={...f.source,materials:[{kind:'file',name:'notes',path:'notes.md'}],inputOrder:['materials','content','context','source']};
 const before=f.store.revision();
 const preview=await f.service.previewInput({source,sourceId:f.source.id,itemId:item.id});
 assert.equal(preview.input.blocks[0].value[0].text,'REAL_FILE_SENTINEL');assert.equal(preview.input.blocks[1].value.id,item.id);assert.equal(f.store.revision(),before);
 for(const drift of [{target:'BV2222222222'},{types:['release']},{platform:'github',target:'o/r',types:['issue']}])await assert.rejects(f.service.previewInput({source:{...source,...drift},sourceId:f.source.id,itemId:item.id}));
 await assert.rejects(f.service.previewInput({source,itemId:item.id}),/此来源/);
 const other=await f.service.saveSource({...f.source,name:'other'});await assert.rejects(f.service.previewInput({source,sourceId:other.id,itemId:item.id}),/此来源/);
 for(const path of ['../outside.md','.local/private.md'])await assert.rejects(f.service.previewInput({source:{...source,materials:[{kind:'file',name:'bad',path}]},sourceId:f.source.id}));
 const blank=await f.service.previewInput({source:{...f.source,materials:[]}});assert.match(blank.serialized,/尚未选择实际内容项/);
});
test('input changes preserve completed analysis; future content uses the new order and material contents',async t=>{
 const f=await setup(t);f.service.workspaces.resolve=async id=>({id,path:f.directory});
 await writeFile(join(f.directory,'notes.md'),'FIRST');
 await f.service.saveSource({...f.source,materials:[{kind:'file',name:'notes',path:'notes.md'}]},f.source.id);
 f.setRows([entry('baseline'),{...entry('second baseline'),remoteId:'comment:2'}]);await f.service.refresh(f.source.id);
 const captured=[];const original=f.executor.analyze;f.executor.analyze=async request=>{captured.push(request.source);return original(request);};
 f.setRows([entry('changed'),{...entry('second baseline'),remoteId:'comment:2'}]);await f.service.refresh(f.source.id);assert.equal(captured.length,1);
 const before=f.items().find(item=>item.remoteId==='comment:1').readVersion;
 const order=['content','materials','source','context'];await f.service.saveSource({...f.service.source(f.source.id),inputOrder:order},f.source.id);
 await f.service.organize(f.source.id);assert.equal(captured.length,1);
 assert.equal(f.items().find(item=>item.remoteId==='comment:1').readVersion,before);
 assert.equal(f.items().find(item=>item.remoteId==='comment:2').analysis,null);
 await writeFile(join(f.directory,'notes.md'),'SECOND');await f.service.organize(f.source.id);assert.equal(captured.length,1);
 f.setRows([entry('next change'),{...entry('second baseline'),remoteId:'comment:2'}]);await f.service.refresh(f.source.id);assert.equal(captured.length,2);assert.deepEqual(captured[1].inputOrder,order);assert.equal(captured[1].resolvedMaterials[0].text,'SECOND');
 await f.service.organize(f.source.id);assert.equal(captured.length,2);
});

test('manual history organization includes untouched baseline once; refresh and scheduler keep changes scope',async t=>{
 const f=await setup(t);f.setRows([entry('first'),{...entry('second'),remoteId:'comment:2'}]);
 const first=await f.service.refresh(f.source.id);assert.equal(first.organization.candidates,0);assert.match(first.organization.reason,/首次基线/);assert.equal(f.calls,0);
 const reads=f.items().map(item=>item.readVersion);
 assert.equal((await f.service.organize(f.source.id)).candidates,0);
 const manual=await f.service.organize(f.source.id,{scope:'history'});assert.equal(manual.scope,'history');assert.equal(manual.total,2);assert.equal(manual.candidates,2);assert.equal(manual.completed,2);assert.equal(manual.failed,0);assert.equal(manual.skipped,0);assert.equal(f.calls,2);
 assert.deepEqual(f.items().map(item=>item.readVersion),reads);
 const repeat=await f.service.organize(f.source.id,{scope:'history'});assert.equal(repeat.candidates,0);assert.equal(repeat.skipped,2);assert.match(repeat.reason,/无需重复/);assert.equal(f.calls,2);
 await f.service.saveSource({...f.service.source(f.source.id),settings:{fetchHours:168,organizeHours:.25}},f.source.id);assert.deepEqual(f.service.source(f.source.id).lastOrganization,repeat);
 f.service.clock=()=>Date.now()+3600000;await f.service.tick();assert.equal(f.calls,2);assert.equal(f.service.source(f.source.id).lastOrganization.scope,'changes');
 f.setRows([entry('changed'),{...entry('second'),remoteId:'comment:2'}]);const refresh=await f.service.refresh(f.source.id);assert.equal(refresh.organization.candidates,1);assert.equal(refresh.organization.completed,1);assert.equal(f.calls,3);
});
test('manual baseline failures retain Jev evidence and report the missing plugin route without losing candidate counts',async t=>{
 const { WorkflowExecutor }=await import('../src/executor.js');const f=await setup(t);let modelCalls=0;
 const flow=new WorkflowExecutor({decision:async()=>({answers:{reply:{probabilities:{ignore:0,draft:1,human:0}}}}),runAgent:async()=>{modelCalls++;}});
 f.executor.analyze=request=>flow.analyze(request);await f.service.refresh(f.source.id);
 const report=await f.service.organize(f.source.id,{scope:'history'});assert.equal(report.status,'failed');assert.equal(report.candidates,1);assert.equal(report.completed,0);assert.equal(report.failed,1);assert.equal(report.skipped,0);assert.equal(modelCalls,0);
 assert.match(report.errors[0].message,/全局配置/);assert.match(report.errors[0].message,/API 配置不等于/);
 const run=f.runs()[0];assert.equal(run.status,'failed');assert.ok(f.service.decision(run.id).output);assert.deepEqual(f.service.source(f.source.id).lastOrganization,report);assert.equal(f.items()[0].analysis,null);
});
test('context-incomplete history is counted as processed without pretending to call a model',async t=>{
 const { WorkflowExecutor }=await import('../src/executor.js');const f=await setup(t);let calls=0;
 const flow=new WorkflowExecutor({decision:async()=>{calls++;throw new Error('must not call');},runAgent:async()=>{calls++;throw new Error('must not call');}});
 f.executor.analyze=request=>flow.analyze(request);f.setRows([{...entry('partial discussion'),payload:{contextComplete:false,contextLimit:'missing thread'}}]);await f.service.refresh(f.source.id);
 const report=await f.service.organize(f.source.id,{scope:'history'});assert.equal(report.completed,1);assert.equal(report.failed,0);assert.equal(calls,0);
 const run=f.runs()[0];assert.equal(run.processing,'context-incomplete');assert.equal(f.service.decision(run.id),null);assert.deepEqual(run.sessions,[]);
});
test('incompatible source work rejects clearly instead of reusing another organization scope',async t=>{
 const f=await setup(t);let releaseFetch;const waitFetch=new Promise(resolve=>{releaseFetch=resolve;});
 f.connector.fetch=async()=>{await waitFetch;return {complete:true,items:[entry('baseline')]};};
 const refreshing=f.service.refresh(f.source.id);await assert.rejects(f.service.organize(f.source.id,{scope:'history'}),/正在刷新或整理/);releaseFetch();await refreshing;
 let releaseAnalysis;const waitAnalysis=new Promise(resolve=>{releaseAnalysis=resolve;});const original=f.executor.analyze;
 f.executor.analyze=async request=>{await waitAnalysis;return original(request);};
 const manual=f.service.organize(f.source.id,{scope:'history'});await assert.rejects(f.service.refresh(f.source.id),/正在刷新或整理/);await assert.rejects(f.service.organize(f.source.id),/正在刷新或整理/);releaseAnalysis();assert.equal((await manual).scope,'history');assert.equal(f.calls,1);
});

test('stage preview matches assembled runtime blocks and stage changes invalidate prior work without changing legacy text',async t=>{
 const { assembleInput }=await import('../src/input-assembly.js');const { prepareSource }=await import('../src/source-context.js');const f=await setup(t);f.service.workspaces.resolve=async id=>({id,path:f.directory});
 await writeFile(join(f.directory,'stage.md'),'STAGE_FILE');await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);
 let humanCount=0;f.executor.conversation=async({runId})=>f.bindHuman(runId,`human-${++humanCount}`);const item=f.items()[0],first=await f.service.openConversation(item.id);
 const updated=await f.service.saveSource({...f.source,context:'LEGACY_SHARED',stageContexts:{generation:{context:'GEN_ONLY',materials:[{kind:'file',name:'notes',path:'stage.md'}]},decision:{context:'DECISION_ONLY'}}},f.source.id);
 assert.equal(f.drafts()[0].status,'stale');assert.equal((await f.service.openConversation(item.id)).sessionId,first.sessionId);assert.equal(humanCount,0);
 const prepared=await prepareSource(updated,{path:f.directory});for(const stage of ['decision','escalation','generation','supervision']){const preview=await f.service.previewInput({source:updated,sourceId:updated.id,itemId:item.id,stage});assert.deepEqual(preview.input.blocks,assembleInput(prepared,f.store.item(f.items()[0].id),{stage}).blocks);assert.equal(preview.input.stage,stage);if(stage==='escalation')assert.match(preview.serialized,/占位/);if(stage==='supervision')assert.match(preview.input.draft,/占位/);}
 await assert.rejects(f.service.previewInput({source:updated,stage:'system'}),/阶段无效/);assert.equal(f.service.source(f.source.id).context,'LEGACY_SHARED');
});

test('actual host failure details survive in run records and organization reports',async t=>{
 const { sessionFailure }=await import('../src/dsh.js');const f=await setup(t);await f.service.refresh(f.source.id);
 f.executor.analyze=async({recordSession})=>{await recordSession('decision-escalation','dmc-original');throw sessionFailure({kind:'error',error:{code:'TRANSPORT',message:'provider transport failed'}},'dmc-original');};
 const report=await f.service.organize(f.source.id,{scope:'history'}),run=f.runs()[0];
 assert.equal(report.failed,1);assert.equal(report.errors[0].sessionId,'dmc-original');assert.match(report.errors[0].message,/TRANSPORT/);assert.equal(run.failure.code,'TRANSPORT');assert.equal(run.failure.sessionId,'dmc-original');assert.equal(run.sessions[0].sessionId,'dmc-original');
});

test('session directory returns incremental eligibility without background or in-flight sessions',async t=>{
 const f=await setup(t);await f.service.refresh(f.source.id);const item=f.items()[0];
 const run=f.store.createRun({id:'pending',sourceId:f.source.id,itemId:item.id,version:item.version,contextVersion:f.source.contextVersion,workspaceId:'ws-1',status:'running',startedAt:new Date().toISOString()});
 f.service.bindSession({sessionId:'active',runId:run.id,role:'writer',workspaceId:'ws-1',cwd:f.directory});
 const before=f.service.sessionDirectory();assert.deepEqual(before.changes,[{sessionId:'active',eligible:false}]);
 f.store.updateRun(run.id,{status:'failed'});const next=f.service.sessionDirectory({after:before.next});assert.deepEqual(next.changes,[{sessionId:'active',eligible:true}]);
 assert.deepEqual(f.service.sessionDirectory({after:next.next}).changes,[]);
});


test('opening working history does not create a run or rewrite its binding after content changes',async t=>{
 const f=await setup(t);await f.service.refresh(f.source.id);await f.service.organize(f.source.id,{scope:'history'});
 const item=f.items()[0],binding=f.store.sessionBinding('writer-1'),runs=f.runs().map(r=>f.store.run(r.id));
 const first=await f.service.openConversation(item.id);assert.equal(first.sessionId,'writer-1');
 f.store.applyFetch(f.source.id,[entry('new unorganized version')],{},new Date().toISOString(),fingerprint);
 await f.service.saveSource({...f.source,context:'new guidance'},f.source.id);
 assert.deepEqual(await f.service.openConversation(item.id),first);
 assert.deepEqual(f.store.sessionBinding('writer-1'),binding);assert.deepEqual(f.runs().map(r=>f.store.run(r.id)),runs);
});

test('conversation candidates exclude other workspaces and roles and prefer the latest working round',async t=>{
 const f=await setup(t);await f.service.refresh(f.source.id);await f.service.organize(f.source.id,{scope:'history'});
 const item=f.items()[0];f.bindHuman(f.runs()[0].id,'later-human');
 assert.deepEqual(f.store.conversationSessions(item.id,'ws-1').map(s=>s.sessionId),['writer-1']);
 assert.deepEqual(f.store.conversationSessions(item.id,'ws-2'),[]);
 f.setRows([entry('second round')]);await f.service.refresh(f.source.id);
 assert.equal((await f.service.openConversation(item.id)).sessionId,'writer-2');
 await f.service.saveSource({...f.source,workspaceId:'ws-2'},f.source.id);
 assert.match((await f.service.openConversation(item.id)).sessionId,/^human/);
});

test('missing native working sessions fall back to human creation, host errors do not',async t=>{
 const f=await setup(t);await f.service.refresh(f.source.id);await f.service.organize(f.source.id,{scope:'history'});
 const id=f.items()[0].id;
 f.executor.resolveConversation=async()=>{throw new Error('history read failed');};
 const before=f.runs();await assert.rejects(f.service.openConversation(id),/history read failed/);assert.deepEqual(f.runs(),before);
 f.executor.resolveConversation=async()=>null;
 assert.match((await f.service.openConversation(id)).sessionId,/^human/);
});

test('execution limit inherits backend default, global setting and source override without changing content context',async t=>{
 const f=await setup(t);
 const service=new ConsoleService({store:f.store,connectors:{bilibili:f.connector},executor:f.executor,workspaces:f.service.workspaces,defaultTimeoutMs:600000});
 assert.equal(service.overview().parameters.agentTimeoutSeconds.default,600);
 assert.equal(service.source(f.source.id).effective.agentTimeoutSeconds.value,600);
 const context=f.service.source(f.source.id).contextVersion;
 await service.configure({agentTimeoutSeconds:900});
 assert.equal(service.source(f.source.id).effective.agentTimeoutSeconds.value,900);
 const overridden=await service.saveSource({...service.source(f.source.id),settings:{agentTimeoutSeconds:1200}},f.source.id);
 assert.equal(service.source(f.source.id).effective.agentTimeoutSeconds.value,1200);assert.equal(overridden.contextVersion,context);
 await service.saveSource({...overridden,settings:{}},f.source.id);
 assert.equal(service.source(f.source.id).effective.agentTimeoutSeconds.value,900);
 for(const value of [0,1801,Infinity,'300'])await assert.rejects(service.configure({agentTimeoutSeconds:value}),/设置值无效/);
});

test('closing an organization warning persists only that report, preserves results and rejects stale dismissal',async t=>{
 const f=await setup(t);await f.service.refresh(f.source.id,{organize:false});
 f.executor.analyze=async()=>{throw new Error('synthetic failure');};
 const first=await f.service.organize(f.source.id,{scope:'history'}),source=f.service.source(f.source.id);
 const item=f.items()[0],runs=f.runs(),revision=source.revision,context=source.contextVersion;
 assert.equal(first.failed,1);assert.ok(source.organizationReportId);
 f.service.dismissOrganizationWarning(source.id,{reportId:source.organizationReportId});
 f.service.dismissOrganizationWarning(source.id,{reportId:source.organizationReportId});
 await f.store.close();await f.store.start();
 const dismissed=f.service.source(source.id);
 assert.equal(dismissed.dismissedOrganizationId,source.organizationReportId);assert.deepEqual(dismissed.lastOrganization,first);
 assert.equal(dismissed.revision,revision);assert.equal(dismissed.contextVersion,context);assert.deepEqual(f.items()[0],item);assert.deepEqual(f.runs(),runs);
 await f.service.saveSource({...dismissed,name:'renamed'},source.id);
 assert.equal(f.service.source(source.id).dismissedOrganizationId,source.organizationReportId);
 await f.service.organize(source.id,{scope:'history'});const next=f.service.source(source.id);
 assert.notEqual(next.organizationReportId,source.organizationReportId);assert.notEqual(next.dismissedOrganizationId,next.organizationReportId);
 assert.throws(()=>f.service.dismissOrganizationWarning(source.id,{reportId:source.organizationReportId}),/已更新/);
 assert.throws(()=>f.service.dismissOrganizationWarning(source.id,{}),/已更新/);
 // Existing reports have no id; their warning can still be dismissed without rewriting the report.
 const {id,...legacy}=first;f.store.updateSource(source.id,{lastOrganization:legacy});
 const legacyId=f.service.source(source.id).organizationReportId;f.service.dismissOrganizationWarning(source.id,{reportId:legacyId});
 assert.deepEqual(f.service.source(source.id).lastOrganization,legacy);assert.equal(f.service.source(source.id).dismissedOrganizationId,legacyId);
 const other=await f.service.saveSource({...source,name:'other'},undefined);
 assert.equal(f.service.source(other.id).dismissedOrganizationId,undefined);
});
