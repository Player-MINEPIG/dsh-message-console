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
  const executor={analyze:async({recordDecision,recordSession})=>{calls++;await recordDecision({input:'test',output:'test'});await recordSession('writer',`session-${calls}`);return {summary:'有新问题',importance:2,urgent:false,reason:'需要回复',intervention:'review',draft:{body:'测试回复',supervision:{approved:true,reason:'有依据'}}};},conversation:async()=>`human-${calls}`};
  const service=new ConsoleService({store,connectors:{bilibili:connector},executor,workspaces:{list:async()=>[],resolve:async id=>{if(!["ws-1","ws-2"].includes(id))throw new Error("工作区不存在");return {id};}}});
  const source=await service.saveSource({workspaceId:'ws-1',name:'测试来源',platform:'bilibili',target:'BV1111111111',types:['comment']});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  return {directory,store,service,source,connector,executor,setRows:value=>{rows=value;},get calls(){return calls;},get published(){return published;}};
}

test('initial baseline is read and not analyzed; later changes stay unread until explicitly opened',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);
  let item=f.service.view().items[0];assert.equal(item.readVersion,item.version);assert.equal(f.calls,0);
  f.setRows([entry('新回复')]);await f.service.refresh(f.source.id);
  item=f.service.view().items[0];assert.notEqual(item.readVersion,item.version);assert.equal(f.calls,1);assert.equal(f.service.view().drafts[0].status,'ready');assert.equal(f.published,0);
  await f.service.organize(f.source.id);assert.equal(f.calls,1);
  await f.service.markRead(item.id,item.version);assert.equal(f.service.view().items[0].readVersion,item.version);
  await f.service.setHandling(item.id,'done');f.setRows([entry('另一条新回复')]);await f.service.refresh(f.source.id);
  assert.equal(f.service.view().items[0].handling,'done');assert.notEqual(f.service.view().items[0].readVersion,f.service.view().items[0].version);
});
test('incomplete baseline never commits or marks source initialized',async t=>{
  const f=await setup(t);f.connector.fetch=async()=>({complete:false,items:[entry('partial')]});
  const result=await f.service.refresh(f.source.id);assert.equal(result.fetched,false);assert.equal(f.service.view().items.length,0);assert.equal(f.service.view().sources[0].initialized,false);
});

test('human entry reuses the current-version session and preserves older-version links',async t=>{
  const f=await setup(t);let count=0;f.executor.conversation=async()=>`human-${++count}`;
  await f.service.refresh(f.source.id);const id=f.service.view().items[0].id;
  const first=await f.service.openConversation(id);assert.deepEqual(await f.service.openConversation(id),first);assert.equal(count,1);
  f.setRows([entry('changed')]);await f.service.refresh(f.source.id);
  const second=await f.service.openConversation(id);assert.notEqual(second.sessionId,first.sessionId);assert.equal(f.service.view().items[0].sessions.filter(link=>link.role==='human').length,2);
});

