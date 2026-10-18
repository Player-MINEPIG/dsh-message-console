import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { prepareSource } from '../src/source-context.js';

const analysis={summary:'已核对',importance:2,reason:'有问题',urgent:false,urgencyReason:null,intervention:'review',evidence:'confirmed'};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'dmc-storage-')),store=await new Store(directory).start();
  const service=new ConsoleService({store,connectors:{bilibili:{status:()=>({ready:true}),fetch:async()=>({complete:true,items:[]})}},executor:{},workspaces:{resolve:async id=>({id,path:directory}),list:async()=>[{id:'ws',path:directory,status:'ok'}]}});
  const source=await service.saveSource({workspaceId:'ws',name:'test',platform:'bilibili',target:'BV1111111111',types:['comment'],context:'shared',stageContexts:{generation:{context:'GEN_SECRET'},supervision:{context:'SUPER_SECRET'}}});
  const item={remoteId:'comment:1',kind:'comment',title:'评论测试',body:'根评论',payload:{comments:[{id:'100000000000000001',author:'测试',body:'完整楼中楼'.repeat(9000)}]}};
  store.applyFetch(source.id,[item],{},new Date().toISOString(),fingerprint);
  const id=`${source.id}:${item.remoteId}`;
  async function bind(role='writer',sessionId=role){const prepared=await prepareSource(service.source(source.id),{path:directory}),current=store.item(id);const run=store.createRun({id:`run-${sessionId}`,itemId:id,sourceId:source.id,workspaceId:'ws',version:current.version,contextVersion:prepared.contextVersion,sourceContextVersion:service.source(source.id).contextVersion,sourceSnapshot:prepared,baseAnalysisRevision:current.analysisRevision,status:role==='human'?'open':'running',startedAt:new Date().toISOString()});service.bindSession({sessionId,runId:run.id,role,workspaceId:'ws',cwd:directory});return run;}
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});return {directory,store,service,source,item,id,bind};
}

test('saved draft and analysis survive failed tail and restart, supervision remains independently required',async t=>{
  const f=await fixture(t),run=await f.bind();
  const receipt=await f.service.submitFromSession({sessionId:'writer',callId:'call-1'},{kind:'analysis',operationKey:'one',analysis,draftBody:'持久草稿'});
  assert.equal(receipt.draft.status,'pending-supervision');assert.equal(f.service.overview().sources[0].handling,1);
  f.store.updateRun(run.id,{status:'failed',error:'assistant tail transport failed'});
  await f.store.close();await f.store.start();assert.equal(f.store.draft(receipt.draftId).body,'持久草稿');assert.equal(f.store.draft(receipt.draftId).status,'pending-supervision');assert.equal(f.service.requireSubmission('writer').id,receipt.id);
  await assert.rejects(f.service.approveAndPublish(receipt.draftId,{version:run.version,bodyHash:receipt.draft.bodyHash}),/监督/);
  f.service.bindSession({sessionId:'supervisor',runId:run.id,role:'supervisor',workspaceId:'ws',cwd:f.directory,draftId:receipt.draftId});
  await f.service.submitFromSession({sessionId:'supervisor',callId:'check'},{kind:'supervision',operationKey:'check',approved:false,reason:'资料不足'});
  assert.equal(f.store.draft(receipt.draftId).status,'blocked');
});

test('logical retries return exact receipt despite later missing source material and conflicting retries fail',async t=>{
  const f=await fixture(t);await f.bind();const submission={kind:'analysis',operationKey:'same',analysis,draftBody:'one'};
  const receipts=await Promise.all(Array.from({length:8},()=>f.service.submitFromSession({sessionId:'writer',callId:'retry'},submission)));
  assert.equal(new Set(receipts.map(r=>r.id)).size,1);assert.equal(f.service.drafts(f.id,{}).total,1);
  await f.service.saveSource({...f.service.source(f.source.id),materials:[{kind:'text',name:'new',text:'changed'}]},f.source.id);
  f.service.workspaces.resolve=async()=>{throw new Error('workspace unavailable');};
  assert.equal((await f.service.submitFromSession({sessionId:'writer',callId:'again'},{analysis,draftBody:'one',operationKey:'same',kind:'analysis'})).id,receipts[0].id);
  await assert.rejects(f.service.submitFromSession({sessionId:'writer',callId:'conflict'},{...submission,draftBody:'different'}),/操作键/);
});

