import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {Store} from '../src/store.js';
import {ConsoleService} from '../src/core.js';
import {installAgentTools} from '../src/agent-tools.js';
import {createOriginContinuation} from '../src/dsh.js';
import {hostFixture} from './host-fixture.js';
const root=process.env.DMC_DSH_ROOT;
const result=summary=>({summary,importance:1,urgent:false,urgencyReason:null,reason:'真实异步报告证据',intervention:'none',evidence:'confirmed'});
for (const alreadySubmitted of [false,true]) test(`cold asynchronous return restores original analysis tools/context and ${alreadySubmitted?'revises saved':'submits first'} business summary`,{skip:!root,timeout:30_000},async()=>{
 const f=await hostFixture(root),{ctx,llm,sessions,workspace,registeredWorkspace}=f;
 const directory=await mkdtemp(join(resolve('.local'),'origin-continuation-')),store=await new Store(directory).start();
 let body='ORIGINAL_ITEM_CONTEXT',owner,cold,returnCalls=0,data,originalReceipt,initialCalls=0;
 const pendingFile=join(directory,'pending-returns.json');writeFileSync(pendingFile,'{}');
 const service=new ConsoleService({store,executor:{},connectors:{github:{fetch:async()=>({complete:true,items:[{remoteId:'issue:1',kind:'issue',title:'验证异步回报',body,payload:{}}]})}},workspaces:{resolve:id=>ctx.workspaceRegistry.get(id)}});
 try {
  const attach=await installAgentTools(ctx,service);
  ctx.provide('taskSystem',{pendingOriginReturns:sessionId=>JSON.parse(readFileSync(pendingFile,'utf8'))[sessionId]??[]});
  ctx.tools.register({name:'offline_dispatch',description:'Offline fixture: persist an accepted asynchronous task origin.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(_args,exec)=>{const sessionId=String(exec.agent.session.id);writeFileSync(pendingFile,JSON.stringify({[sessionId]:[{taskId:'child-task',runId:'child-run',state:'running'}]}));return{accepted:true};}});
  class Offline extends llm.LlmAdapter {
   async resolveModel(provider,id){return{provider,id,name:id};}
   async *stream(request){
    assert.deepEqual(request.tools.map(tool=>tool.name),['run_code']);
    const messages=JSON.stringify(request.messages);assert.match(messages,/ANALYSIS_ROLE_CONTEXT_SENTINEL/);assert.match(messages,/ORIGINAL_ITEM_CONTEXT/);assert.match(messages,/HOST_WORKSPACE_POLICY_SENTINEL/);
    let code;
    if(request.model==='before-return'){
     initialCalls++;
     if(!alreadySubmitted&&initialCalls===1)code='return await tools.offline_dispatch({});';
     else if(!alreadySubmitted){yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'等待异步任务报告'}};yield{type:'finish',reason:{kind:'stop'}};return;}
     else code=`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'initial',analysis:result('原分析：仍在等待报告')})});`;
    }else{
     returnCalls++;assert.match(messages,alreadySubmitted?/已经通过 dmc_submit_result 保存过首次 analysis/:/尚未保存首次分析/);assert.match(messages,/ASYNC_RETURN_REPORT/);
     if(alreadySubmitted&&returnCalls===1)code='return await tools.dmc_read_item({section:"analysis"});';
     else if(alreadySubmitted){const current=JSON.parse(request.messages.findLast(message=>message.role==='tool').content[0].text);code=`return await tools.dmc_revise_analysis(${JSON.stringify({operationKey:'report-revision',version:current.version,contextVersion:current.contextVersion,expectedAnalysisRevision:current.analysisRevision,analysis:result('报告已核对：业务摘要已更新'),reason:'异步报告已返回',evidenceRefs:['report:scripted-fixture']})});`;}
     else code=`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'report-initial',analysis:result('报告已核对：业务摘要已更新')})});`;
    }
    yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'continuation-'+request.model+'-'+returnCalls,name:'run_code',arguments:JSON.stringify({code,description:'保存异步回报的分析摘要'})}};yield{type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  ctx.llm.registerAdapter(['offline-continuation'],new Offline());
  const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'续接验收',platform:'github',target:'example/repository',types:['issue'],context:'ANALYSIS_ROLE_CONTEXT_SENTINEL'});await service.refresh(source.id,{organize:false});
  const item=service.items(source.id).items[0];
  owner=await f.executorOwner(service);service.executor=owner.executor;await service.configure({writerProvider:'offline-continuation',writerModel:'before-return'});
  const organization=await service.organize(source.id,{scope:'history'}),originalRun=store.runs(item.id,{}).items[0],sessionId=originalRun.sessions[0].sessionId;
  assert.equal(organization.failed,0);
  if(alreadySubmitted){assert.equal(organization.completed,1);originalReceipt=service.requireSubmission(sessionId);assert.equal(originalRun.status,'completed');}
  else{assert.equal(organization.completed,0);assert.equal(organization.waiting,1);assert.equal(originalRun.status,'waiting-for-task-return');assert.equal(store.receipt(sessionId),null);const repeated=await service.organize(source.id,{scope:'history'});assert.equal(repeated.waiting,1);assert.equal(store.runs(item.id,{}).total,1);assert.equal(initialCalls,2);}
  const original=ctx.agents.get(sessions.SessionId(sessionId)),tools=ctx.tools.schemas(original).map(tool=>tool.name).sort();assert.ok(tools.includes('dmc_revise_analysis'));
  data=JSON.parse(JSON.stringify(createOriginContinuation(ctx,service,attach).capture(original)));
  assert.equal(data.role,'investigate');assert.equal(data.runId,originalRun.id);assert.doesNotMatch(JSON.stringify(data),/ANALYSIS_ROLE_CONTEXT_SENTINEL|ORIGINAL_ITEM_CONTEXT|cookie|token|credential/i);
  await owner.dispose();owner=null;assert.equal(ctx.agents.get(sessions.SessionId(sessionId)),undefined);await store.close();await store.start();if(!alreadySubmitted)assert.equal(store.run(originalRun.id).status,'waiting-for-task-return');
  const adapter=createOriginContinuation(ctx,service,attach);
  cold=await ctx.agents.resume({resumeSessionId:sessions.SessionId(sessionId),agentOptions:{provider:'offline-continuation',model:'after-return'},async setup(agentCtx,agent){await ctx.agentPresets.mount(agentCtx,'ptc');await adapter.resume(agentCtx,agent,data);assert.deepEqual(ctx.tools.schemas(agent).map(tool=>tool.name).sort(),tools);}});
  cold.agent.followup(llm.createUserMessage({source:{kind:'task-system',form:'instructions'},content:[{type:'text',text:'ASYNC_RETURN_REPORT: scripted child completed with verified evidence.'}]}));await cold.agent.whenIdle();await ctx.sessions.flush(cold.agent.session);
  assert.equal(cold.agent.session.snapshotEvents().findLast(event=>event.type==='turn/end').data.reason.kind,'completed');assert.equal(service.item(item.id).analysis.summary,'报告已核对：业务摘要已更新');assert.equal(service.item(item.id).analysisRevision,alreadySubmitted?2:1);assert.equal(returnCalls,alreadySubmitted?2:1);
  if(alreadySubmitted)assert.deepEqual(service.requireSubmission(sessionId),originalReceipt);else {assert.equal(service.requireSubmission(sessionId).kind,'analysis');assert.equal(store.run(originalRun.id).status,'completed');assert.equal(service.source(source.id).lastOrganization.waiting,0);assert.equal(service.source(source.id).lastOrganization.status,'completed');assert.equal(service.source(source.id).lastOrganization.completed,1);}
  const savedAnalysis=service.item(item.id);
  const log=await ctx.sessionQuery.readSession(sessionId);assert.ok(log.events.some(event=>event.type==='tool/ptc-dispatch'&&event.data.name===(alreadySubmitted?'dmc_revise_analysis':'dmc_submit_result')));
  await assert.rejects(adapter.resume(cold.agent.ctx,cold.agent,{...data,role:'human'}),/角色、工作区或提示词/);
  await assert.rejects(adapter.resume(cold.agent.ctx,cold.agent,{...data,sessionId:'another-session'}),/角色、工作区或提示词/);
  ctx.dshPromptAssembler.store.applySnapshot(sessionId,{...ctx.dshPromptAssembler.store.selection(sessionId),name:'changed selection'});await assert.rejects(adapter.resume(cold.agent.ctx,cold.agent,data),/提示词/);
  const renewed=createOriginContinuation(ctx,service,attach).capture(cold.agent);await service.saveSource({...service.source(source.id),context:'UPDATED_SOURCE_CONTEXT'},source.id);await assert.rejects(adapter.resume(cold.agent.ctx,cold.agent,renewed),/内容或来源资料已变化/);body='CHANGED_ITEM_CONTEXT';await service.refresh(source.id,{organize:false});await assert.rejects(adapter.resume(cold.agent.ctx,cold.agent,renewed),/内容或来源资料已变化/);
  const evidence={alreadySubmitted,data,summary:savedAnalysis.analysis.summary,returnCalls,sessionId,toolNames:tools,analysisRevision:savedAnalysis.analysisRevision,finalRunStatus:store.run(originalRun.id).status,originalReceiptPreserved:alreadySubmitted?JSON.stringify(service.requireSubmission(sessionId))===JSON.stringify(originalReceipt):null,toolCalls:log.events.filter(event=>event.type==='tool/ptc-dispatch').map(event=>event.data.name)};
  if(process.env.DMC_CONTINUATION_EVIDENCE_DIR){await mkdir(process.env.DMC_CONTINUATION_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.DMC_CONTINUATION_EVIDENCE_DIR,alreadySubmitted?'revision.json':'first-submission.json'),JSON.stringify(evidence,null,2));}
 }finally{await cold?.dispose();await owner?.dispose();await f.close();await service.close();await rm(directory,{recursive:true,force:true});}
});

test('optional task service registers a versioned DMC continuation and disposes its hook with the plugin owner',{skip:!root,timeout:30_000},async()=>{
 const f=await hostFixture(root),directory=await mkdtemp(join(resolve('.local'),'origin-registration-'));let owner,adapter,disposed=false;
 try{
  f.ctx.provide('decisionModels',{ask(){throw new Error('Unexpected decision call');}});
  f.ctx.provide('taskSystem',{registerOriginContinuation(value){adapter=value;return()=>{disposed=true;};}});
  const plugin=await import('../src/plugin.js');owner=await f.ctx.plugin(plugin,{storageDir:directory,githubAuth:'public',autoSchedule:false});
  assert.equal(adapter?.id,'dmc-analysis-v1');assert.equal(adapter.capture({session:{id:'unmanaged',header:{cwd:f.workspace}}}),undefined);
  await owner.dispose();owner=null;assert.equal(disposed,true);
 }finally{await owner?.dispose();await f.close();await rm(directory,{recursive:true,force:true});}
});
