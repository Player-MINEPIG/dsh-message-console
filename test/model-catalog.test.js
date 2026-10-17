import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalog } from '../src/model-catalog.js';
import { modelRoute, changeProvider, canInheritModel } from '../src/model-selection.js';

test('catalog uses host public directories including subscriptions and only exposes explicit public fields',async()=>{
 let modelCalls=0;
 const ctx={llm:{listProviders:()=>[{id:'subscriptions',name:'My subscription',apiKey:'SECRET'},{id:'p2',name:'Provider two',config:{token:'SECRET'}}],listModels:async provider=>{modelCalls++;return [{provider,id:'model-1',name:'Named model',credentials:'SECRET'},{provider:'wrong-provider',id:'wrong',name:'Wrong'}];}},decisionModels:{config:()=>({provider:'profile-1',credential:'SECRET',profiles:[{id:'profile-1',name:'Light decision',provider:'typesafe',model:'jev-1',credential:'SECRET',baseUrl:'private-endpoint'}]})}};
 const directory=createModelCatalog(ctx),catalog=await directory.catalog();assert.equal(modelCalls,0);
 assert.deepEqual(catalog.providers,[{id:'subscriptions',name:'My subscription'},{id:'p2',name:'Provider two'}]);assert.deepEqual(catalog.decisionProfiles,[{id:'profile-1',name:'Light decision'}]);assert.equal(catalog.defaultDecisionProfile,'profile-1');assert.doesNotMatch(JSON.stringify(catalog),/SECRET|private-endpoint/);
 const models=await directory.models('subscriptions');assert.deepEqual(models,[{id:'model-1',name:'Named model',provider:'subscriptions'}]);assert.equal(modelCalls,1);await assert.rejects(directory.models('deleted'),/不在宿主目录/);
 ctx.llm.listModels=async()=>{throw new Error('SECRET');};await assert.rejects(directory.models('p2'),error=>!error.message.includes('SECRET')&&error.message.includes('暂不可用'));
});
test('provider changes clear bound models and cannot inherit a model from another provider',()=>{
 const defaults={writerProvider:'p1',writerModel:'p1-model',supervisorProvider:'',supervisorModel:'supervised-p1'};
 const changed=changeProvider({},'writerProvider','p2',{defaults});assert.equal(changed.writerModel,'');assert.equal(changed.supervisorModel,'');
 assert.equal(canInheritModel(defaults,{...defaults,...changed}),false);assert.equal(canInheritModel(defaults,{...defaults,...changed},true),false);
 assert.deepEqual(modelRoute({...defaults,...changed},true),{provider:'p2',model:''});
 const selected={...defaults,writerProvider:'p2',writerModel:'p2-model',supervisorProvider:'p3',supervisorModel:''};assert.deepEqual(modelRoute(selected,true),{provider:'p3',model:''});
 assert.deepEqual(changeProvider({writerProvider:'p2',writerModel:'old'},'writerProvider','',{inherit:true}),{});
 const reset=changeProvider({...changed,writerModel:'selected-p2'},'writerProvider','',{inherit:true,defaults});assert.deepEqual(reset,{});assert.deepEqual(modelRoute({...defaults,...reset},true),{provider:'p1',model:'supervised-p1'});
 assert.deepEqual(modelRoute({writerProvider:'p2',writerModel:'new',supervisorProvider:'',supervisorModel:''},true),{provider:'p2',model:'new'});
});
