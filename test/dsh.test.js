import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolve } from 'node:path';
import { createDshExecutor, sessionFailure } from '../src/dsh.js';

function fixture({ noSubmission = false, failFinalFlush = false, unavailable = false, failAttach = false, storageDirectory = resolve('.local') } = {}) {
  const created = [], snapshots = [], inputs = [], attached = [], bindings = new Map(); let flushes = 0, disposed = 0;
  const ctx = {
    workspaceRegistry: { list:()=>[], get:id=>id==='ws-1'?{path:'/tmp',status:async()=>unavailable?'missing-dir':'ok',attachSession:async id=>{assert.ok(flushes>0);if(failAttach)throw new Error('attach failed');attached.push(id);}}:undefined },
    agents: { async create(options) {
      created.push(options);
      const session = Session.create(options.sessionId);
      let events = [];
      const agent = { session, inbox:{nextStep:[]}, inject(message){this.send(message,'next-step',false);}, send(message,target,wakeup){assert.equal(wakeup,false);this.inbox.nextStep.push(message);session.append('agent/inbox/spliced',{target,start:0,inserted:[message]});}, cancel() {}, followup(message) { assert.ok(attached.includes(String(session.id))); inputs.push(message); }, async whenIdle() {
        events = [{ type:'assistant/message', data:{turn:1,message:{content:[{type:'text',text:'最终文字不作为业务结果'}]}} }, {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
      } };
      // Only model execution uses a synthetic turn; background uses real Session validation.
      const originalSnapshot = session.snapshotEvents.bind(session);
      session.snapshotEvents = () => events.length ? events : originalSnapshot();
      await options.setup({}, agent);
      snapshots.push(session);
      return { agent, async dispose() { disposed++; } };
    } },
    agentPresets: { async resolve(id) { return {id}; }, async mount(_ctx,id) { assert.equal(id,'ptc'); }, serviceFor() {} },
    permissionPresets: { set(_session,id) { assert.equal(id,'workspace-write'); } },
    sessions: { async flush() { if (++flushes >= 4 && failFinalFlush) throw new Error('disk failure'); } },
    dshPromptAssembler: { store: { applySnapshot() {} } },
  };
  const service={storageDirectory:()=>storageDirectory,bindSession(binding){bindings.set(binding.sessionId,binding);},endSession(){},requireSubmission(sessionId){if(noSubmission)throw new Error('本轮没有通过工具保存结果');return {id:'receipt',sessionId,runId:'run-1',kind:'analysis',result:{ok:true}};}};
  return { executor:createDshExecutor(ctx,{createUserMessage,SessionId,service}),created,snapshots,inputs,attached,get disposed(){return disposed;} };
}
test('human background is valid durable pending input without waking a model',async()=>{
  const f=fixture(); const id=await f.executor.conversation({item:{title:'Question',body:'original context'},source:{workspaceId:'ws-1',name:'source'},settings:{writerProvider:'p',writerModel:'m'}});
  assert.equal(f.created[0].sessionId,id);assert.equal(f.created[0].meta.cwd,'/tmp');assert.equal(f.created[0].meta.agentPreset,'ptc');assert.equal(f.inputs.length,0);assert.equal(f.disposed,0);
  const events=f.snapshots[0].snapshotEvents();assert.equal(events.length,1);assert.equal(events[0].type,'agent/inbox/spliced');
  assert.equal(events[0].data.inserted[0].source.kind,'dsh-message-console');assert.match(events[0].data.inserted[0].content[0].text,/original context/);
  const restored=Session.create(SessionId(id),events);assert.equal(restored.snapshotEvents()[0].data.inserted[0].content[0].text,events[0].data.inserted[0].content[0].text);
});
test('agent stages retain separate DSH session links and read durable submissions independently of final text',async()=>{
  const f=fixture(),ids=[];
  for(const role of ['writer','supervisor']){const receipt=await f.executor.runAgent({runId:'run-1',workspaceId:'ws-1',role,input:{text:'source'},instructions:'保存工具结果',provider:'p',model:'m',title:role,onSession:id=>ids.push(id)});assert.deepEqual(receipt.result,{ok:true});}
  assert.equal(new Set(ids).size,2);assert.equal(f.disposed,0);assert.equal(f.inputs.length,2);
});
test('missing tool submission fails despite completed assistant text and retains session',async()=>{
  const f=fixture({noSubmission:true}),ids=[];
  await assert.rejects(f.executor.runAgent({workspaceId:'ws-1',role:'writer',input:{},instructions:'JSON',provider:'p',model:'m',title:'writer',onSession:id=>ids.push(id)}),/通过工具保存/);
  assert.equal(ids.length,1);assert.equal(f.disposed,0);
});
test('final persistence failure retains the created conversation for diagnosis',async()=>{
  const f=fixture({failFinalFlush:true});
  await assert.rejects(f.executor.runAgent({workspaceId:'ws-1',role:'writer',input:{},instructions:'JSON',provider:'p',model:'m',title:'writer'}),/disk failure/);
  assert.equal(f.disposed,0);
});

test('missing workspaces and failed attachment stop before a model can run',async()=>{
  const request={workspaceId:'ws-1',role:'writer',input:{},instructions:'JSON',provider:'p',model:'m',title:'writer'};
  const missing=fixture();await assert.rejects(missing.executor.runAgent({...request,workspaceId:'deleted'}),/不存在/);assert.equal(missing.created.length,0);
  const unavailable=fixture({unavailable:true});await assert.rejects(unavailable.executor.runAgent(request),/目录不可用/);assert.equal(unavailable.created.length,0);
  const failed=fixture({failAttach:true});await assert.rejects(failed.executor.runAgent(request),/attach failed/);assert.equal(failed.inputs.length,0);assert.equal(failed.disposed,1);
});

test('human background uses shared and generation context without leaking other stages or prior analysis',async()=>{
 const f=fixture();
 await f.executor.conversation({item:{title:'question',body:'RAW_HUMAN',analysis:{summary:'OLD_ANALYSIS_PRIVATE'},sessions:[{sessionId:'OLD_SESSION_PRIVATE'}]},source:{workspaceId:'ws-1',name:'source',context:'HUMAN_SHARED',stageContexts:{generation:{context:'HUMAN_GENERATION',materials:[{kind:'text',name:'g',text:'GENERATION_NOTES'}]},decision:{context:'DECISION_PRIVATE'}}},settings:{writerProvider:'p',writerModel:'m'}});
 const text=f.snapshots[0].snapshotEvents()[0].data.inserted[0].content[0].text;
 assert.match(text,/HUMAN_SHARED/);assert.match(text,/HUMAN_GENERATION/);assert.match(text,/GENERATION_NOTES/);assert.match(text,/RAW_HUMAN/);assert.doesNotMatch(text,/DECISION_PRIVATE|OLD_ANALYSIS_PRIVATE|OLD_SESSION_PRIVATE/);assert.equal(f.inputs.length,0);
});

test('session termination preserves the real provider failure and identity without inventing a transport cause',()=>{
 const error=sessionFailure({kind:'error',error:{code:'TRANSPORT',message:'DeepSeek Messages transport failed'}},'dmc-original');
 assert.match(error.message,/TRANSPORT/);assert.match(error.message,/DeepSeek Messages transport failed/);assert.match(error.message,/dmc-original/);assert.doesNotMatch(error.message,/ECONNRESET|DNS|HTTP/);
 assert.deepEqual(error.sessionFailure,{sessionId:'dmc-original',kind:'error',code:'TRANSPORT',message:'DeepSeek Messages transport failed'});
 const http=sessionFailure({kind:'error',error:{code:'AUTHENTICATION',status:401,message:'not authorized'}},'same-id');assert.match(http.message,/HTTP 401/);assert.equal(http.sessionFailure.status,401);
 assert.match(sessionFailure(undefined,'id').message,/MISSING_TURN_END/);
});

test('unsafe temporary storage stops before session creation',async()=>{const f=fixture({storageDirectory:'/tmp'});await assert.rejects(f.executor.runAgent({workspaceId:'ws-1',runId:'run',role:'writer',input:{},instructions:'save',provider:'p',model:'m',title:'unsafe'}),/存储目录位于 Agent 可写范围/);assert.equal(f.created.length,0);});