test('simultaneous fresh analyses preserve independent results and reject competing adoption',async t=>{
  const f=await fixture(t);await f.bind('writer','a');await f.bind('writer','b');
  const [a,b]=await Promise.all(['a','b'].map(sessionId=>f.service.submitFromSession({sessionId,callId:sessionId},{kind:'analysis',operationKey:'save',analysis:{...analysis,summary:sessionId},draftBody:sessionId})));
  assert.deepEqual([a.adopted,b.adopted],[true,false]);assert.equal(f.store.item(f.id).analysis.summary,'a');assert.equal(f.store.draft(b.draftId).status,'stale');assert.equal(f.service.runs(f.id,{}).total,2);
});

test('human binding survives reopen, reads source IDs and saves only its original item, immutable replacement uses body CAS',async t=>{
  const f=await fixture(t);await f.bind('human');const other={...f.item,remoteId:'comment:2',title:'其他评论'};f.store.applyFetch(f.source.id,[f.item,other],{},new Date().toISOString(),fingerprint);
  await f.store.close();await f.store.start();assert.ok(f.service.sessionBinding('human',f.directory));assert.equal(f.service.sessionBinding('human','/elsewhere'),null);
  const list=await f.service.readFromSession({sessionId:'human'},{section:'items',q:'其他'});assert.equal(list.items[0].remoteId,'comment:2');
  const first=await f.service.submitFromSession({sessionId:'human',callId:'one'},{kind:'draft',operationKey:'one',body:'旧稿'});
  const next=await f.service.submitFromSession({sessionId:'human',callId:'two'},{kind:'draft',operationKey:'two',body:'新稿',replacesDraftId:first.draftId,bodyHash:first.draft.bodyHash});
  assert.notEqual(first.draftId,next.draftId);assert.equal(f.store.draft(first.draftId).body,'旧稿');assert.equal(f.store.draft(first.draftId).status,'superseded');assert.equal(f.store.draft(next.draftId).itemId,f.id);
  await assert.rejects(f.service.submitFromSession({sessionId:'human',callId:'bad'},{kind:'draft',operationKey:'bad',body:'wrong',replacesDraftId:next.draftId,bodyHash:'wrong'}),/旧草稿/);
  await assert.rejects(f.service.submitFromSession({sessionId:'human',callId:'super'},{kind:'supervision',operationKey:'super',approved:true,reason:'no'}),/无权/);
});

test('tool read/write scope and current permission guard protect source boundary and stage materials',async t=>{
  const f=await fixture(t);await f.bind();
  const source2=await f.service.saveSource({...f.service.source(f.source.id),name:'other'},undefined);f.store.applyFetch(source2.id,[f.item],{},new Date().toISOString(),fingerprint);
  await assert.rejects(f.service.readFromSession({sessionId:'writer'},{itemId:`${source2.id}:${f.item.remoteId}`}),/来源/);
  const context=await f.service.readFromSession({sessionId:'writer'},{section:'context'});assert.match(JSON.stringify(context),/GEN_SECRET/);assert.doesNotMatch(JSON.stringify(context),/SUPER_SECRET/);
  await assert.rejects(f.service.submitFromSession({sessionId:'writer',callId:'deny',assertWritable:()=>{throw new Error('read-only');}},{kind:'analysis',operationKey:'deny',analysis,draftBody:'never'}),/read-only/);
  assert.equal(f.service.drafts(f.id,{}).total,0);assert.throws(()=>f.service.requireSubmission('writer'),/提交结果/);
});

