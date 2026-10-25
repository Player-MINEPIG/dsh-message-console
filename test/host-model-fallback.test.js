import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {hostFixture} from './host-fixture.js';
import {Store} from '../src/store.js';
import {ConsoleService,fingerprint} from '../src/core.js';
import {prepareSource} from '../src/source-context.js';
import {installAgentTools} from '../src/agent-tools.js';
const root=process.env.DMC_DSH_ROOT;

test('real DSH warm and cold reports recover removed providers and retired models, retry only failed requests and stop when default fails',{skip:!root,timeout:30000},async()=>{
 const f=await hostFixture(root),{ctx,llm,workspace,registeredWorkspace}=f;
 const directory=await mkdtemp(join(resolve('.local'),'host-fallback-')),store=await new Store(directory).start();
 const service=new ConsoleService({store,executor:{},connectors:{},workspaces:{resolve:id=>ctx.workspaceRegistry.get(id)}});
 const requests=[];let owner,handle,retired=false,defaultBroken=false;
 try {
  class Offline extends llm.LlmAdapter {
   async resolveModel(provider,id){if(retired&&id==='retired')throw new llm.LlmError('retired model','MODEL_NOT_FOUND');return {provider,id,name:id};}
   async *stream(request){
    requests.push({provider:request.provider,model:request.model});
    if(request.model==='broken'||defaultBroken){yield {type:'finish',reason:{kind:'error',failure:{code:'HTTP_ERROR',message:'upstream unavailable'}}};return;}
    const followup=request.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('REPORT'));
    if(followup){yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'保留既有历史并处理回报'}};yield {type:'finish',reason:{kind:'stop'}};return;}
    const analysis={summary:'合成',importance:0,urgent:false,reason:'合成验证',intervention:'none',evidence:'confirmed'};
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'save-once',name:'run_code',arguments:JSON.stringify({code:`return await tools.dmc_submit_result(${JSON.stringify({kind:'analysis',operationKey:'save-once',analysis})});`,description:'保存合成分析'})}};yield {type:'finish',reason:{kind:'tool-calls'}};
   }
  }
  const old=ctx.llm.registerAdapter(['old-provider'],new Offline());ctx.llm.registerAdapter(['current-provider'],new Offline());
  await service.configure({writerProvider:'current-provider',writerModel:'v1'});
  const source=await service.saveSource({workspaceId:registeredWorkspace.id,name:'回退合成',platform:'github',target:'example/repo',types:['issue']});
  store.applyFetch(source.id,[{remoteId:'issue:1',kind:'issue',title:'合成',body:'合成',payload:{}}],{},new Date().toISOString(),fingerprint);
  const item=store.item(`${source.id}:issue:1`),prepared=await prepareSource(source,{path:workspace});
  store.createRun({id:'fallback-run',itemId:item.id,sourceId:source.id,workspaceId:source.workspaceId,version:item.version,contextVersion:prepared.contextVersion,sourceContextVersion:source.contextVersion,sourceSnapshot:prepared,baseAnalysisRevision:0,status:'running',startedAt:new Date().toISOString()});
  await installAgentTools(ctx,service);owner=await f.executorOwner(service);
  const receipt=await owner.executor.runAgent({runId:'fallback-run',role:'investigate',workspaceId:source.workspaceId,provider:'old-provider',model:'original',input:{body:'合成'},instructions:'保存合成分析',title:'合成'});
  const id=receipt.sessionId;let agent=ctx.agents.get(id);
  async function report(){agent.followup(llm.createUserMessage({source:{kind:'synthetic-task-report',form:'instructions'},content:[{type:'text',text:'REPORT 合成远端回报'}]}));await agent.whenIdle();return agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason;}
  old();assert.equal((await report()).kind,'completed');assert.deepEqual(requests.at(-1),{provider:'current-provider',model:'v1'});
  await owner.dispose();owner=null;
  await service.configure({writerProvider:'current-provider',writerModel:'v2'});
  handle=await ctx.agents.resume({resumeSessionId:id,agentOptions:{provider:'old-provider',model:'original'},async setup(agentCtx,resumed){await ctx.agentPresets.mount(agentCtx,resumed.session.header.agentPreset);}});agent=handle.agent;
  assert.equal((await report()).kind,'completed');assert.deepEqual(requests.at(-1),{provider:'current-provider',model:'v2'});
  let override={provider:'current-provider',model:'retired'};
  const stop=agent.ctx.on('agent/request',async(_event,next)=>({...await next(),...override}));retired=true;
  assert.equal((await report()).kind,'completed');assert.equal(requests.at(-1).model,'v2');
  override={provider:'current-provider',model:'broken'};
  const before=requests.length;assert.equal((await report()).kind,'completed');assert.deepEqual(requests.slice(before).map(r=>r.model),['broken','v2']);
  defaultBroken=true;
  const start=requests.length,reason=await report();assert.notEqual(reason.kind,'completed');assert.match(JSON.stringify(reason),/全局默认模型不可用/);assert.deepEqual(requests.slice(start).map(r=>r.model),['broken','v2']);
  stop();
  assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='dmc_submit_result').length,1,'model retry never repeats prior tools');
  const headers=agent.session.snapshotEvents().filter(e=>e.type==='request/header').map(e=>e.data.header.config.model);
  assert.ok(headers.includes('broken'));assert.ok(headers.includes('v2'));assert.equal(store.receipt(id,'fallback-run').id,receipt.id);
 }finally{await handle?.dispose();await owner?.dispose();await f.close();await service.close();await rm(directory,{recursive:true,force:true});}
});
