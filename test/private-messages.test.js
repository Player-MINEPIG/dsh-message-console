import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { BilibiliConnector } from '../src/connectors/bilibili.js';
import { WorkflowExecutor, validateImportance } from '../src/executor.js';
import { validateSource, resolveSettings, valuesOf } from '../src/config.js';
import { prepareSource } from '../src/source-context.js';
import { contentInput } from '../src/input-assembly.js';

const input={workspaceId:'ws',name:'私信',platform:'bilibili',target:'private-messages',types:['private-message']};
const row=n=>({msg_seqno:n,msg_key:'99999999999999999999',sender_uid:n%2?20:10,receiver_type:1,receiver_id:n%2?10:20,timestamp:1700000000+n,msg_type:1,msg_status:0,content:JSON.stringify({content:`消息 ${n}`})});
function platform() {
  const state={account:10,latest:100,fail:false,invalid:null,calls:[],sessions:1};
  const transport={identities:{},status:()=>({ready:true,canPublish:true}),async json(_platform,href){
    const url=new URL(href);state.calls.push(url);
    if(url.pathname.endsWith('/nav'))return {isLogin:true,mid:state.account,uname:'合成账号'};
    if(url.pathname.endsWith('/card'))return {card:{name:'合成联系人'}};
    assert.equal(url.hostname,'api.vc.bilibili.com');
    if(url.pathname.endsWith('/get_sessions')) {
      const older=url.searchParams.has('end_ts');
      return {session_list:[{session_type:1,talker_id:older?21:20,session_ts:older?100:200}],has_more:state.sessions===2&&!older?1:0};
    }
    assert.ok(url.pathname.endsWith('/fetch_session_msgs'));
    assert.equal(url.searchParams.get('size'),'100');assert.equal(url.searchParams.has('begin_seqno'),false);
    if(state.fail&&url.searchParams.has('end_seqno'))throw new Error('合成第二页失败');
    const end=Number(url.searchParams.get('end_seqno')??state.latest+1),top=Math.min(state.latest,end-1);
    const messages=Array.from({length:Math.min(100,top)},(_,i)=>row(top-i));
    if(state.receiverAccount)for(const row of messages)if(row.sender_uid===20)row.receiver_id=state.receiverAccount;
    if(state.invalid==='repeat'&&url.searchParams.has('end_seqno'))messages[0]=row(end);
    const result={messages,has_more:top>100?1:0};
    if(state.invalid==='missing')delete result.has_more;
    return result;
  }};
  return {state,connector:new BilibiliConnector(transport)};
}
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'dmc-private-')),store=await new Store(directory).start(),p=platform();
  const service=new ConsoleService({store,connectors:{bilibili:p.connector},executor:{},workspaces:{resolve:async id=>({id,path:directory})}});
  const source=await service.saveSource(input);
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  return {...p,directory,store,service,source,id:`${source.id}:private-message:20`};
}
test('private source binds actual account and remains unique even disabled or forged by caller',async t=>{
  const f=await fixture(t);assert.equal(f.source.accountId,'10');assert.equal(f.service.source(f.source.id).connection.canPublish,false);
  await f.service.saveSource({...input,enabled:false,accountId:'999'},f.source.id);
  assert.equal(f.store.source(f.source.id).accountId,'10');
  await assert.rejects(f.service.saveSource(input),/已存在统一/);
  assert.throws(()=>f.store.saveSource({...f.source,id:'duplicate',enabled:false}),/已存在统一/);
  f.state.account=11;
  await assert.rejects(f.service.saveSource({...input,name:'改名'},f.source.id),/账号不一致/);
  assert.equal(f.store.source(f.source.id).name,input.name);
  assert.throws(()=>validateSource({...input,autoReply:true}),/自动回复/);
  assert.throws(()=>validateSource({...input,types:['comment','private-message']}),/独立/);
  assert.throws(()=>validateSource({...input,target:'BV1111111111'}),/独立/);
  const settings=valuesOf(resolveSettings({},f.source));
  assert.ok('decisionProfile' in settings);assert.equal('writerModel' in settings,false);assert.equal('replyStyle' in settings,false);
});
test('first 100 and multi-page increment retain every message, stable refresh and immutable old versions',async t=>{
  const f=await fixture(t);f.state.latest=150;
  await f.service.refresh(f.source.id,{organize:false});
  const first=f.store.item(f.id);assert.equal(first.payload.comments.length,100);assert.equal(first.payload.comments[0].id,'51');
  assert.equal(f.state.calls.filter(url=>url.pathname.endsWith('/fetch_session_msgs')).length,1);
  f.state.calls=[];f.state.latest=405;
  await f.service.refresh(f.source.id,{organize:false});
  const second=f.store.item(f.id);assert.equal(second.payload.comments.length,355);
  assert.equal(second.payload.comments[0].id,'51');assert.equal(second.payload.comments.at(-1).id,'405');
  assert.equal(f.state.calls.filter(url=>url.pathname.endsWith('/fetch_session_msgs')).length,3);
  assert.equal(new Set(second.payload.comments.map(message=>message.id)).size,355);
  assert.equal(f.store.item(f.id,first.version).payload.comments.length,100);
  assert.equal(f.service.comments(f.id,second.version,{page:3,pageSize:50}).items[0].id,'151');
  const detail=f.service.item(f.id);assert.equal(detail.commentsCount,355);assert.equal(detail.payload.contact.id,'20');assert.ok(detail.payload.collection.note);
  assert.equal(f.service.comments(f.id,second.version,{}).items[0].direction,'incoming');
  await f.service.refresh(f.source.id,{organize:false});assert.equal(f.store.item(f.id).version,second.version);assert.equal(f.store.versions(f.id).total,2);
  assert.match(f.service.content(f.id,{section:'comment',commentId:'405'}).text,/消息 405/);
});
test('failed later page and account switch never advance item snapshots or source baseline',async t=>{
  const f=await fixture(t);await f.service.refresh(f.source.id,{organize:false});const previous=f.store.item(f.id),source=f.store.source(f.source.id);
  f.state.latest=350;f.state.fail=true;await f.service.refresh(f.source.id,{organize:false});
  assert.equal(f.store.item(f.id).version,previous.version);assert.deepEqual(f.store.source(f.source.id).metadata,source.metadata);assert.match(f.store.source(f.source.id).fetchError,/第二页/);
  f.store.updateSource(f.source.id,{retryAt:null});f.state.account=11;f.state.calls=[];
  await f.service.refresh(f.source.id,{organize:false});assert.equal(f.state.calls.length,1);assert.equal(f.store.item(f.id).version,previous.version);assert.match(f.store.source(f.source.id).fetchError,/账号不一致/);
  f.state.account=10;f.state.fail=false;f.state.receiverAccount=11;f.store.updateSource(f.source.id,{retryAt:null});
  await f.service.refresh(f.source.id,{organize:false});assert.equal(f.store.item(f.id).version,previous.version);assert.match(f.store.source(f.source.id).fetchError,/收发账号/);assert.deepEqual(f.store.source(f.source.id).metadata,source.metadata);
});
test('pagination validates termination and direction; hidden watermark is honest and local history remains',async()=>{
  for(const invalid of ['missing','repeat']) {
    const f=platform();f.state.latest=300;f.state.invalid=invalid;
    await assert.rejects(f.connector.fetch({...input,accountId:'10'},{readPreviousItem:()=>({payload:{comments:[{id:'1'}]}})}),/分页/);
  }
  const f=platform();f.state.latest=300;
  const previous={payload:{comments:[{...row(350),id:'350',body:'local old snapshot',createdAt:'2023-01-01T00:00:00Z'}]}};
  const result=await f.connector.fetch({...input,accountId:'10'},{readPreviousItem:()=>previous});
  assert.equal(result.items[0].payload.comments.at(-1).id,'350');assert.match(result.items[0].payload.visibilityLimit,/不能证明/);
});
test('session list pages and media placeholders preserve raw metadata without viewing images or withdrawn text',async t=>{
  const f=await fixture(t);f.state.sessions=2;f.state.latest=3;
  const original=f.connector.transport.json;
  f.connector.transport.json=async (...args)=>{
    const data=await original(...args);
    if(data.messages&&new URL(args[1]).searchParams.get('talker_id')==='21')data.messages=data.messages.map(row=>({...row,sender_uid:row.sender_uid===20?21:row.sender_uid,receiver_id:row.receiver_id===20?21:row.receiver_id}));
    if(data.messages){data.messages[0]={...row(3),sender_uid:new URL(args[1]).searchParams.get('talker_id')==='21'?21:20,msg_type:2,content:JSON.stringify({url:'https://example.invalid/image.png',width:300})};data.messages[1]={...row(2),receiver_id:new URL(args[1]).searchParams.get('talker_id')==='21'?21:20,msg_status:1,content:'SECRET_WITHDRAWN'};}
    return data;
  };
  const result=await f.connector.fetch({...input,accountId:'10'},{});
  assert.equal(result.items.length,2);assert.equal(result.items[0].payload.comments[0].id,'1');
  assert.match(result.items[0].payload.comments[2].body,/模型未查看媒体/);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_WITHDRAWN/);
  assert.match(result.items[0].payload.comments[2].rawContent,/width/);
  f.store.applyFetch(f.source.id,result.items,result.metadata,new Date().toISOString(),fingerprint);
  assert.match(f.service.content(f.id,{section:'comment',commentId:'3'}).text,/width/);
  assert.doesNotMatch(f.service.content(f.id,{section:'comment',commentId:'2'}).text,/SECRET_WITHDRAWN/);
});
test('Jev importance is strict, bounded and never invokes agents even at low confidence',async()=>{
  for(const probabilities of [{0:.25,1:.25,2:.25,3:.25},{0:0,1:0,2:1,3:0}]) {
    let request;const records=[];
    const item={kind:'private-message',title:'私信',body:'UNBOUNDED_BODY',payload:{comments:Array.from({length:220},(_,n)=>({id:String(n+1),body:`TEXT${n+1} `+'字'.repeat(5000),rawContent:'RAW_SECRET'}))}};
    const executor=new WorkflowExecutor({decision:async input=>{request=input;return {answers:{importance:{probabilities}}};},runAgent:async()=>assert.fail('private messages cannot invoke agent')});
    const result=await executor.analyze({source:{name:'私信'},item,settings:{decisionConfidence:.8,decisionMargin:.2},recordDecision:async value=>records.push(value)});
    assert.deepEqual(Object.keys(request.questions),['importance']);assert.equal(result.intervention,'none');assert.equal(result.urgent,false);assert.equal(records.length,1);assert.equal(records[0].output.answers.importance.probabilities,probabilities);
    const content=JSON.parse(request.state).blocks.find(block=>block.key==='content').value;
    assert.equal(content.messages.length,100);assert.equal(content.messages[0].id,'121');assert.equal(content.messages.at(-1).id,'220');
    assert.ok(content.messages.reduce((n,message)=>n+message.body.length,0)<=24000);assert.ok(content.messages.every(message=>message.body.length<=2000));
    assert.doesNotMatch(request.state,/RAW_SECRET|UNBOUNDED_BODY/);assert.equal(item.payload.comments.length,220);
  }
  for(const probabilities of [{0:1},{0:.5,1:.5,2:.5,3:.5},{0:NaN,1:0,2:0,3:1},{0:1,1:0,2:0,3:0,4:0}])assert.throws(()=>validateImportance({answers:{importance:{probabilities}}}),/概率/);
});
test('private drafting is rejected at managed, workspace and Store boundaries without side effects',async t=>{
  const f=await fixture(t);await f.service.refresh(f.source.id,{organize:false});
  const item=f.store.item(f.id),prepared=await prepareSource(f.source,{path:f.directory});
  const run=f.store.createRun({id:'run-private',itemId:f.id,sourceId:f.source.id,workspaceId:'ws',version:item.version,contextVersion:prepared.contextVersion,sourceContextVersion:f.source.contextVersion,status:'open',startedAt:new Date().toISOString()});
  const bind=role=>(role==='supervisor'?f.store:f.service).bindSession({sessionId:role,runId:run.id,role,workspaceId:'ws',cwd:f.directory});
  const analysis={summary:'重要',importance:2,urgent:false,reason:'概率',intervention:'none',evidence:'inferred'};
  for(const [role,submission] of [['human',{kind:'draft',body:'不能存'}],['writer',{kind:'analysis',analysis,draftBody:'不能存'}],['supervisor',{kind:'supervision',approved:true,reason:'不能存'}]]) {
    bind(role);await assert.rejects(f.service.submitFromSession({sessionId:role},{operationKey:role,...submission}),/不支持/);
    const binding=f.store.sessionBinding(role);assert.throws(()=>f.store.submit(binding,'call',{operationKey:role,...submission},prepared.contextVersion,new Date().toISOString()),/不支持/);
  }
  const submission={operationKey:'ordinary',kind:'draft',itemId:f.id,version:item.version,contextVersion:prepared.contextVersion,body:'不能存'};
  await assert.rejects(f.service.submitFromSession({sessionId:'ordinary',actualCwd:f.directory},submission),/不支持/);
  assert.throws(()=>f.store.submitWorkspaceDraft({...run,id:'ordinary-run'},{sessionId:'ordinary',role:'human',runId:'ordinary-run',workspaceId:'ws'},'call',submission,prepared.contextVersion,new Date().toISOString()),/不支持/);
  assert.equal(f.store.drafts(f.id).total,0);assert.equal(f.store.runs(f.id).total,1);assert.equal(f.store.item(f.id).analysis,null);
  const commentSource=await f.service.saveSource({workspaceId:'ws',name:'评论不变',platform:'bilibili',target:'BV1111111111',types:['comment']});
  f.store.applyFetch(commentSource.id,[{remoteId:'comment:1',kind:'comment',title:'评论',body:'评论原文',payload:{comments:[]}}],{},new Date().toISOString(),fingerprint);
  const comment=f.store.item(`${commentSource.id}:comment:1`),commentRun=f.store.createRun({...run,id:'comment-run',itemId:comment.id,sourceId:commentSource.id,version:comment.version,contextVersion:commentSource.contextVersion,sourceContextVersion:commentSource.contextVersion});
  f.service.bindSession({sessionId:'comment-human',runId:commentRun.id,role:'human',workspaceId:'ws',cwd:f.directory});
  const oldDraft=await f.service.submitFromSession({sessionId:'comment-human'},{kind:'draft',operationKey:'allowed-comment',body:'现有评论草稿'});
  const forbidden={...submission,operationKey:'private-replacement',replacesDraftId:oldDraft.draftId,bodyHash:oldDraft.draft.bodyHash};
  await assert.rejects(f.service.submitFromSession({sessionId:'ordinary',actualCwd:f.directory},forbidden),/不支持/);
  assert.throws(()=>f.store.submit(f.store.sessionBinding('human'),'replace',forbidden,prepared.contextVersion,new Date().toISOString()),/不支持/);
  assert.equal(f.store.draft(oldDraft.draftId).status,'pending-supervision');assert.equal(f.store.draft(oldDraft.draftId).body,'现有评论草稿');

});
