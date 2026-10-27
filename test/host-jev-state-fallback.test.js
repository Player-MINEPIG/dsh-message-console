import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostFixture } from './host-fixture.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { installAgentTools } from '../src/agent-tools.js';

const root=process.env.DMC_DSH_ROOT;
for(const kind of ['private-message','comment']) test(`real DSH/PTC persists oversized ${kind} initial judgment with no Jev request or draft`,{skip:!root,timeout:30000},async()=>{
  const f=await hostFixture(root),{ctx,llm,registeredWorkspace}=f;
  const directory=await mkdtemp(join(resolve('.local'),'host-jev-bypass-')),store=await new Store(directory).start();
  let owner,service,jevCalls=0,calls=0;
  try {
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:200000}};}
      async *stream(request){
        calls++;
        assert.match(JSON.stringify(request.messages),/DECISION_ONLY/);assert.doesNotMatch(JSON.stringify(request.messages),/ESCALATION_ONLY/);
        const submission={kind:'decision',operationKey:'initial',importance:2,certain:true,reason:'合成重要程度依据',...(kind==='comment'?{choice:'ignore'}:{})};
        const code=calls===1?'return await tools.dmc_read_item({section:"context"});':`return await tools.dmc_submit_result(${JSON.stringify(submission)});`;
        if(calls===2)assert.match(JSON.stringify(request.messages.findLast(message=>message.role==='tool')),/DECISION_ONLY/);
        assert.ok(calls<=2,'no retry or extra judgment');
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:`call-${calls}`,name:'run_code',arguments:JSON.stringify({code,description:'保存合成判断'})}};
        yield {type:'finish',reason:{kind:'tool-calls'}};
      }
    }
    ctx.llm.registerAdapter(['offline-initial'],new Offline());
    ctx.provide('decisionModels',{config:()=>({maxStateChars:40000}),ask:async()=>{jevCalls++;throw new Error('must bypass Jev');}});
    owner=await f.executorOwner(()=>service);
    service=new ConsoleService({store,executor:owner.executor,workspaces:{resolve:id=>ctx.workspaceRegistry.get(id)},connectors:{bilibili:{identity:async()=>({id:'10'}),status:()=>({ready:true}),fetch:async()=>({complete:true,items:[{remoteId:'synthetic',kind,title:'合成输入',body:'原文',payload:{comments:[{id:'1',body:'合成消息'}]}}]})}}});
    await installAgentTools(ctx,service);await service.configure({writerProvider:'offline-initial',writerModel:'ordinary'});
    const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'合成超限',platform:'bilibili',target:kind==='private-message'?'private-messages':'BV1111111111',types:[kind],context:'x'.repeat(39000),stageContexts:{decision:{context:'DECISION_ONLY'+'x'.repeat(2000)},escalation:{context:'ESCALATION_ONLY'}}});
    await service.refresh(source.id,{organize:false});const report=await service.organize(source.id,{scope:'history'});
    assert.equal(report.failed,0,JSON.stringify(report));assert.equal(report.completed,1);assert.equal(jevCalls,0);assert.equal(calls,2);
    const item=service.items(source.id).items[0],run=store.run(service.runs(item.id).items[0].id);
    assert.equal(item.analysis.importance,2);assert.equal(item.analysis.urgent,false);assert.equal(item.analysis.intervention,'none');assert.equal(service.drafts(item.id).total,0);
    assert.equal(run.decision.bypass.attempted,false);assert.equal(run.decision.output,undefined);assert.equal(run.decision.resolved.probabilities,undefined);assert.equal(run.sessions.length,1);
    const session=await ctx.sessionQuery.readSession(run.sessions[0].sessionId);
    assert.ok(session.events.some(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='dmc_submit_result'));
    assert.ok(session.events.some(event=>event.type==='tool/result'));
    if(kind==='private-message') {
      const binding={sessionId:run.sessions[0].sessionId};
      await assert.rejects(service.submitFromSession(binding,{kind:'decision',operationKey:'invalid',choice:'draft',importance:2,certain:true,reason:'invalid'}),/格式无效/);
      await assert.rejects(service.submitFromSession(binding,{kind:'draft',operationKey:'invalid',body:'不能保存'}),/无权/);
    }
    await owner.dispose();owner=null;
    const history=await ctx.sessionQuery.readSession(run.sessions[0].sessionId);assert.deepEqual(history.events,session.events,'real history survives owner disposal');
  } finally {await owner?.dispose();await service?.close();if(!service)await store.close();await f.close();await rm(directory,{recursive:true,force:true});}
});