test('unconfirmed publication also blocks a new draft on a later content version',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('change one')]);await f.service.refresh(f.source.id);
  const first=f.service.view().drafts[0];await f.store.change(state=>{state.drafts[first.id].status='unknown';});
  f.setRows([entry('change two')]);await f.service.refresh(f.source.id);const next=f.service.view().drafts.find(draft=>draft.id!==first.id);
  await assert.rejects(f.service.approveAndPublish(next.id,{version:next.version,bodyHash:fingerprint(next.body)}),/尚未确认/);assert.equal(f.published,0);
});
test('supervision and exact content approval are both required; duplicate clicks publish once',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('需要回复的新问题')]);await f.service.refresh(f.source.id);
  const draft=f.service.view().drafts[0];
  await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:'wrong'}),/重新审核/);assert.equal(f.published,0);
  await Promise.all([1,2].map(()=>f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:fingerprint(draft.body)})));
  assert.equal(f.published,1);assert.equal(f.service.view().drafts[0].status,'sent');
  await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:fingerprint(draft.body)}));assert.equal(f.published,1);
});
test('new remote content invalidates an old approval before POST',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);const draft=f.service.view().drafts[0];
  f.setRows([entry('changed again')]);await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:fingerprint(draft.body)}),/原始内容有新变化/);
  assert.equal(f.published,0);assert.equal(f.service.view().drafts[0].status,'stale');
});
test('uncertain send is durable and cannot automatically retry',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);const draft=f.service.view().drafts[0];let attempts=0;
  f.connector.publish=async()=>{attempts++;throw new Error('connection reset after POST');};
  await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:fingerprint(draft.body)}));
  assert.equal(f.service.view().drafts[0].status,'unknown');await assert.rejects(f.service.approveAndPublish(draft.id,{version:draft.version,bodyHash:fingerprint(draft.body)}));assert.equal(attempts,1);
  await f.store.close();await f.store.start();assert.equal(f.service.view().drafts[0].status,'unknown');
});
test('scope defaults only expose applicable settings, overrides do not change other sources',async t=>{
  const f=await setup(t);await f.service.configure({fetchHours:8,reviewFocus:'correctness',replyStyle:'concise'});
  let settings=resolveSettings(f.store.read().settings,f.source);assert.equal(settings.fetchHours.value,8);assert.equal(settings.fetchHours.inherited,true);assert.equal(settings.reviewFocus,undefined);
  const source=await f.service.saveSource({...f.source,settings:{fetchHours:12}},f.source.id);settings=resolveSettings(f.store.read().settings,source);assert.equal(settings.fetchHours.value,12);assert.equal(settings.fetchHours.origin,'source');
  await assert.rejects(f.service.saveSource({...f.source,settings:{reviewFocus:'invalid'}},f.source.id),/不适用/);
});
test('failed analysis keeps version pending, source errors do not erase successful history',async t=>{
  const f=await setup(t);await f.service.refresh(f.source.id);f.setRows([entry('new')]);f.executor.analyze=async()=>{throw new Error('model down');};await f.service.refresh(f.source.id);
  assert.notEqual(f.service.view().items[0].analyzedVersion,f.service.view().items[0].version);assert.equal(f.service.view().runs[0].status,'failed');
  f.connector.fetch=async()=>{throw new Error('rate limited');};await f.service.refresh(f.source.id);assert.equal(f.service.view().items[0].body,'new');assert.match(f.service.view().sources[0].fetchError,/rate limited/);
});
test('store serializes concurrent transactions and retains data after reopen',async t=>{
  const f=await setup(t);await Promise.all(Array.from({length:20},()=>f.store.change(state=>{state.testCount=(state.testCount??0)+1;})));assert.equal(f.store.read().testCount,20);
  await f.store.close();await f.store.start();assert.equal(f.store.read().testCount,20);
});
test('restart reclaims dead-process lock and marks in-flight send unknown',async t=>{
  const f=await setup(t);await f.store.change(state=>{state.drafts.crash={id:'crash',status:'sending'};});await f.store.close();
  await writeFile(join(f.directory,'owner.lock'),'2147483647\n');await f.store.start();assert.equal(f.store.read().drafts.crash.status,'unknown');
});
test('scheduler respects slower organization independently from fetch',async t=>{
  const f=await setup(t);let now=Date.now();f.service.clock=()=>now;
  await f.service.saveSource({...f.source,settings:{fetchHours:1,organizeHours:6}},f.source.id);await f.service.tick();
  f.setRows([entry('new')]);now+=2*3600000;await f.service.tick();assert.equal(f.calls,0);assert.equal(f.service.view().items[0].body,'new');
  now+=5*3600000;await f.service.tick();assert.equal(f.calls,1);
});

