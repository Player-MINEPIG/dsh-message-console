import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hostFixture} from '../host-fixture.js';
import * as dmcPlugin from '../../src/plugin.js';
const host=process.env.DMC_DSH_ROOT,taskSource=process.env.TASK_SYSTEM_SOURCE;
const analysis=summary=>({summary,importance:1,urgent:false,urgencyReason:null,reason:'子任务报告证据',intervention:'none',evidence:'confirmed'});
for(const saved of [false,true])test(`real task-system origin queues, cold-delivers and ${saved?'revises':'first-submits'} DMC analysis`,{skip:!host||!taskSource,timeout:30_000},async()=>{
 const f=await hostFixture(host),{ctx,llm,sessions,registeredWorkspace}=f,directory=await mkdtemp(join(resolve('.local'),'integrated-origin-'));
 let taskOwner,dmcOwner,service,returned=false,calls=0,initialCalls=0,originSessionId,expectedTools,reportId;
 try{
  ctx.provide('decisionModels',{ask(){throw new Error('Explicit offline route must not call a decision model');}});
  const taskPlugin=await import(pathToFileURL(join(resolve(taskSource),'packages/task-system/dist/dsh-plugin.js')).href);
  taskOwner=await ctx.plugin(taskPlugin,{role:'planner',nodeId:'aws',databasePath:join(directory,'tasks.sqlite'),keepAlive:false,maintenanceIntervalMs:600000,planningDecisionEnabled:false,requireFreshHeartbeat:false});
  const task=ctx.get('taskSystem'),ledger=task.ledger;
  ledger.registerNode('mbp',{nodeId:'mbp',roles:['executor'],enabled:true,models:[{provider:'offline-child',model:'worker'}],capabilities:[],workspaceIds:[],maxConcurrent:2});
  const catalog=ledger.executionModels.request('catalog',{nodeId:'mbp'}).catalog.request;
  ledger.completeExecutionModels('catalog-ready',{nodeId:'mbp',requestId:catalog.requestId,generation:catalog.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'offline-child',model:'worker'}]}});
  class Offline extends llm.LlmAdapter{
   async resolveModel(provider,id){return{provider,id,name:id};}
   async *stream(request){
    assert.deepEqual(request.tools.map(tool=>tool.name),['run_code']);const messages=JSON.stringify(request.messages);assert.match(messages,/ORIGINAL_DMC_ANALYSIS_CONTEXT/);assert.match(messages,/HOST_WORKSPACE_POLICY_SENTINEL/);
    let code;
    if(!returned){
     initialCalls++;if(initialCalls>3)throw new Error('Dispatch or first analysis repeatedly rejected: '+JSON.stringify(request.messages.findLast(message=>message.role==='tool')));
     if(initialCalls===1)code=`return await tools.task_dispatch(${JSON.stringify({commandId:'mbp-child',title:'Verify issue evidence',description:'Return verified evidence without changing files or sending messages.',nodeId:'mbp',executionModel:{provider:'offline-child',model:'worker'}})});`;
     else if(saved)code=`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'initial',analysis:analysis('原摘要：子任务仍在等待')})});`;
     else{yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'等待已派发的子任务回报'}};yield{type:'finish',reason:{kind:'stop'}};return;}
    }else{
     const resumed=ctx.agents.get(sessions.SessionId(originSessionId)),available=new Set(ctx.tools.schemas(resumed).map(tool=>tool.name));for(const name of expectedTools)assert.ok(available.has(name),'cold return retains original capability '+name);
     calls++;if(calls>3)throw new Error('Continuation repeatedly rejected: '+JSON.stringify(request.messages.findLast(message=>message.role==='tool')));assert.match(messages,/INTEGRATED_CHILD_REPORT/);assert.match(messages,saved?/已经通过 dmc_submit_result 保存过首次 analysis/:/尚未保存首次分析/);
     if(saved&&calls===1)code='return await tools.dmc_read_item({section:"analysis"});';
     else if(saved){const current=JSON.parse(request.messages.findLast(message=>message.role==='tool').content[0].text);code=`return await tools.dmc_revise_analysis(${JSON.stringify({operationKey:'integrated-report',version:current.version,contextVersion:current.contextVersion,expectedAnalysisRevision:current.analysisRevision,analysis:analysis('真实任务回报已消费，业务摘要已更新'),reason:'原派发任务正式结算',evidenceRefs:[reportId]})});`;}
     else code=`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'integrated-first',analysis:analysis('真实任务回报已消费，业务摘要已更新')})});`;
    }
    yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'integrated-'+initialCalls+'-'+calls,name:'run_code',arguments:JSON.stringify({code,description:'离线验证任务派发与原会话业务回报'})}};yield{type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  ctx.llm.registerAdapter(['offline-integrated'],new Offline());
  const config={storageDir:join(directory,'console'),githubAuth:'public',autoSchedule:false};
  dmcOwner=await ctx.plugin(dmcPlugin,config);service=ctx.get('messageConsole');
  service.connectors.github={fetch:async()=>({complete:true,items:[{remoteId:'issue:1',kind:'issue',title:'离线问题',body:'ORIGINAL_DMC_ANALYSIS_CONTEXT',payload:{}}]})};
  const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'集成回报验收',platform:'github',target:'example/repository',types:['issue']});await service.refresh(source.id,{organize:false});await service.configure({writerProvider:'offline-integrated',writerModel:'coordinator'});
  const item=service.items(source.id).items[0],organization=await service.organize(source.id,{scope:'history'});assert.equal(organization.failed,0,JSON.stringify(organization));
  const run=ledger.snapshot().runs.find(run=>run.route?.nodeId==='mbp');assert.ok(run,'real public task_dispatch created a Run');assert.equal(run.state,'queued');assert.equal(run.dispatchOrigin.kind,'session');assert.equal(run.dispatchOrigin.continuation.id,'dmc-analysis-v1');
  const sessionId=run.dispatchOrigin.sessionId;originSessionId=sessionId;expectedTools=run.dispatchOrigin.composition.tools;const dmcRunId=service.sessionBinding(sessionId).runId,originalReceipt=service.store.receipt(sessionId);
  assert.equal(task.pendingOriginReturns(sessionId).length,1);assert.equal(task.pendingOriginReturns(sessionId)[0].state,'queued');assert.equal(ledger.pendingSessionMessages('aws').length,0,'queued pending query works before a completion outbox exists');assert.equal(service.store.run(dmcRunId).status,saved?'completed':'waiting-for-task-return');
  await dmcOwner.dispose();dmcOwner=null;assert.equal(ctx.agents.get(sessions.SessionId(sessionId)),undefined);dmcOwner=await ctx.plugin(dmcPlugin,config);service=ctx.get('messageConsole');assert.equal(service.store.run(dmcRunId).status,saved?'completed':'waiting-for-task-return');
  const claim=ledger.claim('claim',{runId:run.runId,nodeId:'mbp',ttlMs:10000}).value;assert.equal(task.pendingOriginReturns(sessionId)[0].state,'running');ledger.submit('finish',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'mbp',fence:claim.attempt.fence,outcome:'success',summary:'INTEGRATED_CHILD_REPORT: verified issue evidence.',report:{title:'Verified evidence',body:'INTEGRATED_CHILD_REPORT: actual ledger report.'}});
  reportId=ledger.history(run.taskId).reports.find(report=>report.runId===run.runId).reportId;
  const message=ledger.pendingSessionMessages('aws')[0];assert.ok(message.completion);returned=true;let reply;try{reply=await task.taskReturns.deliver(message);}catch(error){const history=await ctx.sessionQuery.readSession(sessionId);throw new Error(error.message+'; continuation=' +JSON.stringify({reason:history.events.findLast(event=>event.type==='turn/end')?.data.reason,events:history.events.slice(-8).map(event=>({type:event.type,...(event.type==='user/message'?{source:event.data.source}:{}),...(event.type==='tool/result'?{result:event.data}:{} )})),summary:service.item(item.id).analysis?.summary}));}
  assert.equal(service.item(item.id).analysis.summary,'真实任务回报已消费，业务摘要已更新');assert.equal(service.item(item.id).analysisRevision,saved?2:1);assert.equal(service.store.run(dmcRunId).status,'completed');if(saved)assert.deepEqual(service.store.receipt(sessionId),originalReceipt);else assert.equal(service.source(source.id).lastOrganization.waiting,0);
  ledger.completeSessionMessage('ack',{messageId:message.messageId,nodeId:'aws',state:'completed',reply});assert.equal(task.pendingOriginReturns(sessionId).length,0);
  await task.taskReturns.deliver(message);assert.equal(calls,saved?2:1,'delivery replay does not run another business submission');const log=await ctx.sessionQuery.readSession(sessionId);assert.equal(log.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1);assert.ok(log.events.some(event=>event.type==='tool/ptc-dispatch'&&event.data.name===(saved?'dmc_revise_analysis':'dmc_submit_result')));
  if(process.env.DMC_CONTINUATION_EVIDENCE_DIR){await mkdir(process.env.DMC_CONTINUATION_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.DMC_CONTINUATION_EVIDENCE_DIR,saved?'integrated-revision.json':'integrated-first.json'),JSON.stringify({saved,sessionId,runId:run.runId,originContinuation:run.dispatchOrigin.continuation,reportId,originalToolsRetained:true,pendingBeforeOutbox:true,analysis:service.item(item.id).analysis,analysisRevision:service.item(item.id).analysisRevision,runStatus:service.store.run(dmcRunId).status,pendingAfterAck:task.pendingOriginReturns(sessionId),returnModelCalls:calls,toolCalls:log.events.filter(event=>event.type==='tool/ptc-dispatch').map(event=>event.data.name)},null,2));}
 }finally{await dmcOwner?.dispose();await taskOwner?.dispose();await f.close();await rm(directory,{recursive:true,force:true});}
});
