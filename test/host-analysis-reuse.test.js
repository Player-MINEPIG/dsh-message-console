import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Store} from '../src/store.js';
import {ConsoleService,fingerprint} from '../src/core.js';
import {prepareSource} from '../src/source-context.js';
import {installAgentTools} from '../src/agent-tools.js';
import {hostFixture} from './host-fixture.js';
const root=process.env.DMC_DSH_ROOT;
const analysis={summary:'合成轮次',importance:1,urgent:false,urgencyReason:null,reason:'离线验证',intervention:'none',evidence:'confirmed'};
test('real PTC reuses earliest analysis session warm and cold with current receipts, route and human history', {skip:!root,timeout:40000},async()=>{
 const f=await hostFixture(root),{ctx,llm,sessions,workspace,registeredWorkspace}=f;
 const directory=await mkdtemp(join(resolve('.local'),'host-reuse-')),store=await new Store(directory).start();
 const service=new ConsoleService({store,executor:{},connectors:{},workspaces:{resolve:async id=>ctx.workspaceRegistry.get(id)}});
 let owner,calls=0;const requests=[];let hold,started;
 try {
  class Offline extends llm.LlmAdapter {
   async resolveModel(provider,id){return {provider,id,name:id};}
   async *stream(request){
    calls++;requests.push({provider:request.provider,model:request.model,messages:request.messages});
    const text=JSON.stringify(request.messages.filter(m=>m.role==='user').slice(-2));
    if(text.includes('HOLD_HUMAN')){started();await new Promise(resolve=>hold=resolve);}
    if(request.model==='read-only'||text.includes('HUMAN_HISTORY')||text.includes('HOLD_HUMAN')){
     yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'保留人工讨论'}};yield {type:'finish',reason:{kind:'stop'}};return;
    }
    const code=`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'same-public-key',analysis:{...analysis,summary:`轮次${calls}`}})});`;
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:`reuse-${calls}`,name:'run_code',arguments:JSON.stringify({code,description:'合成保存'})}};yield {type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  ctx.llm.registerAdapter(['offline-original','offline-next'],new Offline());
  const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'复用合成',platform:'github',target:'example/repo',types:['issue']});
  const raw={remoteId:'issue:1',kind:'issue',title:'合成问题',body:'ROUND_ONE_CONTENT',payload:{}};
  store.applyFetch(source.id,[raw],{},new Date().toISOString(),fingerprint);const itemId=`${source.id}:issue:1`;let n=0;
  async function run(model='original',provider='offline-original'){
   const prepared=await prepareSource(service.source(source.id),{path:workspace}),item=store.item(itemId),r=store.createRun({id:`reuse-run-${++n}`,itemId,sourceId:source.id,workspaceId:source.workspaceId,version:item.version,contextVersion:prepared.contextVersion,sourceContextVersion:service.source(source.id).contextVersion,sourceSnapshot:prepared,baseAnalysisRevision:item.analysisRevision,status:'running',startedAt:new Date().toISOString()});
   const receipt=await owner.executor.runAgent({runId:r.id,role:'investigate',workspaceId:source.workspaceId,provider,model,input:{body:item.body,context:prepared.context},instructions:'用工具保存合成分析',title:'合成复用'});store.updateRun(r.id,{status:'completed',finishedAt:new Date().toISOString()});return {run:r,receipt};
  }
  await installAgentTools(ctx,service);owner=await f.executorOwner(service);service.executor=owner.executor;
  const one=await run(),id=one.receipt.sessionId,agent=ctx.agents.get(sessions.SessionId(id));const original=store.run(one.run.id);
  const beforeOpen=agent.session.snapshotEvents(),beforeCalls=calls;
  assert.deepEqual(await service.openConversation(itemId),{sessionId:id});assert.equal(calls,beforeCalls);assert.deepEqual(agent.session.snapshotEvents(),beforeOpen);
  agent.followup(llm.createUserMessage({source:{kind:'user',form:'instructions'},content:[{type:'text',text:'HUMAN_HISTORY'}]}));await agent.whenIdle();
  store.applyFetch(source.id,[{...raw,body:'ROUND_TWO_CONTENT'}],{},new Date().toISOString(),fingerprint);
  const two=await run('next','offline-next');assert.equal(two.receipt.sessionId,id);assert.notEqual(two.receipt.id,one.receipt.id);assert.equal(two.receipt.adopted,true);assert.equal(requests.at(-1).model,'next');
  assert.match(JSON.stringify(requests.at(-1).messages),/ROUND_ONE_CONTENT/);assert.match(JSON.stringify(requests.at(-1).messages),/HUMAN_HISTORY/);assert.match(JSON.stringify(requests.at(-1).messages),/ROUND_TWO_CONTENT/);assert.deepEqual(store.run(one.run.id),original);
  agent.followup(llm.createUserMessage({source:{kind:'user',form:'instructions'},content:[{type:'text',text:'HUMAN_HISTORY after round'}]}));await agent.whenIdle();assert.equal(requests.at(-1).model,'original','next human turn restores original route');
  const ready=new Promise(resolve=>started=resolve);agent.followup(llm.createUserMessage({source:{kind:'user',form:'instructions'},content:[{type:'text',text:'HOLD_HUMAN'}]}));await ready;
  const binding=service.sessionBinding(id);await assert.rejects(run('busy','offline-next'),/idle|busy|active work|空闲|忙/);assert.equal(service.sessionBinding(id).runId,binding.runId);assert.equal(ctx.agents.get(sessions.SessionId(id)),agent);hold();await agent.whenIdle();
  await agent.whenIdle();
  service.bindSession({sessionId:'newer-compatible-analysis',runId:two.run.id,role:'investigate',workspaceId:source.workspaceId,cwd:workspace});
  const newer=await ctx.agents.create({sessionId:sessions.SessionId('newer-compatible-analysis'),meta:{cwd:workspace,agentPreset:'ptc'},agentOptions:{provider:'offline-original',model:'newer'},async setup(agentCtx,resumed){await ctx.agentPresets.mount(agentCtx,'ptc');ctx.permissionPresets.set(resumed.session,'workspace-write');}});
  await ctx.sessions.flush(newer.agent.session);await newer.dispose();
  await service.saveSource({...service.source(source.id),context:'ROUND_THREE_SOURCE_CONTEXT'},source.id);
  await owner.dispose();owner=null;assert.equal(ctx.agents.get(sessions.SessionId(id)),undefined);
  owner=await f.executorOwner(service);service.executor=owner.executor;
  const coldEvents=(await ctx.sessionQuery.readSession(id)).events,coldCalls=calls;
  assert.deepEqual(await service.openConversation(itemId),{sessionId:'newer-compatible-analysis'});
  assert.equal(ctx.agents.get(sessions.SessionId(id)),undefined);assert.equal(calls,coldCalls);assert.deepEqual((await ctx.sessionQuery.readSession(id)).events,coldEvents);
  store.applyFetch(source.id,[{...raw,body:'ROUND_THREE_CONTENT'}],{},new Date().toISOString(),fingerprint);
  const three=await run('cold','offline-next');assert.equal(three.receipt.sessionId,id);assert.equal(requests.at(-1).model,'cold');assert.match(JSON.stringify(requests.at(-1).messages),/HUMAN_HISTORY/);assert.match(JSON.stringify(requests.at(-1).messages),/ROUND_THREE_CONTENT/);assert.match(JSON.stringify(requests.at(-1).messages),/ROUND_THREE_SOURCE_CONTEXT/);assert.notEqual(three.run.contextVersion,two.run.contextVersion);assert.equal(store.sessionBinding('newer-compatible-analysis').runId,two.run.id);
  assert.equal(store.receipt(id,one.run.id).id,one.receipt.id);assert.equal(store.receipt(id,two.run.id).id,two.receipt.id);
  const events=(await ctx.sessionQuery.readSession(id)).events;assert.equal(events.filter(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='dmc_submit_result').length,3);
  const resumed=ctx.agents.get(sessions.SessionId(id));await resumed.whenIdle();
  const beforeBinding=service.sessionBinding(id),assembler=ctx.dshPromptAssembler.store,apply=assembler.applySnapshot;
  assembler.applySnapshot(id,null);let restoredNull=false;
  assembler.applySnapshot=function(sessionId,snapshot){if(snapshot!==null)throw new Error('synthetic assembly failure');restoredNull=true;return apply.call(this,sessionId,snapshot);};
  try{await assert.rejects(run('rollback','offline-next'),/synthetic assembly failure/);}finally{assembler.applySnapshot=apply;}
  assert.ok(restoredNull);assert.deepEqual(service.sessionBinding(id),beforeBinding);assert.equal(assembler.selection(id),null);assert.equal(resumed.inbox.nextTurn.length,0);
  const parked=llm.createUserMessage({source:{kind:'user',form:'instructions'},content:[{type:'text',text:'HUMAN_HISTORY parked'}]});resumed.send(parked,'next-turn',false);
  await assert.rejects(run('pending','offline-next'),/待处理消息/);assert.equal(service.sessionBinding(id).runId,beforeBinding.runId);assert.ok(resumed.inbox.nextTurn.some(message=>message.id===parked.id));resumed.inbox.remove(parked.id);
  const {setSandboxMode}=await f.load('dsh-sandbox-policy');setSandboxMode(resumed.session,'read-only');
  await assert.rejects(run('read-only','offline-next'),/持久|提交|结果/);assert.equal(ctx.sandboxPolicy.overrideOf(resumed.session),'read-only');assert.equal(store.receipt(id,service.sessionBinding(id).runId),null);
 }finally{hold?.();await owner?.dispose();await f.close();await service.close();await rm(directory,{recursive:true,force:true});}
});

