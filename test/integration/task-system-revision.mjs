import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {hostFixture} from '../host-fixture.js';
import * as dmcPlugin from '../../src/plugin.js';
const host=process.env.DMC_DSH_ROOT,taskSource=process.env.TASK_SYSTEM_SOURCE;
const analysis=summary=>({summary,importance:1,urgent:false,urgencyReason:null,reason:'隔离合成报告验证',intervention:'none',evidence:'confirmed'});
for(const cold of [false,true])for(const legacy of [false,true])test(`real task return revises saved analysis (${cold?'cold':'warm'}, ${legacy?'legacy marker':'native origin'})`,{skip:!host||!taskSource,timeout:30_000},async()=>{
 const f=await hostFixture(host),{ctx,llm,sessions,registeredWorkspace}=f,directory=await mkdtemp(join(resolve('.local'),'integrated-revision-'));
 let taskOwner,dmcOwner,service,returned=false,calls=0,initialCalls=0,sessionId,reportId,stopLegacy;
 try{
  ctx.provide('decisionModels',{ask(){throw new Error('Offline issue analysis must not call Jev');}});
  const taskPlugin=await import(pathToFileURL(join(resolve(taskSource),'packages/task-system/dist/dsh-plugin.js')).href);
  taskOwner=await ctx.plugin(taskPlugin,{role:'planner',nodeId:'aws',databasePath:join(directory,'tasks.sqlite'),keepAlive:false,maintenanceIntervalMs:600000,planningDecisionEnabled:false,requireFreshHeartbeat:false});
  const task=ctx.get('taskSystem'),ledger=task.ledger;
  ledger.registerNode('worker',{nodeId:'mbp',roles:['executor'],enabled:true,models:[{provider:'offline-child',model:'worker'}],capabilities:[],workspaceIds:[],maxConcurrent:2});
  const catalog=ledger.executionModels.request('catalog',{nodeId:'mbp'}).catalog.request;
  ledger.completeExecutionModels('catalog-ready',{nodeId:'mbp',requestId:catalog.requestId,generation:catalog.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'offline-child',model:'worker'}]}});
  class Offline extends llm.LlmAdapter{
   async resolveModel(provider,id){return{provider,id,name:id};}
   async *stream(request){
    assert.deepEqual(request.tools.map(tool=>tool.name),['run_code']);const messages=JSON.stringify(request.messages);assert.match(messages,/ORIGINAL_DMC_ANALYSIS_CONTEXT/);assert.match(messages,/HOST_WORKSPACE_POLICY_SENTINEL/);
    let code;
    if(!returned){
     if(++initialCalls>2)throw new Error('Initial tool failed: '+JSON.stringify(request.messages.findLast(message=>message.role==='tool')));
     code=initialCalls===1?`return await tools.task_dispatch(${JSON.stringify({commandId:'child',title:'Isolated evidence fixture',description:'Synthetic read-only test. Do not change files or send messages.',nodeId:'mbp',executionModel:{provider:'offline-child',model:'worker'}})});`:`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'initial',analysis:analysis('原摘要：验证任务已排队')})});`;
    }else{
     if(++calls>2)throw new Error('Revision tool failed: '+JSON.stringify(request.messages.findLast(message=>message.role==='tool')));
     assert.match(messages,/SYNTHETIC_CHILD_REPORT/);
     if(calls===1)code='return await tools.dmc_read_item({section:"analysis"});';
     else{const current=JSON.parse(request.messages.findLast(message=>message.role==='tool').content[0].text);code=`return await tools.dmc_revise_analysis(${JSON.stringify({operationKey:'child-report',version:current.version,contextVersion:current.contextVersion,expectedAnalysisRevision:current.analysisRevision,analysis:analysis('合成报告已核对：看板摘要已更新'),reason:'隔离子任务正式报告已返回',evidenceRefs:[reportId]})});`;}
    }
    yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'revision-'+initialCalls+'-'+calls,name:'run_code',arguments:JSON.stringify({code,description:'隔离验证原会话修订'})}};yield{type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  ctx.llm.registerAdapter(['offline-integrated'],new Offline());
  const config={storageDir:join(directory,'console'),githubAuth:'public',autoSchedule:false};
  dmcOwner=await ctx.plugin(dmcPlugin,config);service=ctx.get('messageConsole');
  if(legacy)stopLegacy=task.registerOriginContinuation({id:'dmc-analysis-v1',capture(agent){const id=String(agent.session.id),b=service.sessionBinding(id),a=ctx.dshPromptAssembler.store.selection(id);if(!b)return;return{version:1,sessionId:id,runId:b.runId,role:b.role,workspaceId:b.workspaceId,sourceId:b.sourceId,itemId:b.itemId,itemVersion:b.version,contextVersion:b.contextVersion,assemblyId:a.id,assemblyHash:createHash('sha256').update(JSON.stringify(a)).digest('hex')};},resume(){throw new Error('Retired adapter must not be needed');}});
  service.connectors.github={fetch:async()=>({complete:true,items:[{remoteId:'issue:1',kind:'issue',title:'合成问题',body:'ORIGINAL_DMC_ANALYSIS_CONTEXT',payload:{}}]})};
  const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'隔离修订验收',platform:'github',target:'example/repository',types:['issue']});await service.refresh(source.id,{organize:false});await service.configure({writerProvider:'offline-integrated',writerModel:'coordinator'});
  const item=service.items(source.id).items[0],organization=await service.organize(source.id,{scope:'history'});assert.equal(organization.completed,1,JSON.stringify(organization));assert.equal(organization.failed,0);
  const run=ledger.snapshot().runs.find(run=>run.route?.nodeId==='mbp');assert.equal(run.state,'queued');assert.equal(run.dispatchOrigin.continuation?.id,legacy?'dmc-analysis-v1':undefined);sessionId=run.dispatchOrigin.sessionId;
  const originalReceipt=service.store.receipt(sessionId),dmcRunId=service.sessionBinding(sessionId).runId;assert.equal(service.store.run(dmcRunId).status,'completed');stopLegacy?.();stopLegacy=null;
  if(cold){await dmcOwner.dispose();dmcOwner=null;assert.equal(ctx.agents.get(sessions.SessionId(sessionId)),undefined);dmcOwner=await ctx.plugin(dmcPlugin,config);service=ctx.get('messageConsole');}else assert.ok(ctx.agents.get(sessions.SessionId(sessionId)));
  const claim=ledger.claim('claim',{runId:run.runId,nodeId:'mbp',ttlMs:10000}).value;
  ledger.submit('finish',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'mbp',fence:claim.attempt.fence,outcome:'success',summary:'SYNTHETIC_CHILD_REPORT: controlled fixture evidence; no real project was tested.',report:{title:'Synthetic evidence fixture',body:'SYNTHETIC_CHILD_REPORT: controlled test data only.'}});
  reportId=ledger.history(run.taskId).reports.find(report=>report.runId===run.runId).reportId;
  const message=ledger.pendingSessionMessages('aws')[0];returned=true;const reply=await task.taskReturns.deliver(message);
  assert.equal(service.item(item.id).analysis.summary,'合成报告已核对：看板摘要已更新');assert.equal(service.item(item.id).analysisRevision,2);assert.deepEqual(service.store.receipt(sessionId),originalReceipt);
  assert.equal(service.items(source.id).items.find(row=>row.id===item.id).analysis.summary,'合成报告已核对：看板摘要已更新');
  const revision=service.runs(item.id).items.find(run=>run.revision);assert.ok(revision);assert.equal(revision.originSession.sessionId,sessionId);
  ledger.completeSessionMessage('ack',{messageId:message.messageId,nodeId:'aws',state:'completed',reply});await task.taskReturns.deliver(message);assert.equal(calls,2);assert.equal(service.item(item.id).analysisRevision,2);
  const log=await ctx.sessionQuery.readSession(sessionId),toolCalls=log.events.filter(event=>event.type==='tool/ptc-dispatch').map(event=>event.data.name);assert.deepEqual(toolCalls,['task_dispatch','dmc_submit_result','dmc_read_item','dmc_revise_analysis']);assert.equal(log.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1);
  if(process.env.DMC_CONTINUATION_EVIDENCE_DIR){await mkdir(process.env.DMC_CONTINUATION_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.DMC_CONTINUATION_EVIDENCE_DIR,`revision-${cold?'cold':'warm'}-${legacy?'legacy':'native'}.json`),JSON.stringify({cold,legacy,sessionId,reportId,analysis:service.item(item.id).analysis,revision,originalReceiptUnchanged:true,returnCalls:calls,toolCalls},null,2));}
 }finally{stopLegacy?.();await dmcOwner?.dispose();await taskOwner?.dispose();await f.close();await rm(directory,{recursive:true,force:true});}
});
