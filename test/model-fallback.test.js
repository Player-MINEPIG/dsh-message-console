import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveModelFallback,attachModelFallback} from '../src/model-fallback.js';

function fixture() {
 const hooks=new Map(), requests=[],warnings=[];
 let settings={writerProvider:'new',writerModel:'current',supervisorProvider:'review',supervisorModel:'current'};
 const ctx={llm:{async resolveCallConfig(config){requests.push(config);if(config.provider==='removed'||config.model==='retired')throw Object.assign(new Error('model unavailable'),{code:'MODEL_NOT_FOUND'});}},logger:{warn:message=>warnings.push(message)}};
 const agent={session:{id:'bound',header:{cwd:'/workspace'}},ctx:{on(name,handler){hooks.set(name,handler);return()=>hooks.delete(name);}}};
 const service={sessionBinding:()=>({role:'investigate'}),store:{settings:()=>settings}};
 return {ctx,agent,service,hooks,requests,warnings,settings:value=>settings=value};
}
test('valid choice stays; removed providers, retired models and invalid options resolve against current defaults',async()=>{
 const f=fixture(),defaults=()=>({provider:'new',model:'current'}),valid={provider:'original',model:'valid',reasoningEffort:'high'};
 assert.equal(await resolveModelFallback(f.ctx,valid,defaults),valid);
 for(const config of [{provider:'removed',model:'valid'},{provider:'original',model:'retired'},{}])assert.deepEqual(await resolveModelFallback(f.ctx,config,defaults),defaults());
 await assert.rejects(resolveModelFallback(f.ctx,{provider:'removed',model:'old'},()=>({provider:'new',model:'retired'})),/全局默认模型不可用/);
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 await assert.rejects(resolveModelFallback(f.ctx,{provider:'removed',model:'old'},defaults,controller.signal),/cancelled/);
});
test('request failure retries once per turn, reads latest global role default and terminates on default failure',async()=>{
 const f=fixture(),stop=attachModelFallback(f.ctx,f.agent,f.service),signal=new AbortController().signal;
 const request=(turn,config)=>f.hooks.get('agent/request')({turn,signal},async()=>config);
 const failed=()=>f.hooks.get('agent/request-error')({failure:{code:'HTTP_ERROR',message:'retired upstream'},signal},()=>undefined);
 const original={provider:'original',model:'old'};
 assert.deepEqual(await request(1,original),original);assert.deepEqual(await failed(),{kind:'retry'});
 f.settings({writerProvider:'latest',writerModel:'v2'});
 assert.deepEqual(await request(1,original),{provider:'latest',model:'v2'});
 await assert.rejects(failed(),/全局默认模型不可用/);
 assert.deepEqual(await request(2,original),original);
 f.service.sessionBinding=()=>({role:'supervisor'});f.settings({writerProvider:'new',writerModel:'current',supervisorProvider:'review',supervisorModel:'v3'});
 assert.deepEqual(await request(3,{provider:'removed',model:'old'}),{provider:'review',model:'v3'});
 stop();assert.equal(f.hooks.size,0);
});