test('content and background changes preserve stale draft evidence and cannot grant supervision approval',async t=>{
  const f=await fixture(t),run=await f.bind();
  const result=await f.service.submitFromSession({sessionId:'writer',callId:'write'},{kind:'analysis',operationKey:'write',analysis,draftBody:'reply'});
  f.service.bindSession({sessionId:'supervisor',runId:run.id,role:'supervisor',workspaceId:'ws',cwd:f.directory,draftId:result.draftId});
  await f.service.saveSource({...f.service.source(f.source.id),context:'changed'},f.source.id);
  assert.equal(f.store.draft(result.draftId).status,'stale');await assert.rejects(f.service.submitFromSession({sessionId:'supervisor',callId:'late'},{kind:'supervision',operationKey:'late',approved:true,reason:'old inputs'}),/草稿已变化/);
});

test('content/comment chunks read the exact stored text and versions retain complete old payloads',async t=>{
  const f=await fixture(t),first=f.service.item(f.id),commentId=f.item.payload.comments[0].id;
  let text='',offset=0;do{const chunk=f.service.content(f.id,{version:first.version,section:'comment',commentId,offset,length:16000});text+=chunk.text;offset=chunk.nextOffset;}while(offset!==null);
  assert.equal(text,f.item.payload.comments[0].body);assert.equal(f.service.comments(f.id,first.version,{}).items[0].excerpt.length,600);
  f.store.applyFetch(f.source.id,[{...f.item,body:'新正文',payload:{comments:[{id:'new',body:'NEW',author:'n'}]}}],{},new Date().toISOString(),fingerprint);
  assert.equal(f.service.comments(f.id,first.version,{}).items[0].id,commentId);assert.equal(f.service.versions(f.id,{}).total,2);assert.equal(f.service.content(f.id,{version:first.version}).text,'根评论');
  assert.equal('body' in f.service.item(f.id),false);assert.equal('comments' in f.service.item(f.id).payload,false);
});

test('legacy import is lossless for stored entities, partial previous is honest, and recovery is idempotent',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dmc-migrate-'));let store;
  t.after(async()=>{await store?.close();await rm(directory,{recursive:true,force:true});});
  const source={id:'s',name:'legacy',platform:'bilibili',target:'BV1111111111',types:['comment'],workspaceId:'ws',contextVersion:'ctx',initialized:true,settings:{},custom:'keep'},item={id:'s:c',sourceId:'s',remoteId:'c',kind:'comment',title:'new',body:'full',payload:{comments:[{id:'r',author:'u',body:'reply'}]},version:'v2',readVersion:'v1',analyzedVersion:'v2',analysis:{...analysis},handling:'none',changedAt:'2026',sessions:[{sessionId:'real-old',role:'human',workspaceId:'old-ws'}],previous:{title:'before',body:'old',version:'v1'},customItem:'keep'};
  const legacy={version:1,settings:{language:'test'},sources:{s:source},items:{'s:c':item},drafts:{d:{id:'d',itemId:item.id,sourceId:'s',runId:'r',body:'saved',version:'v2',contextVersion:'ctx',status:'sending',receipt:{remoteId:'unchanged'},createdAt:'2026'}},runs:{r:{id:'r',itemId:item.id,version:'v2',status:'running',startedAt:'2026',decision:{input:{state:'PRIVATE_EXACT'},output:{probabilities:{draft:1}}},sessions:[{sessionId:'real-old',role:'human',workspaceId:'old-ws'}]}},audit:[{id:'a',at:'2026',event:'source.saved',extra:'keep'}],unknownRoot:{keep:true}};
  const raw=JSON.stringify(legacy);await writeFile(join(directory,'state.json'),raw);store=await new Store(directory).start();
  assert.equal(await readFile(join(directory,'state.pre-sqlite.json'),'utf8'),raw);assert.deepEqual(store.source('s'),source);assert.equal(store.overviewSources()[0].total,1);assert.equal(store.item(item.id).customItem,'keep');assert.deepEqual(store.item(item.id).payload,item.payload);assert.equal(store.header(item.id,'v1').complete,false);assert.equal(store.content(item.id,{version:'v1'}).text,'old');assert.deepEqual(store.decision('r'),legacy.runs.r.decision);assert.equal(store.draft('d').status,'unknown');assert.equal(store.run('r').status,'interrupted');assert.equal(store.sessionBinding('real-old').legacy,true);
  const db=new DatabaseSync(join(directory,'console.sqlite'),{readOnly:true});assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='legacyExtras'").get().value),{unknownRoot:{keep:true}});assert.equal(JSON.parse(db.prepare('SELECT data FROM audit WHERE id=?').get('a').data).extra,'keep');db.close();
  await store.close();await writeFile(join(directory,'state.json'),'invalid after migration');await store.start();assert.equal(store.items('s',{}).total,1);assert.equal(store.draft('d').body,'saved');assert.equal((await stat(join(directory,'console.sqlite'))).mode&0o777,0o600);
});

