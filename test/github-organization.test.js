import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { resolveSettings, validateSettings } from '../src/config.js';

const row=(kind,id,state='open')=>({remoteId:`${kind}:${id}`,kind,title:`${kind} ${id}`,body:'body',payload:kind==='release'?{tag:`v${id}`}:{number:id,state,comments:[]}});
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'dmc-gh-')),store=await new Store(directory).start();
  let rows=[],service,result={summary:'分析结果',importance:1,urgent:false,intervention:'none'};const calls=[];
  const executor={analyze:async({item})=>{calls.push(item.id);return structuredClone(result);},conversation:async({runId})=>{const sessionId=`human-${runId}`;service.bindSession({sessionId,runId,role:'human',workspaceId:'ws',cwd:directory});return sessionId;}};
  const connector={status:()=>({ready:true,canPublish:false}),fetch:async()=>({complete:true,items:structuredClone(rows)})};
  service=new ConsoleService({store,connectors:{github:connector},executor,workspaces:{resolve:async id=>({id,path:directory})}});
  const source=await service.saveSource({workspaceId:'ws',platform:'github',name:'GitHub',target:'o/r',types:['issue','pr','release']});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  return {directory,store,service,source,calls,setResult(value){result={...result,...value};},setRows(value){rows=value;},items:()=>service.items(source.id,{pageSize:50,showClosed:true}).items};
}
test('closed and merged items remain visible and enter manual and scheduled organization',async t=>{
  const f=await fixture(t);const rows=[row('issue',1,'closed'),row('pr',2,'merged'),row('pr',3,'closed'),row('issue',4),row('release',5)];
  f.setRows(rows);await f.service.refresh(f.source.id);
  assert.equal(f.service.items(f.source.id).total,5);assert.equal(f.calls.length,0,'initial baseline stays read and unorganized');
  const manual=await f.service.organize(f.source.id,{scope:'history'});
  assert.equal(manual.completed,5);assert.equal(manual.excludedClosed,0);
  assert.equal((await f.service.organize(f.source.id,{scope:'history'})).completed,0,'unchanged items are not rerun');
  f.setRows(rows.map(item=>({...item,body:'new comment while closed'})));
  const refreshed=await f.service.refresh(f.source.id,{trigger:'scheduled'});
  assert.equal(refreshed.organization.completed,5);assert.equal(refreshed.organization.excludedClosed,0);
  assert.equal(f.service.items(f.source.id,{filter:'unread'}).total,5,'analysis does not mark read');
  for(const item of f.items())assert.equal(f.service.runs(item.id,{}).total,2);
});
test('legacy closed exclusions cannot disable organization and can be saved without reintroducing the setting',async t=>{
  const f=await fixture(t);
  await f.service.configure({includeClosed:false});
  const source=await f.service.saveSource({...f.service.source(f.source.id),settings:{includeClosed:false}},f.source.id);
  assert.equal(Object.hasOwn(resolveSettings(f.store.settings(),source),'includeClosed'),false);
  assert.deepEqual(validateSettings({includeClosed:false}),{});
  assert.throws(()=>validateSettings({includeClosed:'false'}),/无效/);
  f.setRows([row('issue',1,'closed'),row('pr',2,'merged')]);await f.service.refresh(f.source.id);
  assert.equal((await f.service.organize(f.source.id,{scope:'history'})).completed,2);
  f.setRows([row('issue',1,'open'),row('pr',2,'merged')]);assert.equal((await f.service.refresh(f.source.id)).organization.completed,1);
});
test('web Release and fallback PR retain item IDs, versions, feedback, drafts and sessions when switching to API',async t=>{
  const f=await fixture(t);
  const release={...row('release',1),remoteId:'release:web-v1'},pr={...row('pr',2),remoteId:'pr:web-2'},issue=row('issue',3);
  f.setRows([release,pr,issue]);await f.service.refresh(f.source.id,{organize:false});
  const id=`${f.source.id}:pr:web-2`,old=f.store.item(id),conversation=await f.service.openConversation(id);
  const receipt=await f.service.submitFromSession({sessionId:conversation.sessionId,callId:'draft'},{kind:'draft',operationKey:'draft',body:'历史草稿'});
  const feedback=await f.service.saveFeedback(id,{text:'保留这条评价',expectedRevision:0,itemVersion:old.version,analysisRevision:old.analysisRevision});
  const originalRuns=f.service.runs(id,{}).items;
  f.setRows([{...release,remoteId:'release:999',body:'API markdown',payload:{...release.payload,id:'999'}},{...pr,remoteId:'pr:22',body:'API markdown',payload:{...pr.payload,state:'merged',merged:true}},issue]);
  await f.service.refresh(f.source.id,{organize:false});
  const changed=f.store.item(id);assert.equal(f.items().length,3);assert.equal(changed.remoteId,'pr:web-2');assert.equal(changed.payload.state,'merged');assert.notEqual(changed.version,old.version);
  assert.equal(changed.readVersion,old.version);assert.equal(f.store.item(id,old.version).body,old.body);
  assert.equal(f.store.feedback(id).id,feedback.id);assert.equal(f.store.feedback(id).itemVersion,old.version);
  assert.equal(f.store.draft(receipt.draftId).body,'历史草稿');assert.equal(f.store.draft(receipt.draftId).status,'stale');
  assert.deepEqual(f.service.runs(id,{}).items.map(({submission,...run})=>run),originalRuns.map(({submission,...run})=>run));assert.equal(f.service.runs(id,{}).items[0].submission.draftStatus,'stale');assert.equal(f.store.sessionBinding(conversation.sessionId).itemId,id);
  assert.equal(f.service.runs(`${f.source.id}:issue:3`,{}).total,0);
  assert.equal(f.store.item(`${f.source.id}:release:web-v1`).remoteId,'release:web-v1');
  await f.service.refresh(f.source.id,{organize:false});assert.equal(f.items().length,3);assert.equal(f.store.item(id).version,changed.version);assert.equal(f.store.versions(id,{}).total,2);
  f.setRows([{...release,remoteId:'release:999',body:'API markdown',payload:{tag:'renamed-v1',id:'999'}}]);await f.service.refresh(f.source.id,{organize:false});
  assert.equal(f.items().length,3);assert.equal(f.store.item(`${f.source.id}:release:web-v1`).payload.tag,'renamed-v1');
});
test('cards and historical headers expose state even for API versions with old metadata',async t=>{
  const f=await fixture(t);f.setRows([row('pr',1,'merged')]);await f.service.refresh(f.source.id,{organize:false});
  const db=new DatabaseSync(join(f.directory,'console.sqlite'));db.exec("UPDATE item_versions SET metadata='{}'");db.close();
  assert.equal(f.items()[0].payload.state,'merged');assert.equal(f.store.header(f.items()[0].id).payload.state,'merged');
});