test('sources require an existing workspace, legacy sources cannot start analysis, rebinding preserves old sessions',async t=>{
  const f=await setup(t);
  await assert.rejects(f.service.saveSource({...f.source,workspaceId:undefined}),/已有工作区/);
  await assert.rejects(f.service.saveSource({...f.source,workspaceId:'deleted'}),/工作区不存在/);
  await f.service.refresh(f.source.id);
  let created=0;f.executor.conversation=async ({source})=>`${source.workspaceId}-${++created}`;
  const id=f.service.view().items[0].id;
  const first=await f.service.openConversation(id);
  await f.service.saveSource({...f.source,workspaceId:'ws-2'},f.source.id);
  const second=await f.service.openConversation(id);
  assert.notEqual(first.sessionId,second.sessionId);
  assert.deepEqual(f.service.view().items[0].sessions.map(link=>link.workspaceId),['ws-1','ws-2']);
  await f.store.change(state=>{delete state.sources[f.source.id].workspaceId;});
  f.setRows([entry('new')]);await f.service.refresh(f.source.id);
  assert.equal(f.calls,0);assert.match(f.service.view().runs[0].error,/工作区/);
  await assert.rejects(f.service.openConversation(id),/工作区/);
});

test('changing input order invalidates drafts and human reuse while preserving existing history links',async t=>{
 const f=await setup(t);let count=0;f.executor.conversation=async()=>`human-${++count}`;
 await f.service.refresh(f.source.id);f.setRows([entry('new')]);await f.service.refresh(f.source.id);
 const item=f.service.view().items[0],first=await f.service.openConversation(item.id);
 await f.service.saveSource({...f.source,inputOrder:['content','context','source','materials'],description:'brief',tags:['personal']},f.source.id);
 assert.equal(f.service.view().drafts[0].status,'stale');
 const second=await f.service.openConversation(item.id);assert.notEqual(second.sessionId,first.sessionId);
 assert.equal(f.service.view().items[0].sessions.filter(link=>link.role==='human').length,2);
 assert.equal(f.service.view().sources[0].description,'brief');assert.deepEqual(f.service.view().sources[0].tags,['personal']);
});
test('preview resolves only explicit workspace files and the selected source real item, without mutation',async t=>{
 const f=await setup(t);f.service.workspaces.resolve=async id=>({id,path:f.directory});
 await writeFile(join(f.directory,'notes.md'),'REAL_FILE_SENTINEL');await f.service.refresh(f.source.id);
 const item=f.service.view().items[0],source={...f.source,materials:[{kind:'file',name:'notes',path:'notes.md'}],inputOrder:['materials','content','context','source']};
 const before=JSON.stringify(f.store.read());
 const preview=await f.service.previewInput({source,sourceId:f.source.id,itemId:item.id});
 assert.equal(preview.input.blocks[0].value[0].text,'REAL_FILE_SENTINEL');assert.equal(preview.input.blocks[1].value.id,item.id);assert.equal(JSON.stringify(f.store.read()),before);
 for(const drift of [{target:'BV2222222222'},{types:['release']},{platform:'github',target:'o/r',types:['issue']}])await assert.rejects(f.service.previewInput({source:{...source,...drift},sourceId:f.source.id,itemId:item.id}));
 await assert.rejects(f.service.previewInput({source,itemId:item.id}),/此来源/);
 const other=await f.service.saveSource({...f.source,name:'other'});await assert.rejects(f.service.previewInput({source,sourceId:other.id,itemId:item.id}),/此来源/);
 for(const path of ['../outside.md','.local/private.md'])await assert.rejects(f.service.previewInput({source:{...source,materials:[{kind:'file',name:'bad',path}]},sourceId:f.source.id}));
 const blank=await f.service.previewInput({source:{...f.source,materials:[]}});assert.match(blank.serialized,/尚未选择实际内容项/);
});
test('reorganizing after input changes uses the new order, skips unanalysed baseline, and detects material changes',async t=>{
 const f=await setup(t);f.service.workspaces.resolve=async id=>({id,path:f.directory});
 await writeFile(join(f.directory,'notes.md'),'FIRST');
 await f.service.saveSource({...f.source,materials:[{kind:'file',name:'notes',path:'notes.md'}]},f.source.id);
 f.setRows([entry('baseline'),{...entry('second baseline'),remoteId:'comment:2'}]);await f.service.refresh(f.source.id);
 const captured=[];const original=f.executor.analyze;f.executor.analyze=async request=>{captured.push(request.source);return original(request);};
 f.setRows([entry('changed'),{...entry('second baseline'),remoteId:'comment:2'}]);await f.service.refresh(f.source.id);assert.equal(captured.length,1);
 const before=f.service.view().items.find(item=>item.remoteId==='comment:1').readVersion;
 const order=['content','materials','source','context'];await f.service.saveSource({...f.service.view().sources[0],inputOrder:order},f.source.id);
 await f.service.organize(f.source.id);assert.equal(captured.length,2);assert.deepEqual(captured[1].inputOrder,order);
 assert.equal(f.service.view().items.find(item=>item.remoteId==='comment:1').readVersion,before);
 assert.equal(f.service.view().items.find(item=>item.remoteId==='comment:2').analysis,null);
 await writeFile(join(f.directory,'notes.md'),'SECOND');await f.service.organize(f.source.id);assert.equal(captured.length,3);assert.equal(captured[2].resolvedMaterials[0].text,'SECOND');
 await f.service.organize(f.source.id);assert.equal(captured.length,3);
});