test('failed legacy transaction retries cleanly and unknown SQLite schema is refused unchanged',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dmc-retry-'));let store=new Store(directory);t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const broken={version:1,settings:{},sources:{},items:{x:{id:'x',sourceId:'missing',remoteId:'x',kind:'comment',version:'v',title:'x',body:'x'}},drafts:{},runs:{},audit:[]};await writeFile(join(directory,'state.json'),JSON.stringify(broken));await assert.rejects(store.start(),/FOREIGN KEY/);
  broken.sources.missing={id:'missing',platform:'bilibili',name:'ok'};await writeFile(join(directory,'state.json'),JSON.stringify(broken));await store.start();assert.equal(store.items('missing',{}).total,1);await store.close();const db=new DatabaseSync(join(directory,'console.sqlite'));db.exec('PRAGMA user_version=99');db.close();await assert.rejects(store.start(),/数据库版本/);const check=new DatabaseSync(join(directory,'console.sqlite'));assert.equal(check.prepare('PRAGMA user_version').get().user_version,99);check.close();
});

test('directory always returns bounded pages even after legacy sessions share one startup',async t=>{
  const f=await fixture(t),run=await f.bind('human','first');for(let i=0;i<237;i++)f.service.bindSession({sessionId:`human-${i}`,runId:run.id,role:'human',workspaceId:'ws',cwd:f.directory});
  let after=0,seen=new Set(),page;do{page=f.service.sessionDirectory({after,limit:100});assert.ok(page.changes.length<=100);for(const change of page.changes)seen.add(change.sessionId);after=page.next;}while(page.hasMore);assert.equal(seen.size,238);
});

test('SQL pagination, exact short searches and single-row updates stay bounded on synthetic records',async t=>{
  const f=await fixture(t),count=Number(process.env.DMC_SCALE_ITEMS??1000),entries=Array.from({length:count},(_,i)=>({remoteId:`bulk:${i}`,kind:'comment',title:`row ${i}`,body:i===count-1?'两字中文 % _ Marker':'plain',payload:{comments:[],contextComplete:true}}));
  f.store.applyFetch(f.source.id,entries,{},new Date().toISOString(),fingerprint);
  const overview=f.service.overview();assert.equal(overview.sources[0].total,count+1);assert.ok(JSON.stringify(overview).length<12000);
  const last=f.service.items(f.source.id,{page:1000000,pageSize:50});assert.equal(last.page,last.pageCount);assert.ok(last.items.length<=50);assert.ok(JSON.stringify(last).length<70000);assert.ok(last.items.every(item=>!('body'in item)&&!('comments'in item.payload)));
  for(const q of ['两字','中文','%','_','marker']){const page=f.service.items(f.source.id,{q});assert.equal(page.total,1);assert.equal(page.items[0].remoteId,`bulk:${count-1}`);}
  const sql=[],original=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(query){sql.push(query);return original.call(this,query);};try{await f.service.markRead(last.items[0].id,last.items[0].version);}finally{DatabaseSync.prototype.prepare=original;}
  assert.ok(sql.length<20);assert.ok(sql.every(query=>!/item_versions|comments|SELECT \* FROM items(?! WHERE id=)/.test(query)),sql.join('\n'));
  const db=new DatabaseSync(join(f.directory,'console.sqlite'),{readOnly:true});const plan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM items WHERE source_id=? ORDER BY priority DESC,changed_at DESC,id LIMIT 50').all(f.source.id);assert.ok(plan.some(row=>row.detail.includes('item_order')));db.close();
});