test('a closed GitHub result requiring no intervention clears old handling while retaining unread',async t=>{
  const f=await fixture(t);f.setRows([row('issue',1)]);await f.service.refresh(f.source.id);
  const id=`${f.source.id}:issue:1`;f.store.handling(id,'pending');
  f.setRows([row('issue',1,'closed')]);await f.service.refresh(f.source.id);
  assert.equal(f.store.item(id).handling,'none');assert.equal(f.service.items(f.source.id,{filter:'handling'}).total,0);
  assert.equal(f.service.items(f.source.id,{filter:'unread'}).total,1);
});

for (const kind of ['issue','pr']) test(`a ${kind} settles without intervention regardless of platform state and reopens for new problems`,async t=>{
  const f=await fixture(t);f.setRows([row(kind,1)]);await f.service.refresh(f.source.id);
  const id=`${f.source.id}:${kind}:1`;
  f.setResult({intervention:'review'});await f.service.organize(f.source.id,{scope:'history'});
  assert.equal(f.store.item(id).handling,'pending');
  f.setResult({intervention:'none',summary:'无需新增关注'});
  f.setRows([{...row(kind,1),body:'own fix comment'}]);await f.service.refresh(f.source.id);
  assert.equal(f.store.item(id).handling,'none');
  assert.equal(f.service.items(f.source.id,{filter:'handling'}).total,0);
  assert.equal(f.service.items(f.source.id,{filter:'unread'}).total,1);
  assert.equal(f.store.item(id).payload.state,'open');
  for (const intervention of ['human','review']) {
    f.setResult({intervention});f.setRows([{...row(kind,1),body:`new problem ${intervention}`}]);await f.service.refresh(f.source.id);
    assert.equal(f.store.item(id).handling,'pending');assert.equal(f.service.items(f.source.id,{filter:'handling'}).total,1);
    f.setResult({intervention:'none'});f.setRows([{...row(kind,1),body:`resolved ${intervention}`}]);await f.service.refresh(f.source.id);
    assert.equal(f.store.item(id).handling,'none');assert.equal(f.service.items(f.source.id,{filter:'handling'}).total,0);
  }
});