test('manual history organization includes untouched baseline once; refresh and scheduler keep changes scope',async t=>{
 const f=await setup(t);f.setRows([entry('first'),{...entry('second'),remoteId:'comment:2'}]);
 const first=await f.service.refresh(f.source.id);assert.equal(first.organization.candidates,0);assert.match(first.organization.reason,/首次基线/);assert.equal(f.calls,0);
 const reads=f.service.view().items.map(item=>item.readVersion);
 assert.equal((await f.service.organize(f.source.id)).candidates,0);
 const manual=await f.service.organize(f.source.id,{scope:'history'});assert.equal(manual.scope,'history');assert.equal(manual.total,2);assert.equal(manual.candidates,2);assert.equal(manual.completed,2);assert.equal(manual.failed,0);assert.equal(manual.skipped,0);assert.equal(f.calls,2);
 assert.deepEqual(f.service.view().items.map(item=>item.readVersion),reads);
 const repeat=await f.service.organize(f.source.id,{scope:'history'});assert.equal(repeat.candidates,0);assert.equal(repeat.skipped,2);assert.match(repeat.reason,/无需重复/);assert.equal(f.calls,2);
 await f.service.saveSource({...f.service.view().sources[0],settings:{fetchHours:168,organizeHours:.25}},f.source.id);assert.deepEqual(f.service.view().sources[0].lastOrganization,repeat);
 f.service.clock=()=>Date.now()+3600000;await f.service.tick();assert.equal(f.calls,2);assert.equal(f.service.view().sources[0].lastOrganization.scope,'changes');
 f.setRows([entry('changed'),{...entry('second'),remoteId:'comment:2'}]);const refresh=await f.service.refresh(f.source.id);assert.equal(refresh.organization.candidates,1);assert.equal(refresh.organization.completed,1);assert.equal(f.calls,3);
});
test('manual baseline failures retain Jev evidence and report the missing plugin route without losing candidate counts',async t=>{
 const { WorkflowExecutor }=await import('../src/executor.js');const f=await setup(t);let modelCalls=0;
 const flow=new WorkflowExecutor({decision:async()=>({answers:{reply:{probabilities:{ignore:0,draft:1,human:0}}}}),runAgent:async()=>{modelCalls++;}});
 f.executor.analyze=request=>flow.analyze(request);await f.service.refresh(f.source.id);
 const report=await f.service.organize(f.source.id,{scope:'history'});assert.equal(report.status,'failed');assert.equal(report.candidates,1);assert.equal(report.completed,0);assert.equal(report.failed,1);assert.equal(report.skipped,0);assert.equal(modelCalls,0);
 assert.match(report.errors[0].message,/全局配置/);assert.match(report.errors[0].message,/API 配置不等于/);
 const run=f.service.view().runs[0];assert.equal(run.status,'failed');assert.ok(run.decision.output);assert.deepEqual(f.service.view().sources[0].lastOrganization,report);assert.equal(f.service.view().items[0].analysis,null);
});
test('context-incomplete history is counted as processed without pretending to call a model',async t=>{
 const { WorkflowExecutor }=await import('../src/executor.js');const f=await setup(t);let calls=0;
 const flow=new WorkflowExecutor({decision:async()=>{calls++;throw new Error('must not call');},runAgent:async()=>{calls++;throw new Error('must not call');}});
 f.executor.analyze=request=>flow.analyze(request);f.setRows([{...entry('partial discussion'),payload:{contextComplete:false,contextLimit:'missing thread'}}]);await f.service.refresh(f.source.id);
 const report=await f.service.organize(f.source.id,{scope:'history'});assert.equal(report.completed,1);assert.equal(report.failed,0);assert.equal(calls,0);
 const run=f.service.view().runs[0];assert.equal(run.processing,'context-incomplete');assert.equal(run.decision,null);assert.deepEqual(run.sessions,[]);
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
 let humanCount=0;f.executor.conversation=async()=>`human-${++humanCount}`;const item=f.service.view().items[0],first=await f.service.openConversation(item.id);
 const updated=await f.service.saveSource({...f.source,context:'LEGACY_SHARED',stageContexts:{generation:{context:'GEN_ONLY',materials:[{kind:'file',name:'notes',path:'stage.md'}]},decision:{context:'DECISION_ONLY'}}},f.source.id);
 assert.equal(f.service.view().drafts[0].status,'stale');assert.notEqual((await f.service.openConversation(item.id)).sessionId,first.sessionId);
 const prepared=await prepareSource(updated,{path:f.directory});for(const stage of ['decision','escalation','generation','supervision']){const preview=await f.service.previewInput({source:updated,sourceId:updated.id,itemId:item.id,stage});assert.deepEqual(preview.input.blocks,assembleInput(prepared,f.service.view().items[0],{stage}).blocks);assert.equal(preview.input.stage,stage);if(stage==='escalation')assert.match(preview.serialized,/占位/);if(stage==='supervision')assert.match(preview.input.draft,/占位/);}
 await assert.rejects(f.service.previewInput({source:updated,stage:'system'}),/阶段无效/);assert.equal(f.service.view().sources[0].context,'LEGACY_SHARED');
});

