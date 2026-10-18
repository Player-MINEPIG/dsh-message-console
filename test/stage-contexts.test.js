import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSource } from '../src/config.js';
import { prepareSource, postHistoryText } from '../src/source-context.js';
import { assembleInput, INPUT_STAGES } from '../src/input-assembly.js';
import { WorkflowExecutor } from '../src/executor.js';
const base={workspaceId:'w',name:'source',platform:'bilibili',target:'BV1111111111',types:['comment'],context:'SHARED_CONTEXT',materials:[{kind:'text',name:'shared',text:'SHARED_MATERIAL'}],postHistoryInstruction:'TRUSTED_PHI',inputOrder:['content','materials','source','context']};
const item={id:'i',kind:'comment',title:'title',body:'RAW_BODY',payload:{comments:[{body:'RAW_DISCUSSION'}]},analysis:{summary:'INTERNAL_ANALYSIS_SENTINEL',draft:{body:'GENERATION_LEAK_SENTINEL'}},sessions:[{sessionId:'INTERNAL_SESSION_SENTINEL'}],previous:{body:'PREVIOUS_RAW',analysis:'OLD_INTERNAL_SENTINEL'}};
async function sourceFixture(t){const root=await mkdtemp(join(tmpdir(),'dmc-stages-'));t.after(()=>rm(root,{recursive:true,force:true}));const stageContexts={};for(const key of Object.keys(INPUT_STAGES)){await writeFile(join(root,key+'.md'),key.toUpperCase()+'_MATERIAL');stageContexts[key]={context:key.toUpperCase()+'_CONTEXT',materials:[{kind:'file',name:key,path:key+'.md'}]};}return {root,source:await prepareSource(validateSource({...base,stageContexts}),{path:root})};}
function assertIsolated(input,stage){const text=JSON.stringify(input);assert.match(text,/SHARED_CONTEXT/);assert.match(text,/SHARED_MATERIAL/);assert.match(text,/RAW_BODY/);assert.match(text,/RAW_DISCUSSION/);assert.match(text,/PREVIOUS_RAW/);assert.doesNotMatch(text,/INTERNAL_|GENERATION_LEAK/);for(const key of Object.keys(INPUT_STAGES)){if(key===stage){assert.ok(text.includes(key.toUpperCase()+'_CONTEXT'));assert.ok(text.includes(key.toUpperCase()+'_MATERIAL'));}else {assert.ok(!text.includes(key.toUpperCase()+'_CONTEXT'));assert.ok(!text.includes(key.toUpperCase()+'_MATERIAL'));}}}
test('stage assembly isolates contexts and safe files while retaining raw discussion and legacy shared values',async t=>{
 const {root,source}=await sourceFixture(t);for(const stage of Object.keys(INPUT_STAGES)){const input=assembleInput(source,item,{stage});assertIsolated(input,stage);assert.deepEqual(input.blocks.map(block=>block.key),base.inputOrder);}
 const old=await prepareSource(validateSource(base),{path:root});assert.equal(assembleInput(old,item).blocks.find(block=>block.key==='context').value,'SHARED_CONTEXT');assert.deepEqual((await prepareSource(validateSource({...base,stageContexts:{generation:{context:'',materials:[]}}}),{path:root})).contextVersion,old.contextVersion);
 await writeFile(join(root,'decision.md'),'UPDATED_DECISION_MATERIAL');assert.notEqual((await prepareSource(source,{path:root})).contextVersion,source.contextVersion);
 for(const value of [{unknown:{context:'bad'}},{decision:{context:1}},{generation:{instructions:'system'}},{supervision:{materials:[{kind:'file',name:'bad',path:'../escape.md'}]}}]){if(value.supervision)await assert.rejects(prepareSource(validateSource({...base,stageContexts:value}),{path:root}));else assert.throws(()=>validateSource({...base,stageContexts:value}));}
 assert.ok(postHistoryText(source).includes('TRUSTED_PHI'));
});
test('actual Jev, upgrade, generation and supervisor requests each receive only their own background',async t=>{
 const {source}=await sourceFixture(t),calls=[];let jev;
 const executor=new WorkflowExecutor({decision:async request=>{jev=request;return {answers:{reply:{probabilities:{ignore:.4,draft:.5,human:.1}}}};},runAgent:async request=>{calls.push(request);if(request.role==='decision-escalation')return {result:{choice:'draft',certain:true,reason:'clear'}};if(request.role==='supervisor')return {result:{approved:true,reason:'supported'}};return {result:{summary:'content summary',importance:1,reason:'evidence',urgent:false,urgencyReason:null,intervention:'review',evidence:'confirmed'},draftId:'d',draft:{id:'d',body:'ACTUAL_DRAFT'}};}});
 await executor.analyze({source,item,settings:{writerProvider:'p',writerModel:'m',decisionConfidence:.8,decisionMargin:.2},recordDecision:async()=>{},recordSession:async()=>{}});
 assertIsolated(JSON.parse(jev.state),'decision');assert.match(jev.questions.reply.instructions,/TRUSTED_PHI/);
 for(const [index,stage] of ['escalation','generation','supervision'].entries()){assertIsolated(calls[index].input,stage);assert.match(calls[index].postHistoryInstruction,/TRUSTED_PHI/);}
 assert.ok(calls[0].input.decision);assert.equal(calls[2].input.draft,'ACTUAL_DRAFT');assert.equal(calls[1].input.draft,undefined);
});