test('startup settles legacy GitHub no-action states once while preserving user choices, errors and stale analysis',async t=>{
  const f=await fixture(t);f.setRows(Array.from({length:7},(_,i)=>row('issue',i+1)));await f.service.refresh(f.source.id);
  await f.service.organize(f.source.id,{scope:'history'});
  const ids=Array.from({length:7},(_,i)=>`${f.source.id}:issue:${i+1}`),before=f.store.item(ids[0]);
  const conversation=await f.service.openConversation(ids[6]);
  const receipt=await f.service.submitFromSession({sessionId:conversation.sessionId},{kind:'draft',operationKey:'migration-draft',body:'核实发送结果'});
  f.store.updateDraft(receipt.draftId,{status:'unknown'});
  await f.store.close();
  const db=new DatabaseSync(join(f.directory,'console.sqlite'));
  db.prepare("DELETE FROM meta WHERE key='github-no-action-settled-v1'").run();
  db.exec("UPDATE items SET handling='pending',needs_handling=1;UPDATE sources SET handling=7");
  db.prepare("UPDATE items SET data=json_set(data,'$.handlingRevision',1) WHERE id=?").run(ids[1]);
  db.prepare("UPDATE items SET data=json_set(data,'$.organizationError',json_object('message','failed')) WHERE id=?").run(ids[2]);
  db.prepare("UPDATE items SET analyzed_version=NULL WHERE id=?").run(ids[3]);
  db.prepare("UPDATE runs SET data=json_set(data,'$.resultAdopted',0) WHERE item_id=?").run(ids[3]);
  db.prepare("UPDATE items SET handling='done',needs_handling=0 WHERE id=?").run(ids[4]);
  db.prepare("UPDATE items SET analysis=json_set(analysis,'$.intervention','human') WHERE id=?").run(ids[5]);
  db.exec('UPDATE sources SET handling=6');db.close();
  await f.store.start();
  const settled=f.store.item(ids[0]);assert.equal(settled.handling,'none');assert.equal(f.service.items(f.source.id,{filter:'handling'}).total,5);
  for(const key of ['analysis','analysisRevision','readVersion','version','attentionVersion','acknowledgedAttentionVersion','payload'])assert.deepEqual(settled[key],before[key],key);
  for(const id of [ids[1],ids[2],ids[3],ids[5],ids[6]])assert.equal(f.store.item(id).handling,'pending',id);
  assert.equal(f.store.item(ids[4]).handling,'done');assert.equal(f.store.draft(receipt.draftId).status,'unknown');
  f.store.handling(ids[0],'pending');await f.store.close();await f.store.start();
  assert.equal(f.store.item(ids[0]).handling,'pending','startup correction does not override later user choices');
});

test('GitHub no-action supersedes unsent drafts but retains sending and unknown reminders',async t=>{
  for(const status of ['pending-supervision','sending','unknown'])await t.test(status,async t=>{
    const f=await fixture(t);f.setRows([row('issue',1)]);await f.service.refresh(f.source.id);
    const id=`${f.source.id}:issue:1`,conversation=await f.service.openConversation(id);
    const receipt=await f.service.submitFromSession({sessionId:conversation.sessionId},{kind:'draft',operationKey:'draft',body:'保留的旧稿'});
    f.store.updateDraft(receipt.draftId,{status});const before=f.store.item(id);
    await f.service.organizeItem(id,{version:before.version});
    assert.equal(f.store.item(id).handling,'none');assert.equal(f.store.item(id).readVersion,before.readVersion);
    assert.equal(f.store.draft(receipt.draftId).body,'保留的旧稿');
    assert.equal(f.store.draft(receipt.draftId).status,status==='pending-supervision'?'superseded':status);
    assert.equal(f.service.items(f.source.id,{filter:'handling'}).total,status==='pending-supervision'?0:1);
  });
});