test('actual host failure details survive in run records and organization reports',async t=>{
 const { sessionFailure }=await import('../src/dsh.js');const f=await setup(t);await f.service.refresh(f.source.id);
 f.executor.analyze=async({recordSession})=>{await recordSession('decision-escalation','dmc-original');throw sessionFailure({kind:'error',error:{code:'TRANSPORT',message:'provider transport failed'}},'dmc-original');};
 const report=await f.service.organize(f.source.id,{scope:'history'}),run=f.service.view().runs[0];
 assert.equal(report.failed,1);assert.equal(report.errors[0].sessionId,'dmc-original');assert.match(report.errors[0].message,/TRANSPORT/);assert.equal(run.failure.code,'TRANSPORT');assert.equal(run.failure.sessionId,'dmc-original');assert.equal(run.sessions[0].sessionId,'dmc-original');
});

test('session directory returns only ended or human identities without private background or in-flight sessions',async t=>{
 const f=await setup(t);await f.service.refresh(f.source.id);const item=f.service.view().items[0];
 await f.store.change(state=>{state.items[item.id].sessions=[{sessionId:'old-failure',role:'writer'},{sessionId:'active',role:'writer'},{sessionId:'human',role:'human'}];state.runs.pending={id:'pending',status:'running',sessions:[{sessionId:'active'}]};});
 assert.deepEqual(f.service.sessionDirectory(),{sessionIds:['human','old-failure']});
 await f.store.change(state=>{state.runs.pending.status='failed';});assert.deepEqual(f.service.sessionDirectory(),{sessionIds:['active','human','old-failure']});
});
