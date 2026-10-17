import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createModelCatalog } from '../src/model-catalog.js';
import * as jev from 'dsh-jev-plugin';

const root=process.env.DMC_DSH_ROOT;
test('pinned Jev fork mounts on stock DSH and calls an offline native provider without credentials', {skip:!root,timeout:10_000},async()=>{
  const require=createRequire(join(resolve(root),'package.json'));
  const load=name=>import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const {Context}=await load('cordis'),llm=await load('dsh-llm');
  const ctx=new Context(),directory=await mkdtemp(join(tmpdir(),'dmc-jev-host-')),requests=[];
  try {
    await ctx.plugin(llm.default);
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider,id){return {provider,id,name:id};}
      async *stream(request){
        requests.push(request);
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'block-end',index:0,block:{type:'text',text:'{"answers":{"reply":{"type":"choice","choice":"ignore","probabilities":{"ignore":0.95,"draft":0.03,"human":0.02}}}}'}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
    ctx.llm.registerAdapter(['offline'],new Offline());
    await ctx.plugin(jev,{enabled:true,provider:'offline-profile',dataDir:directory,profiles:[{id:'offline-profile',name:'Offline decision',provider:'native',nativeProvider:'offline',model:'test'}]});
    const catalog=await createModelCatalog(ctx).catalog();
    assert.deepEqual(catalog.decisionProfiles,[{id:'offline-profile',name:'Offline decision'}]);
    assert.equal(catalog.defaultDecisionProfile,'offline-profile');
    const question={state:'OFFLINE_STATE',questions:{reply:{type:'choice',instructions:'Choose a handling path.',criteria:{ignore:'Nothing to do',draft:'Prepare a draft',human:'Ask the user'}}}};
    const result=await ctx.decisionModels.ask(question);
    assert.equal(result.provider,'offline-profile');
    assert.deepEqual(result.answers.reply,{type:'choice',choice:'ignore',probabilities:{ignore:0.95,draft:0.03,human:0.02}});
    assert.equal(requests.length,1);
    assert.equal(requests[0].provider,'offline');
    assert.ok(JSON.stringify(requests[0].messages).includes('OFFLINE_STATE'));
    assert.equal(ctx.decisionModels.activeCount,0);
  } finally {await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});}
});