test('Unicode literal search retains JavaScript case folding',async t=>{
  const f=await fixture(t);f.store.applyFetch(f.source.id,[{...f.item,remoteId:'unicode',title:'ÄBC ΔΕΛΤΑ ÉCLAIR',body:'CAFÉ'}],{},new Date().toISOString(),fingerprint);
  for(const q of ['äbc','δελτα','éclair','café']){const page=f.service.items(f.source.id,{q});assert.equal(page.total,1);assert.equal(page.items[0].remoteId,'unicode');}
});

test('human replay freezes observed previous text and time across new versions and repeated content hashes',async t=>{
  const f=await fixture(t);f.service.executor.conversation=async({runId})=>{const sessionId=`human-${runId}`;f.service.bindSession({sessionId,runId,role:'human',workspaceId:'ws',cwd:f.directory});return sessionId;};
  const original={...f.item,body:'A'};f.store.applyFetch(f.source.id,[original],{},'2026-01-01',fingerprint);
  const a=f.store.item(f.id);f.store.applyFetch(f.source.id,[{...original,body:'B'}],{},'2026-02-01',fingerprint);
  const {sessionId}=await f.service.openConversation(f.id),before=f.service.sessionBackground(sessionId);
  for(const row of f.service.runs(f.id,{}).items){assert.equal('inputSnapshot'in row,false);assert.equal('settingsSnapshot'in row,false);}
  const content=before.input.blocks.find(b=>b.key==='content').value;assert.equal(content.previous.body,'A');assert.equal(content.changedAt,'2026-02-01');
  f.store.applyFetch(f.source.id,[{...original,body:'C'}],{},'2026-03-01',fingerprint);await f.store.close();await f.store.start();assert.deepEqual(f.service.sessionBackground(sessionId),before);
  const oldB=f.store.item(f.id,content.version);assert.equal(oldB.previous.body,'A');assert.equal(oldB.changedAt,'2026-02-01');
  f.store.applyFetch(f.source.id,[original],{},'2026-04-01',fingerprint);assert.equal(f.store.item(f.id).version,a.version);assert.equal(f.store.item(f.id).previous.body,'C');
  const next=await f.service.openConversation(f.id),again=f.service.sessionBackground(next.sessionId).input.blocks.find(b=>b.key==='content').value;assert.equal(again.previous.body,'C');assert.equal(again.changedAt,'2026-04-01');
  let observed;f.service.executor.analyze=async({item})=>{observed=item;return {...analysis,processing:'decision-only'};};await f.service.organize(f.source.id);assert.equal(observed.previous.body,'C');assert.equal(observed.changedAt,'2026-04-01');
});