test('a stage settles its own turn and never cancels a queued human turn; timeout can later save an actual result', {skip:!root,timeout:15000},async()=>{
 const f=await hostFixture(root),{ctx,llm,sessions,workspace,registeredWorkspace}=f;
 const directory=await mkdtemp(join(resolve('.local'),'host-turn-boundary-')),store=await new Store(directory).start();
 const service=new ConsoleService({store,executor:{},connectors:{},workspaces:{resolve:async id=>ctx.workspaceRegistry.get(id)}});
 const keepAlive=setInterval(()=>{},1000);
 let owner,releaseHuman,humanStarted,agent,id,mode='queue-human';const humanReady=new Promise(resolve=>humanStarted=resolve);
 try {
  class Offline extends llm.LlmAdapter {
   async resolveModel(provider,id){return {provider,id,name:id};}
   async *stream(request){
    const text=JSON.stringify(request.messages.filter(m=>m.role==='user').slice(-2));
    if(text.includes('LONG_HUMAN')){humanStarted();await new Promise(resolve=>releaseHuman=resolve);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'人工轮完成'}};yield {type:'finish',reason:{kind:'stop'}};return;}
    if(mode==='timeout'){await new Promise((resolve,reject)=>{if(request.signal.aborted)reject(request.signal.reason);else request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});return;}
    if(mode==='queue-human'){agent.followup(llm.createUserMessage({source:{kind:'user',form:'instructions'},content:[{type:'text',text:'LONG_HUMAN'}]}));}
    const code=`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'save',analysis})});`;
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'boundary-call',name:'run_code',arguments:JSON.stringify({code,description:'边界合成保存'})}};yield {type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  ctx.llm.registerAdapter(['offline-boundary'],new Offline());await installAgentTools(ctx,service);owner=await f.executorOwner(service,{timeoutMs:1000});
  const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'轮次边界合成',platform:'github',target:'example/repo',types:['issue']});
  store.applyFetch(source.id,[{remoteId:'issue:1',kind:'issue',title:'合成',body:'合成',payload:{}}],{},new Date().toISOString(),fingerprint);const item=store.item(`${source.id}:issue:1`),prepared=await prepareSource(source,{path:workspace});
  const makeRun=n=>store.createRun({id:`boundary-${n}`,itemId:item.id,sourceId:source.id,workspaceId:source.workspaceId,version:item.version,contextVersion:prepared.contextVersion,sourceContextVersion:source.contextVersion,sourceSnapshot:prepared,baseAnalysisRevision:store.item(item.id).analysisRevision,status:'running',startedAt:new Date().toISOString()});
  const request=r=>({runId:r.id,role:'investigate',workspaceId:source.workspaceId,provider:'offline-boundary',model:'worker',input:{body:'合成'},instructions:'保存合成分析',title:'合成',onSession:sessionId=>{id=sessionId;agent=ctx.agents.get(sessions.SessionId(id));}});
  const one=makeRun(1),receipt=await owner.executor.runAgent(request(one));await humanReady;
  assert.equal(receipt.runId,one.id);assert.equal(agent.status,'running');await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length,1,'human turn remains uncancelled past stage timer');releaseHuman();await agent.whenIdle();
  mode='timeout';const two=makeRun(2);let failure;await assert.rejects(owner.executor.runAgent(request(two)),error=>{failure=error.sessionFailure;return failure?.code==='TIMEOUT';});assert.equal(failure.cancellationSource,'timeout');assert.equal(failure.timeoutMs,1000);assert.ok(failure.elapsedMs>=1000);
  const end=agent.session.snapshotEvents().findLast(e=>e.type==='turn/end');assert.equal(end.data.reason.kind,'aborted');assert.equal(end.data.reason.reason.reason,'message-console timeout after 1000ms');
  store.updateRun(two.id,{status:'failed',failure,error:'合成阶段超时',finishedAt:new Date(end.time).toISOString()});await agent.whenIdle();
  mode='late';agent.followup(llm.createUserMessage({source:{kind:'offline-synthetic-report',form:'instructions'},content:[{type:'text',text:'合成报告：验证完成，请保存当前分析'}]}));await agent.whenIdle();await ctx.sessions.flush(agent.session);
  const saved=store.receipt(id,two.id),record=service.runs(item.id,{}).items.find(r=>r.id===two.id);assert.equal(saved.adopted,true);assert.equal(record.status,'failed');assert.equal(record.submission.id,saved.id);assert.ok(record.submission.at>=record.finishedAt);assert.equal(store.receipt(id,one.id).id,receipt.id);
 }finally{clearInterval(keepAlive);releaseHuman?.();await owner?.dispose();await f.close();await service.close();await rm(directory,{recursive:true,force:true});}
});
