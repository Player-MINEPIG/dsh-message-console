import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleInput, serializeInput, validateInputOrder, DEFAULT_INPUT_ORDER } from '../src/input-assembly.js';
import { validateSource } from '../src/config.js';
import { prepareSource } from '../src/source-context.js';
import { WorkflowExecutor } from '../src/executor.js';
const source={workspaceId:'w',name:'source',platform:'bilibili',target:'BV1111111111',types:['comment'],description:'intro',tags:['tag'],context:'CONTEXT_ONLY',attentionRules:'RULE_ONLY',resolvedMaterials:[{name:'second',text:'B'},{name:'first',text:'A'}],inputOrder:['content','materials','context','source']};
test('fixed block permutation controls serialization, material order and source fields without changing trust roles',()=>{
  const assembled=assembleInput(source,{body:'CONTENT_ONLY',payload:{comments:[{body:'DISCUSSION_ONLY'}]}});
  const serialized=serializeInput(assembled,{draft:'DRAFT_ONLY'});
  assert.deepEqual(JSON.parse(serialized).blocks.map(block=>block.key),source.inputOrder);
  assert.deepEqual(assembled.blocks[1].value.map(material=>material.name),['second','first']);
  assert.ok(serialized.indexOf('CONTENT_ONLY')<serialized.indexOf('CONTEXT_ONLY'));
  assert.ok(serialized.indexOf('CONTEXT_ONLY')<serialized.indexOf('RULE_ONLY'));
  assert.equal((serialized.match(/DRAFT_ONLY/g)??[]).length,1);
  assert.equal(assembled.blocks.at(-1).value.description,'intro');
  assert.deepEqual(validateInputOrder(),DEFAULT_INPUT_ORDER);
  for(const order of [[],['source','context','materials','materials'],['system','context','materials','content'],'source'])assert.throws(()=>validateInputOrder(order));
  assert.match(serializeInput(assembleInput({...source,resolvedMaterials:undefined,materials:[{kind:'file',name:'x',path:'x.md'}]})),/尚未解析文件/);
});
test('description and tags validate and input order changes context version with legacy defaults',async()=>{
  const valid=validateSource(source);
  assert.deepEqual(valid.tags,['tag']);assert.equal(valid.description,'intro');
  for(const input of [{description:7},{tags:'tag'},{tags:['']},{tags:Array(13).fill('x')},{tags:['x'.repeat(41)]},{inputOrder:['content']}])assert.throws(()=>validateSource({...source,...input}));
  const legacy=await prepareSource({...source,inputOrder:undefined},{path:'/unused'});
  const explicit=await prepareSource({...source,inputOrder:DEFAULT_INPUT_ORDER},{path:'/unused'});
  assert.equal(legacy.contextVersion,explicit.contextVersion);
  assert.notEqual((await prepareSource(source,{path:'/unused'})).contextVersion,explicit.contextVersion);
});
test('Jev state and each agent stage share ordered data blocks, with decision and draft added exactly once',async()=>{
  const calls=[];let jev;
  const executor=new WorkflowExecutor({decision:async request=>{jev=request;return {answers:{reply:{probabilities:{ignore:.4,draft:.5,human:.1}}}};},runAgent:async request=>{calls.push(request);if(request.role==='decision-escalation')return {result:{choice:'draft',certain:true,reason:'clear'}};if(request.role==='supervisor')return {result:{approved:true,reason:'supported'}};return {result:{summary:'s',importance:1,reason:'r',urgent:false,urgencyReason:null,intervention:'review',evidence:'confirmed'},draftId:'d',draft:{id:'d',body:'DRAFT_SENTINEL'}};}});
  await executor.analyze({source:{...source,postHistoryInstruction:'PHI_ONLY'},item:{kind:'comment',body:'CONTENT_SENTINEL'},settings:{writerProvider:'p',writerModel:'m',decisionConfidence:.8,decisionMargin:.2},recordSession:async()=>{},recordDecision:async()=>{}});
  assert.deepEqual(JSON.parse(jev.state).blocks.map(block=>block.key),source.inputOrder);
  assert.match(jev.questions.reply.instructions,/PHI_ONLY/);assert.doesNotMatch(jev.state,/PHI_ONLY/);
  for(const call of calls){assert.deepEqual(call.input.blocks.map(block=>block.key),source.inputOrder);assert.equal((serializeInput(call.input).match(/CONTENT_SENTINEL/g)??[]).length,1);}
  assert.ok(calls[0].input.decision);assert.equal(calls[2].input.draft,'DRAFT_SENTINEL');assert.equal((serializeInput(calls[2].input).match(/DRAFT_SENTINEL/g)??[]).length,1);
});