test('large diff and video context return only requested code point chunks and lightweight headers',async t=>{
  const registered=[],udfArguments=[],register=DatabaseSync.prototype.function;
  DatabaseSync.prototype.function=function(name,options,execute){registered.push(name);return register.call(this,name,options,(...args)=>{udfArguments.push({name,length:Math.max(0,...args.filter(value=>typeof value==='string').map(value=>value.length))});return execute(...args);});};
  let f;try{f=await fixture(t);}finally{DatabaseSync.prototype.function=register;}
  assert.deepEqual(registered,['dmc_lower']);
  const description='😀完整简介'.repeat(6000),diff='x'.repeat(1900000)+'😀end';
  f.store.applyFetch(f.source.id,[{...f.item,payload:{comments:[],diff,video:{title:'真实视频标题',owner:'作者',description}}}],{},'2026-05-01',fingerprint);
  const header=f.service.item(f.id);assert.deepEqual(header.payload.video,{title:'真实视频标题',owner:'作者',descriptionLength:Array.from(description).length});assert.equal(header.diffLength,Array.from(diff).length);assert.ok(JSON.stringify(header).length<3000);
  const sql=[],original=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(query){sql.push(query);return original.call(this,query);};try{assert.equal(f.service.content(f.id,{section:'body',offset:0,length:1}).text,'根');const chunk=f.service.content(f.id,{section:'diff',offset:1899999,length:4});assert.equal(chunk.text,Array.from(diff).slice(1899999,1900003).join(''));assert.equal(chunk.total,Array.from(diff).length);assert.equal(chunk.nextOffset,1900003);assert.ok(Array.from(chunk.text).length<=4);}finally{DatabaseSync.prototype.prepare=original;}
  const bodySql=sql.find(query=>query.includes('substr(body'));assert.ok(bodySql&&!bodySql.includes('payload'));assert.ok(sql.some(query=>query.includes("substr(json_extract(payload,'$.diff')")));
  let offset=0,text='';do{const chunk=f.service.content(f.id,{version:header.version,section:'video-description',offset,length:15999});text+=chunk.text;assert.equal(chunk.total,Array.from(description).length);if(chunk.nextOffset!==null)assert.equal(chunk.nextOffset,Array.from(text).length);offset=chunk.nextOffset;}while(offset!==null);assert.equal(text,description);
  f.store.applyFetch(f.source.id,[{...f.item,payload:{comments:[],video:{title:'新标题',description:'新简介'}}}],{},'2026-06-01',fingerprint);assert.equal(f.service.item(f.id,header.version).payload.video.title,'真实视频标题');assert.equal(f.service.content(f.id,{version:header.version,section:'video-description'}).text,Array.from(description).slice(0,16000).join(''));
  assert.deepEqual(udfArguments,[],'content/header/chunk reads must not send any text through a JavaScript SQLite callback');
  const db=new DatabaseSync(join(f.directory,'console.sqlite'),{readOnly:true}),extras=JSON.parse(db.prepare('SELECT data FROM item_versions WHERE item_id=? AND version=?').get(f.id,header.version).data);for(const key of ['body','payload','title','url','id','version'])assert.equal(key in extras,false);db.close();
});

test('SQLite version two metadata upgrade commits once and preserves snapshot queries',async t=>{
  const f=await fixture(t);await f.store.close();const db=new DatabaseSync(join(f.directory,'console.sqlite'));db.exec('ALTER TABLE item_versions DROP COLUMN metadata; PRAGMA user_version=2');db.close();await f.store.start();assert.equal(f.service.item(f.id).commentsCount,1);assert.equal(f.service.content(f.id,{section:'body'}).text,'根评论');await f.store.close();await f.store.start();assert.equal(f.service.items(f.source.id,{}).total,1);
});

test('metadata from the unpublished UTF16 schema upgrades to code point lengths',async t=>{
  const f=await fixture(t),description='a😀b😀c',diff='😀patch';
  f.store.applyFetch(f.source.id,[{...f.item,payload:{comments:[],diff,video:{title:'video',description}}}],{},'2026-07-01',fingerprint);
  await f.store.close();const db=new DatabaseSync(join(f.directory,'console.sqlite'));
  db.prepare("UPDATE item_versions SET metadata=json_set(metadata,'$.diffLength',?,'$.video.descriptionLength',?) WHERE item_id=?").run(diff.length,description.length,f.id);db.exec('PRAGMA user_version=3');db.close();
  await f.store.start();const header=f.service.item(f.id);assert.equal(header.diffLength,Array.from(diff).length);assert.equal(header.payload.video.descriptionLength,Array.from(description).length);
  const chunk=f.service.content(f.id,{section:'video-description',offset:1,length:2});assert.deepEqual({text:chunk.text,total:chunk.total,nextOffset:chunk.nextOffset},{text:'😀b',total:5,nextOffset:3});
});


