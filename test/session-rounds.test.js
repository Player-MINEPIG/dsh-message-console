import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {ConsoleService,fingerprint} from '../src/core.js';
import {prepareSource} from '../src/source-context.js';
import {sessionFailure} from '../src/dsh.js';
const analysis={summary:'阶段事实',importance:2,urgent:false,urgencyReason:null,reason:'合成证据',intervention:'none',evidence:'confirmed'};
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'dmc-rounds-')),store=await new Store(directory).start();
 const service=new ConsoleService({store,executor:{},connectors:{},workspaces:{resolve:async id=>({id,path:directory})}});
 const source=await service.saveSource({workspaceId:'ws',name:'合成',platform:'github',target:'example/repo',types:['issue']});
 const raw={remoteId:'issue:1',kind:'issue',title:'合成问题',body:'第一轮',payload:{}};
 store.applyFetch(source.id,[raw],{},new Date().toISOString(),fingerprint);const id=`${source.id}:issue:1`;
 let n=0;
 async function run(sessionId='original',reuse=false) {const prepared=await prepareSource(service.source(source.id),{path:directory}),item=store.item(id);const r=store.createRun({id:`round-${++n}`,itemId:id,sourceId:source.id,workspaceId:'ws',version:item.version,contextVersion:prepared.contextVersion,sourceContextVersion:service.source(source.id).contextVersion,sourceSnapshot:prepared,baseAnalysisRevision:item.analysisRevision,status:'running',startedAt:new Date().toISOString()});service.bindSession({sessionId,runId:r.id,role:'investigate',workspaceId:'ws',cwd:directory},{reuse});return r;}
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
 return {directory,store,service,source,id,raw,run};
}
test('reused session preserves run history, first receipts and independent operation keys across changed content',async t=>{
 const f=await fixture(t),one=await f.run(),actor={sessionId:'original',actualCwd:f.directory,runId:one.id};
 const receipt=await f.service.submitFromSession(actor,{kind:'analysis',operationKey:'save',analysis});
 const legacyDb=new DatabaseSync(join(f.directory,'console.sqlite'));legacyDb.prepare('UPDATE receipts SET operation_key=? WHERE id=?').run('save',receipt.id);legacyDb.close();assert.equal((await f.service.submitFromSession(actor,{kind:'analysis',operationKey:'save',analysis})).id,receipt.id);
 f.store.updateRun(one.id,{status:'completed',finishedAt:new Date().toISOString()});const old=f.store.run(one.id);
 f.store.applyFetch(f.source.id,[{...f.raw,body:'第二轮新内容'}],{},new Date().toISOString(),fingerprint);
 const two=await f.run('original',true);assert.notEqual(one.version,two.version);
 assert.throws(()=>f.service.requireSubmission('original',two.id),/持久|提交/);
 await assert.rejects(f.service.submitFromSession(actor,{kind:'analysis',operationKey:'save',analysis}),/轮次|变化|绑定/);
 const second=await f.service.submitFromSession({...actor,runId:two.id},{kind:'analysis',operationKey:'save',analysis:{...analysis,summary:'第二轮事实'}});
 assert.notEqual(second.id,receipt.id);assert.equal(second.runId,two.id);assert.equal(second.adopted,true);
 assert.deepEqual(f.store.run(one.id),old);assert.deepEqual(f.store.receipt('original',one.id),receipt);
 assert.equal(f.store.run(two.id).sessions[0].sessionId,'original');assert.equal(f.service.analysisSessions(two.id,'investigate')[0].sessionId,'original');
 await f.store.close();await f.store.start();assert.deepEqual(f.store.run(one.id),old);assert.equal(f.store.receipt('original',two.id).id,second.id);
});
test('tool call captured before asynchronous source preparation cannot commit into another round',async t=>{
 const f=await fixture(t),one=await f.run();let release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 f.service.workspaces.resolve=async()=>{entered();await gate;return {path:f.directory};};
 const pending=f.service.submitFromSession({sessionId:'original',runId:one.id,actualCwd:f.directory},{kind:'analysis',operationKey:'held',analysis});
 await ready;const two=await f.run('original',true);release();await assert.rejects(pending,/轮次|变化|绑定/);assert.equal(f.store.receipt('original',two.id),null);assert.equal(f.store.item(f.id).analysisRevision,0);
});
test('late saved result is separate from immutable timeout and supervisor receipt never replaces analysis result',async t=>{
 const f=await fixture(t),run=await f.run();const failure={code:'TIMEOUT',cancellationSource:'timeout',timeoutMs:300000,sessionId:'original'};
 f.store.updateRun(run.id,{status:'failed',finishedAt:'2026-01-01T00:05:00.000Z',error:'阶段超时',failure});const old=f.store.run(run.id);
 const saved=await f.service.submitFromSession({sessionId:'original',runId:run.id,actualCwd:f.directory},{kind:'analysis',operationKey:'late',analysis,draftBody:'合成草稿'});
 f.service.bindSession({sessionId:'supervisor',runId:run.id,role:'supervisor',workspaceId:'ws',cwd:f.directory,draftId:saved.draftId});
 await f.service.submitFromSession({sessionId:'supervisor',actualCwd:f.directory},{kind:'supervision',operationKey:'check',approved:true,reason:'核实通过'});
 const record=f.service.runs(f.id,{}).items.find(row=>row.id===run.id);assert.equal(record.status,'failed');assert.deepEqual(record.failure,failure);assert.equal(record.finishedAt,old.finishedAt);assert.equal(record.submission.id,saved.id);assert.equal(record.submission.adopted,true);assert.ok(record.submission.at>record.finishedAt);assert.equal(record.submission.draftStatus,'ready');assert.equal(f.store.run(run.id).error,old.error);
});
test('schema five migration preserves all old rows and legacy run links',async t=>{
 const f=await fixture(t),run=await f.run();f.store.updateRun(run.id,{status:'completed',finishedAt:new Date().toISOString()});await f.store.close();let db=new DatabaseSync(join(f.directory,'console.sqlite'));
 const binding=JSON.parse(db.prepare('SELECT data FROM sessions').get().data);binding.legacy=true;
 db.prepare('UPDATE sessions SET data=?').run(JSON.stringify(binding));db.exec('DROP TABLE run_sessions;PRAGMA user_version=5');
 const tables=['runs','sessions','receipts','audit','sources','items'];const before=Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));db.close();
 await f.store.start();assert.equal(f.store.run(run.id).sessions[0].sessionId,'original');assert.equal(f.store.run(run.id).sessions[0].legacy,true);assert.equal(f.service.analysisSessions(run.id,'investigate').length,0);await f.store.close();
 db=new DatabaseSync(join(f.directory,'console.sqlite'));for(const name of tables)assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(),before[name],name);assert.equal(db.prepare('SELECT count(*) n FROM run_sessions').get().n,1);db.close();await f.store.start();
});
test('cancellation attribution preserves timeout, explicit signal and unknown hook reasons',()=>{
 const abort=reason=>({kind:'aborted',reason});
 assert.equal(sessionFailure(abort({kind:'hook',reason:'message-console timeout after 300000ms'}),'s',{timeoutMs:300000}).sessionFailure.code,'TIMEOUT');
 for(const [cause,expected] of [[{kind:'hook',reason:'message-console signal cancelled'},'signal'],[{kind:'hook',reason:'message-console owner disposed'},'owner'],[{kind:'hook',reason:'other-policy'},'hook'],[{kind:'user'},'user'],[{kind:'disposed'},'disposed']])assert.equal(sessionFailure(abort(cause),'s').sessionFailure.cancellationSource,expected);
});

test('legacy revision replay belongs only to its origin run even when the same session advances',async t=>{
 const f=await fixture(t),one=await f.run(),actor={sessionId:'original',actualCwd:f.directory};await f.service.submitFromSession(actor,{kind:'analysis',operationKey:'initial',analysis});
 const read=await f.service.readFromSession(actor,{section:'analysis'}),input={operationKey:'revise',version:read.version,contextVersion:read.contextVersion,expectedAnalysisRevision:read.analysisRevision,analysis:{...analysis,summary:'修订事实'},reason:'合成报告'};
 const revision=await f.service.reviseAnalysisFromSession(actor,input),db=new DatabaseSync(join(f.directory,'console.sqlite'));db.prepare('UPDATE receipts SET operation_key=? WHERE id=?').run('revise',revision.id);db.close();assert.equal((await f.service.reviseAnalysisFromSession(actor,input)).id,revision.id);
 const two=await f.run('original',true);await f.service.submitFromSession(actor,{kind:'analysis',operationKey:'initial',analysis});await assert.rejects(f.service.reviseAnalysisFromSession(actor,input),/分析已变化|重新读取/);assert.equal(f.store.item(f.id).analysisRevision,3);assert.notEqual(one.id,two.id);
});
