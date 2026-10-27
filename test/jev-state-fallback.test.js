import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowExecutor } from '../src/executor.js';

const settings={writerProvider:'offline',writerModel:'ordinary',decisionConfidence:.8,decisionMargin:.2};
const probabilities={0:0,1:1,2:0,3:0};
const jev={answers:{reply:{probabilities:{ignore:1,draft:0,human:0}},importance:{probabilities}}};
const source={workspaceId:'ws',name:'合成来源',context:'字'.repeat(41000),stageContexts:{decision:{context:'DECISION_ONLY'},escalation:{context:'ESCALATION_ONLY'},generation:{context:'GENERATION_ONLY'}}};
const privateItem={id:'i',kind:'private-message',title:'合成私信',payload:{comments:[{id:'1',body:'合成正文',author:'发件人'}]}};
function fixture(overrides={}) {
  const records=[],requests=[],calls=[];
  const executor=new WorkflowExecutor({decision:async input=>{calls.push(input);return jev;},runAgent:async input=>{requests.push(input);return {result:{importance:2,certain:false,reason:'合成依据',...(input.input.blocks.find(b=>b.key==='content').value.kind==='comment'?{choice:'draft'}:{})}};},...overrides});
  return {executor,records,requests,calls,args:{source,item:privateItem,settings,recordDecision:async value=>records.push(value)}};
}
test('oversized private messages skip Jev, retain decision context and use only ordinary importance without probabilities',async()=>{
  const f=fixture(),result=await f.executor.analyze(f.args);
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,1);
  const request=f.requests[0];assert.equal(request.role,'decision-escalation');assert.equal(request.model,'ordinary');
  assert.equal(request.input.stage,'decision');assert.match(JSON.stringify(request.input),/DECISION_ONLY/);assert.doesNotMatch(JSON.stringify(request.input),/ESCALATION_ONLY|GENERATION_ONLY/);
  assert.deepEqual(Object.keys(request.input.questions),['importance']);
  assert.equal(result.importance,2);assert.equal(result.evidence,'insufficient');assert.equal(result.intervention,'none');assert.equal(result.urgent,false);
  const record=f.records.at(-1);assert.ok(record.bypass.stateChars>40000);assert.equal(record.bypass.attempted,false);assert.equal(record.output,undefined);assert.equal(record.resolved.probabilities,undefined);assert.equal(record.escalation.output.reason,'合成依据');
});
test('exact limit uses Jev; one character over uses ordinary model and effective selected/default profile limit',async()=>{
  for (const selected of [undefined,'chosen']) {
    const f=fixture({decisionConfig:()=>({provider:'default',maxStateChars:2,profiles:[{id:selected??'default',maxStateChars:10}]})});
    for (const length of [10,11]) {
      const result=await f.executor.initialDecision({provider:selected,state:'x'.repeat(length)},{});
      assert.equal(Boolean(result.bypass),length===11);
      if(result.bypass)assert.equal(result.bypass.maxStateChars,10);
    }
    assert.equal(f.calls.length,1);
  }
});
test('larger Jev limit keeps long inputs on Jev; runtime length rejection falls back without retry',async()=>{
  const normal=fixture({decisionConfig:()=>({maxStateChars:100000})});
  await normal.executor.analyze(normal.args);assert.equal(normal.calls.length,1);assert.equal(normal.requests.length,0);
  let calls=0;
  const changed=fixture({decisionConfig:()=>({maxStateChars:100000}),decision:async request=>{calls++;throw new Error(`state 有 ${request.state.length} 个字符；本插件最多允许 40000 个。请拆分为多次调用。`);}});
  await changed.executor.analyze(changed.args);assert.equal(calls,1);assert.equal(changed.requests.length,1);assert.equal(changed.records.at(-1).bypass.attempted,true);
});
test('other failures and cancellation never become ordinary model calls; failed fallback retains bypass evidence',async()=>{
  for (const error of [new Error('HTTP 401'),new Error('network timeout'),new Error('state 有 99999 个字符；本插件最多允许 1 个。请拆分为多次调用。')]) {
    const f=fixture({decisionConfig:()=>({maxStateChars:100000}),decision:async()=>{throw error;}});
    await assert.rejects(f.executor.analyze(f.args),e=>e===error);assert.equal(f.requests.length,0);
  }
  const disabled=fixture({decisionConfig:()=>({enabled:false})});await assert.rejects(disabled.executor.analyze(disabled.args),/禁用/);assert.equal(disabled.requests.length,0);
  const cancelled=fixture();await assert.rejects(cancelled.executor.analyze({...cancelled.args,signal:AbortSignal.abort()}));assert.equal(cancelled.requests.length,0);
  const failed=fixture({runAgent:async()=>{throw new Error('ordinary failed');}});await assert.rejects(failed.executor.analyze(failed.args),/ordinary failed/);assert.equal(failed.records.at(-1).bypass.reason,'state-too-long');assert.match(failed.records.at(-1).error,/ordinary failed/);
  const route=fixture();await assert.rejects(route.executor.analyze({...route.args,settings:{}}),/需要模型路由/);assert.equal(route.calls.length,0);
});
test('oversized uncertain comment routes to human, while certain draft still requires writer and independent supervision',async()=>{
  for(const certain of [false,true]) {
    const roles=[],f=fixture({runAgent:async request=>{
      roles.push(request.role);
      if(request.role==='decision-escalation')return {result:{choice:'draft',importance:2,certain,reason:'合成判断'}};
      if(request.role==='writer')return {result:{summary:'草稿',importance:2,urgent:false,intervention:'review',reason:'依据',evidence:'inferred'},draftId:'d',draft:{id:'d',body:'待审核回复'}};
      assert.equal(request.role,'supervisor');return {result:{approved:false,reason:'仅测试监督'}};
    }});
    const result=await f.executor.analyze({...f.args,item:{id:'comment',kind:'comment',body:'评论'}});
    assert.equal(f.calls.length,0);assert.deepEqual(roles,certain?['decision-escalation','writer','supervisor']:['decision-escalation']);
    assert.equal(result.intervention,certain?'review':'human');assert.equal(f.records.at(-1).resolved.certain,certain);assert.equal(f.records.at(-1).resolved.probabilities,undefined);
  }
});
test('ordinary initial judgment must include valid importance; image failures still route to human',async()=>{
  for(const item of [privateItem,{kind:'comment',body:'文字'}]) {
    const f=fixture({runAgent:async()=>({result:{choice:'ignore',certain:true,reason:'missing importance'}})});
    await assert.rejects(f.executor.analyze({...f.args,item}),/重要程度/);
  }
  const f=fixture();const result=await f.executor.analyze({...f.args,item:{kind:'comment',payload:{images:[{url:'https://example.invalid/a.png'}]}}});
  assert.equal(result.intervention,'human');assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
});