test('ordinary workspace draft receipts bind explicit item versions and roll back invalid multi-item replacements',async t=>{
  const f=await fixture(t),actor={sessionId:'ordinary',actualCwd:f.directory,callId:'save'};
  f.store.applyFetch(f.source.id,[f.item,{...f.item,remoteId:'other'}],{},'2026-01-01',fingerprint);
  const item=await f.service.readFromSession(actor,{section:'item',itemId:f.id});
  const input={kind:'draft',operationKey:'first',itemId:f.id,version:item.version,contextVersion:item.contextVersion,body:'ordinary draft'};
  const saved=await f.service.submitFromSession(actor,input);
  assert.equal(f.store.sessionBinding('ordinary'),null);
  const other=`${f.source.id}:other`,before=f.service.runs(other).total;
  await assert.rejects(f.service.submitFromSession(actor,{...input,itemId:other,operationKey:'replace',replacesDraftId:saved.draftId,bodyHash:saved.draft.bodyHash}),/旧草稿/);
  assert.equal(f.service.runs(other).total,before);assert.equal(f.store.replaySubmission('ordinary',{...input,operationKey:'replace'}),null);
  const next={...input,itemId:other,operationKey:'other'};
  await Promise.all(Array.from({length:8},()=>f.service.submitFromSession(actor,next)));
  assert.equal(f.service.runs(other).total,1);assert.equal(f.service.drafts(other).total,1);
  await assert.rejects(f.service.submitFromSession(actor,{...next,operationKey:'first'}),/操作键/);
  await f.store.close();await f.store.start();
  assert.equal((await f.service.submitFromSession(actor,input)).id,saved.id);
  assert.equal(f.service.runs(f.id).items[0].sessions[0].sessionId,'ordinary');
  await assert.rejects(f.service.submitFromSession(actor,{...input,kind:'supervision'}),/仅可保存草稿/);
  await assert.rejects(f.service.readFromSession({...actor,actualCwd:'/unregistered'},{section:'body',itemId:f.id}),/当前已有工作区/);
  await assert.rejects(f.service.submitFromSession({...actor,actualCwd:'/unregistered'},input),/当前已有工作区/);
});

test('ordinary workspace calls reject source rebinding during scope resolution and old observed versions',async t=>{
  const f=await fixture(t),actor={sessionId:'ordinary',actualCwd:f.directory,callId:'save'};
  const observed=await f.service.readFromSession(actor,{section:'item',itemId:f.id});
  const input={kind:'draft',operationKey:'race',itemId:f.id,version:observed.version,contextVersion:observed.contextVersion,body:'old draft'};
  const original=f.service.workspaces.resolve;
  f.service.workspaces.resolve=async id=>{f.store.updateSource(f.source.id,{workspaceId:'moved'});return original(id);};
  await assert.rejects(f.service.readFromSession(actor,{section:'body',itemId:f.id}),/已变化/);
  assert.equal(f.service.drafts(f.id).total,0);
  f.store.updateSource(f.source.id,{workspaceId:'ws'});
  await assert.rejects(f.service.submitFromSession(actor,input),/已变化/);
  assert.equal(f.service.runs(f.id).total,0);
  f.store.updateSource(f.source.id,{workspaceId:'ws'});
  f.service.workspaces.resolve=async id=>{f.store.applyFetch(f.source.id,[{...f.item,body:'new current body'}],{},'2026-02-01',fingerprint);return original(id);};
  await assert.rejects(f.service.submitFromSession(actor,input),/已变化/);
  assert.equal(f.service.runs(f.id).total,0);assert.equal(f.service.drafts(f.id).total,0);assert.equal(f.store.receipt('ordinary'),null);
});

test('managed sessions never fall back to workspace drafting when actual cwd differs',async t=>{
  const f=await fixture(t);await f.bind('writer','managed');
  const actor={sessionId:'managed',actualCwd:'/elsewhere',callId:'save'};
  await assert.rejects(f.service.readFromSession(actor,{section:'sources'}),/受管会话绑定/);
  await assert.rejects(f.service.submitFromSession(actor,{kind:'draft',operationKey:'escape',itemId:f.id,body:'no'}),/受管会话绑定/);
  assert.equal(f.service.drafts(f.id).total,0);
});
